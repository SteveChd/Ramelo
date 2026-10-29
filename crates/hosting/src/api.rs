//! What every service offers, behind one set of functions: each one is told apart by its provider.

use ramelo_storage::{Account, Provider};
use serde::Deserialize;

use crate::http::{Auth, Client};
use crate::HostingError;

/// Who a token belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub username: String,
    pub name: Option<String>,
}

/// The web address of a service as the user typed it, checked and without a trailing slash; empty
/// gives the public service.
pub fn normalize_url(provider: Provider, url: &str) -> Result<String, HostingError> {
    let url = url.trim().trim_end_matches('/');
    let url = if url.is_empty() { provider.default_url().ok_or_else(|| HostingError::InvalidUrl(String::new()))? } else { url };
    let url = if url.contains("://") { url.to_owned() } else { format!("https://{url}") };
    let valid = (url.starts_with("https://") || url.starts_with("http://")) && url.split("://").nth(1).is_some_and(|rest| !rest.is_empty() && !rest.contains(' '));
    if !valid {
        return Err(HostingError::InvalidUrl(url));
    }
    // Bitbucket Cloud has one address only.
    Ok(if provider == Provider::Bitbucket { "https://bitbucket.org".to_owned() } else { url })
}

/// Root of the web API of a service at `url`.
pub fn api_base(provider: Provider, url: &str) -> String {
    match provider {
        Provider::GitHub if url.eq_ignore_ascii_case("https://github.com") => "https://api.github.com".to_owned(),
        Provider::GitHub => format!("{url}/api/v3"),
        Provider::GitLab => format!("{url}/api/v4"),
        Provider::Bitbucket => "https://api.bitbucket.org/2.0".to_owned(),
        Provider::BitbucketServer => format!("{url}/rest/api/latest"),
    }
}

/// The page of the service where a token is created, with the rights Ramelo needs when the service
/// lets them be preset.
pub fn token_page(provider: Provider, url: &str) -> String {
    match provider {
        Provider::GitHub => format!("{url}/settings/tokens/new?description=Ramelo&scopes=repo,read:org,read:user"),
        Provider::GitLab => format!("{url}/-/user_settings/personal_access_tokens?name=Ramelo&scopes=api,read_user"),
        Provider::Bitbucket => "https://id.atlassian.com/manage-profile/security/api-tokens".to_owned(),
        Provider::BitbucketServer => format!("{url}/plugins/servlet/access-tokens/manage"),
    }
}

fn auth(provider: Provider, login: Option<&str>, token: &str) -> Auth {
    match (provider, login) {
        (Provider::Bitbucket, Some(login)) => Auth::Basic(login.to_owned(), token.to_owned()),
        _ => Auth::Bearer(token.to_owned()),
    }
}

/// Client for an account set up earlier, with its token from the credential store.
pub(crate) fn client(account: &Account) -> Result<Client, HostingError> {
    let token = crate::secrets::token(&account.id)?;
    Ok(Client::new(&api_base(account.provider, &account.url), auth(account.provider, account.login.as_deref(), &token)))
}

/// Checks a token on the service at `url` and tells whose it is. `login`: the e-mail address that
/// goes with the token on Bitbucket Cloud.
pub fn verify(provider: Provider, url: &str, login: Option<&str>, token: &str) -> Result<Profile, HostingError> {
    let client = Client::new(&api_base(provider, url), auth(provider, login, token));
    verify_with(provider, &client)
}

