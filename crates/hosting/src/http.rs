//! Requests to a service's web API, in JSON, with its token. Errors are sorted into what the user can
//! act on: a refused token, a missing right, a service out of reach…

use std::time::Duration;

use base64::Engine;
use serde::de::DeserializeOwned;

use crate::HostingError;

/// How a request proves who sends it.
#[derive(Clone)]
pub enum Auth {
    Bearer(String),
    /// User name (or e-mail address) and token, as Bitbucket Cloud asks.
    Basic(String, String),
}

impl Auth {
    fn header(&self) -> String {
        match self {
            Self::Bearer(token) => format!("Bearer {token}"),
            Self::Basic(user, token) => {
                format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{token}")))
            }
        }
    }
}

pub struct Client {
    agent: ureq::Agent,
    /// Root of the API, without a trailing slash (« https://api.github.com »).
    base: String,
    auth: Auth,
}

/// An answer: its body, and the headers that some services use to tell more (user name, next page).
pub struct Answer {
    pub body: String,
    headers: Vec<(String, String)>,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn json<T: DeserializeOwned>(&self) -> Result<T, HostingError> {
        serde_json::from_str(&self.body).map_err(|e| HostingError::Format(e.to_string()))
    }
}

impl Client {
    pub fn new(base: &str, auth: Auth) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("Ramelo/", env!("CARGO_PKG_VERSION")))
            .try_proxy_from_env(use_proxy(base, std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).ok().as_deref()))
            .build();
        Self { agent, base: base.trim_end_matches('/').to_owned(), auth }
    }

    /// `path` is relative to the root of the API (« /user »), or a full address (a next page).
    fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_owned()
        } else {
            format!("{}{path}", self.base)
        }
    }

    fn send(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<Answer, HostingError> {
        let url = self.url(path);
        let request = self
            .agent
            .request(method, &url)
            .set("Authorization", &self.auth.header())
            .set("Accept", "application/json");
        let result = match body {
            Some(body) => request.send_json(body),
            None => request.call(),
        };
        match result {
            Ok(response) => {
                let headers = response.headers_names().into_iter().filter_map(|n| response.header(&n).map(|v| (n.clone(), v.to_owned()))).collect();
                let body = response.into_string().map_err(|e| HostingError::Network(e.to_string()))?;
                Ok(Answer { body, headers })
            }
            Err(ureq::Error::Status(status, response)) => {
                let limited = response.header("x-ratelimit-remaining") == Some("0") || response.header("retry-after").is_some();
                let body = response.into_string().unwrap_or_default();
                Err(status_error(status, &body, &url, limited))
            }
            Err(ureq::Error::Transport(transport)) => Err(HostingError::Network(transport.to_string())),
        }
    }

    pub fn get(&self, path: &str) -> Result<Answer, HostingError> {
        self.send("GET", path, None)
    }

    pub fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, HostingError> {
        self.get(path)?.json()
    }
}

/// Whether the proxy of the environment (HTTPS_PROXY…) is used for `base`: not for this machine, nor
/// for a server listed in NO_PROXY (« example.com » and « .example.com » cover its subdomains).
fn use_proxy(base: &str, no_proxy: Option<&str>) -> bool {
    let rest = base.split_once("://").map_or(base, |(_, rest)| rest);
    let host = rest.split('/').next().unwrap_or(rest);
    let host = host.rsplit_once(':').map_or(host, |(name, _)| name).to_ascii_lowercase();
    if host == "localhost" || host.starts_with("127.") || host == "[::1]" {
        return false;
    }
    !no_proxy.unwrap_or("").split(',').map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase()).any(|entry| {
        entry == "*" || (!entry.is_empty() && (host == entry || host.ends_with(&format!(".{entry}"))))
    })
}

/// The message a service gives with an error, in the field each one uses.
fn service_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let text = |v: &serde_json::Value| v.as_str().filter(|s| !s.trim().is_empty()).map(str::to_owned);
    text(&value["message"])
        .or_else(|| text(&value["error"]["message"]))
        .or_else(|| text(&value["errors"][0]["message"]))
        .or_else(|| text(&value["error_description"]))
        .or_else(|| text(&value["error"]))
        .or_else(|| value["message"].as_object().map(|m| serde_json::to_string(m).unwrap_or_default()))
        .filter(|m| !m.is_empty())
}

fn status_error(status: u16, body: &str, url: &str, limited: bool) -> HostingError {
    let message = service_message(body).unwrap_or_else(|| format!("HTTP {status}"));
    match status {
        401 => HostingError::Unauthorized,
        429 => HostingError::RateLimited,
        403 if limited => HostingError::RateLimited,
        403 => HostingError::Forbidden(message),
        404 => HostingError::NotFound(url.to_owned()),
        _ => HostingError::Http { status, message },
    }
}

/// Encodes one part of a path or a query (« group/project » becomes « group%2Fproject »).
pub fn encode(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_errors_and_reads_messages() {
        assert!(matches!(status_error(401, "", "u", false), HostingError::Unauthorized));
        assert!(matches!(status_error(403, "", "u", true), HostingError::RateLimited));
        match status_error(403, r#"{"message":"Resource not accessible by personal access token"}"#, "u", false) {
            HostingError::Forbidden(m) => assert!(m.starts_with("Resource")),
            other => panic!("{other:?}"),
        }
        match status_error(400, r#"{"type":"error","error":{"message":"Bad branch"}}"#, "u", false) {
            HostingError::Http { status, message } => assert_eq!((status, message.as_str()), (400, "Bad branch")),
            other => panic!("{other:?}"),
        }
        match status_error(500, "<html>", "u", false) {
            HostingError::Http { message, .. } => assert_eq!(message, "HTTP 500"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn skips_the_proxy_for_this_machine_and_listed_servers() {
        assert!(use_proxy("https://api.github.com", None));
        assert!(!use_proxy("http://127.0.0.1:4000", None));
        assert!(!use_proxy("https://git.corp.example/api/v4", Some("localhost, .corp.example")));
        assert!(use_proxy("https://gitlab.com/api/v4", Some("corp.example")));
        assert!(!use_proxy("https://gitlab.com/api/v4", Some("*")));
    }

    #[test]
    fn encodes_path_parts() {
        assert_eq!(encode("group/sub project"), "group%2Fsub%20project");
        assert_eq!(encode("é"), "%C3%A9");
    }
}