fn verify_with(provider: Provider, client: &Client) -> Result<Profile, HostingError> {
    match provider {
        Provider::GitHub => {
            #[derive(Deserialize)]
            struct User { login: String, name: Option<String> }
            let user: User = client.get_json("/user")?;
            Ok(Profile { username: user.login, name: user.name })
        }
        Provider::GitLab => {
            #[derive(Deserialize)]
            struct User { username: String, name: Option<String> }
            let user: User = client.get_json("/user")?;
            Ok(Profile { username: user.username, name: user.name })
        }
        Provider::Bitbucket => {
            #[derive(Deserialize)]
            struct User { username: Option<String>, nickname: Option<String>, display_name: Option<String> }
            let user: User = client.get_json("/user")?;
            let username = user.username.or(user.nickname).ok_or_else(|| HostingError::Format("no user name".into()))?;
            Ok(Profile { username, name: user.display_name })
        }
        Provider::BitbucketServer => {
            // No « current user » resource: the server names the user of the request in a header.
            let answer = client.get("/application-properties")?;
            let username = answer.header("x-ausername").map(str::to_owned).ok_or(HostingError::Unauthorized)?;
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct User { display_name: Option<String> }
            let name = client.get_json::<User>(&format!("/users/{}", crate::http::encode(&username))).ok().and_then(|u| u.display_name);
            Ok(Profile { username, name })
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    use super::*;

    /// A one-shot local server: answers each request with the next of `answers` (status, headers,
    /// body) and reports the requests it received (method and path, then the authorization header).
    /// Status, extra headers and body of one answer.
    pub type Canned = (u16, Vec<(&'static str, &'static str)>, String);
    /// Request line, authorization header and body of one request.
    pub type Received = (String, String, String);

    pub fn serve(answers: Vec<Canned>) -> (String, mpsc::Receiver<Received>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (sent, received) = mpsc::channel();
        thread::spawn(move || {
            for (status, headers, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut authorization = String::new();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    let (name, value) = header.split_once(':').unwrap();
                    match name.to_ascii_lowercase().as_str() {
                        "authorization" => authorization = value.trim().to_owned(),
                        "content-length" => length = value.trim().parse().unwrap(),
                        _ => {}
                    }
                }
                let mut content = vec![0; length];
                reader.read_exact(&mut content).unwrap();
                let _ = sent.send((line.trim().to_owned(), authorization, String::from_utf8(content).unwrap()));
                let extra: String = headers.iter().map(|(n, v)| format!("{n}: {v}\r\n")).collect();
                write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len()).unwrap();
            }
        });
        (base, received)
    }

    #[test]
    fn checks_a_token_on_each_service() {
        let (base, requests) = serve(vec![(200, vec![], r#"{"login":"steve","name":"Steve C"}"#.into())]);
        let profile = verify_with(Provider::GitHub, &Client::new(&base, Auth::Bearer("t1".into()))).unwrap();
        assert_eq!(profile, Profile { username: "steve".into(), name: Some("Steve C".into()) });
        let (line, sent_auth, _) = requests.recv().unwrap();
        assert_eq!((line.as_str(), sent_auth.as_str()), ("GET /user HTTP/1.1", "Bearer t1"));

        let (base, requests) = serve(vec![(200, vec![], r#"{"username":"sc","display_name":"Steve"}"#.into())]);
        let profile = verify_with(Provider::Bitbucket, &Client::new(&base, auth(Provider::Bitbucket, Some("s@x.fr"), "t2"))).unwrap();
        assert_eq!(profile.username, "sc");
        assert_eq!(requests.recv().unwrap().1, format!("Basic {}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "s@x.fr:t2")));

        let (base, requests) = serve(vec![
            (200, vec![("X-AUSERNAME", "steve")], "{}".into()),
            (200, vec![], r#"{"displayName":"Steve C"}"#.into()),
        ]);
        let profile = verify_with(Provider::BitbucketServer, &Client::new(&base, Auth::Bearer("t3".into()))).unwrap();
        assert_eq!(profile, Profile { username: "steve".into(), name: Some("Steve C".into()) });
        assert_eq!(requests.recv().unwrap().0, "GET /application-properties HTTP/1.1");
        assert_eq!(requests.recv().unwrap().0, "GET /users/steve HTTP/1.1");

        let (base, _) = serve(vec![(401, vec![], r#"{"message":"401 Unauthorized"}"#.into())]);
        assert!(matches!(verify_with(Provider::GitLab, &Client::new(&base, Auth::Bearer("bad".into()))), Err(HostingError::Unauthorized)));
    }

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize_url(Provider::GitHub, "").unwrap(), "https://github.com");
        assert_eq!(normalize_url(Provider::GitLab, "git.example.com/").unwrap(), "https://git.example.com");
        assert_eq!(normalize_url(Provider::Bitbucket, "whatever").unwrap(), "https://bitbucket.org");
        assert!(normalize_url(Provider::BitbucketServer, "").is_err());
        assert!(normalize_url(Provider::GitLab, "ftp://x").is_err());
        assert_eq!(api_base(Provider::GitHub, "https://github.com"), "https://api.github.com");
        assert_eq!(api_base(Provider::GitHub, "https://ghe.corp"), "https://ghe.corp/api/v3");
    }
}
