//! Repositories on a service: finding them by name, and reading their README before cloning.

use base64::Engine;
use ramelo_storage::{Account, Provider};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::client;
use crate::http::{encode, Client};
use crate::time::parse_iso;
use crate::HostingError;

/// A repository found on a service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    /// How the service's API names it: « owner/name » (GitHub, Bitbucket Cloud), the project number
    /// (GitLab), « PROJECT/slug » (Bitbucket Data Center).
    pub key: String,
    /// The name shown, with its owner (« owner/name », « group/sub/project »).
    pub full_name: String,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub web_url: String,
    pub clone_https: Option<String>,
    pub clone_ssh: Option<String>,
    pub default_branch: Option<String>,
    /// Last activity, in seconds since the epoch.
    pub updated: Option<i64>,
    pub stars: Option<u32>,
    pub language: Option<String>,
    /// Path of the README in the repository, when the service tells it with the repository (GitLab).
    pub readme_path: Option<String>,
}

/// Where to look: the repositories of the user (theirs, their organisations', those shared with them),
/// or every repository the service lets them see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    Mine,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readme {
    /// File name (« README.md »), which tells how to show it.
    pub name: String,
    pub text: String,
}

/// At most this many repositories are listed; a narrower search finds the others.
const LIMIT: usize = 100;

/// Repositories whose name matches `query` (empty: the most recently active ones).
pub fn search_repositories(account: &Account, query: &str, scope: SearchScope) -> Result<Vec<RemoteRepo>, HostingError> {
    let client = client(account)?;
    search_with(account.provider, &client, query.trim(), scope)
}

fn search_with(provider: Provider, client: &Client, query: &str, scope: SearchScope) -> Result<Vec<RemoteRepo>, HostingError> {
    let q = encode(query);
    let mut repos = match (provider, scope) {
        (Provider::GitHub, SearchScope::All) if !query.is_empty() => {
            let page: Value = client.get_json(&format!("/search/repositories?q={q}&per_page=50"))?;
            items(&page["items"]).iter().map(github_repo).collect()
        }
        (Provider::GitHub, _) => {
            // No search among one's own repositories: the most recent ones are read, then filtered.
            let mut repos = Vec::new();
            for page in 1..=3 {
                let list: Value = client.get_json(&format!("/user/repos?per_page=100&page={page}&sort=updated&affiliation=owner,collaborator,organization_member"))?;
                let found = items(&list);
                repos.extend(found.iter().map(github_repo));
                if found.len() < 100 {
                    break;
                }
            }
            filter(repos, query)
        }
        (Provider::GitLab, scope) => {
            let membership = if scope == SearchScope::Mine { "&membership=true" } else { "" };
            let search = if query.is_empty() { String::new() } else { format!("&search={q}") };
            let list: Value = client.get_json(&format!("/projects?order_by=last_activity_at&per_page=50{membership}{search}"))?;
            items(&list).iter().map(gitlab_repo).collect()
        }
        (Provider::Bitbucket, _) => bitbucket_search(client, query)?,
        (Provider::BitbucketServer, scope) => {
            let permission = if scope == SearchScope::Mine { "&permission=REPO_WRITE" } else { "" };
            let name = if query.is_empty() { String::new() } else { format!("&name={q}") };
            let page: Value = client.get_json(&format!("/repos?limit=100{permission}{name}"))?;
            items(&page["values"]).iter().map(bitbucket_server_repo).collect()
        }
    };
    repos.truncate(LIMIT);
    Ok(repos)
}

/// Workspaces of a Bitbucket Cloud user read at most, one request each.
const BITBUCKET_WORKSPACES: usize = 12;

/// Bitbucket Cloud no longer searches across workspaces: the user's workspaces are listed, then each
/// one is searched. A query that names a workspace lists all its repositories.
fn bitbucket_search(client: &Client, query: &str) -> Result<Vec<RemoteRepo>, HostingError> {
    let listing: Value = match client.get_json("/user/workspaces?pagelen=100") {
        Err(HostingError::NotFound(_)) => client.get_json("/workspaces?role=member&pagelen=100")?,
        other => other?,
    };
    let mut slugs: Vec<String> = items(&listing["values"])
        .iter()
        .filter_map(|v| v["workspace"]["slug"].as_str().or_else(|| v["slug"].as_str()).map(str::to_owned))
        .collect();
    let wanted = query.to_lowercase();
    // The workspace named by the query first, so that it is not left out by the limit.
    slugs.sort_by_key(|slug| !(!wanted.is_empty() && slug.to_lowercase().contains(&wanted)));
    let name_filter = format!("&q={}", encode(&format!("name ~ \"{}\"", query.replace('"', ""))));
    let mut repos = Vec::new();
    for slug in slugs.iter().take(BITBUCKET_WORKSPACES) {
        let whole = query.is_empty() || slug.to_lowercase().contains(&wanted);
        let filter = if whole { "" } else { &name_filter };
        let page: Value = client.get_json(&format!("/repositories/{}?sort=-updated_on&pagelen=50{filter}", encode(slug)))?;
        repos.extend(items(&page["values"]).iter().map(bitbucket_repo));
    }
    repos.sort_by_key(|r| std::cmp::Reverse(r.updated));
    Ok(repos)
}

fn items(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// Keeps the repositories whose name holds every word of `query`, case ignored.
fn filter(repos: Vec<RemoteRepo>, query: &str) -> Vec<RemoteRepo> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    repos
        .into_iter()
        .filter(|r| {
            let name = r.full_name.to_lowercase();
            words.iter().all(|w| name.contains(w))
        })
        .collect()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn github_repo(v: &Value) -> RemoteRepo {
    RemoteRepo {
        key: text(&v["full_name"]).unwrap_or_default(),
        full_name: text(&v["full_name"]).unwrap_or_default(),
        description: text(&v["description"]),
        private: v["private"].as_bool().unwrap_or(false),
        fork: v["fork"].as_bool().unwrap_or(false),
        web_url: text(&v["html_url"]).unwrap_or_default(),
        clone_https: text(&v["clone_url"]),
        clone_ssh: text(&v["ssh_url"]),
        default_branch: text(&v["default_branch"]),
        updated: text(&v["pushed_at"]).or_else(|| text(&v["updated_at"])).and_then(|d| parse_iso(&d)),
        stars: v["stargazers_count"].as_u64().map(|n| n as u32),
        language: text(&v["language"]),
        readme_path: None,
    }
}

fn gitlab_repo(v: &Value) -> RemoteRepo {
    let branch = text(&v["default_branch"]);
    // « https://gitlab.com/group/project/-/blob/main/docs/README.md » gives « docs/README.md ».
    let readme_path = text(&v["readme_url"]).and_then(|url| {
        let (_, after) = url.split_once("/-/blob/")?;
        let branch = branch.as_deref()?;
        after.strip_prefix(branch)?.strip_prefix('/').map(str::to_owned)
    });
    RemoteRepo {
        key: v["id"].as_u64().map(|id| id.to_string()).unwrap_or_default(),
        full_name: text(&v["path_with_namespace"]).unwrap_or_default(),
        description: text(&v["description"]),
        private: v["visibility"].as_str() != Some("public"),
        fork: v["forked_from_project"].is_object(),
        web_url: text(&v["web_url"]).unwrap_or_default(),
        clone_https: text(&v["http_url_to_repo"]),
        clone_ssh: text(&v["ssh_url_to_repo"]),
        default_branch: branch,
        updated: text(&v["last_activity_at"]).and_then(|d| parse_iso(&d)),
        stars: v["star_count"].as_u64().map(|n| n as u32),
        language: None,
        readme_path,
    }
}

/// Clone address named `name` (« https », « http », « ssh ») in a list of links.
fn clone_link(links: &Value, names: &[&str]) -> Option<String> {
    items(links).iter().find(|l| l["name"].as_str().is_some_and(|n| names.contains(&n))).and_then(|l| text(&l["href"]))
}

fn bitbucket_repo(v: &Value) -> RemoteRepo {
    RemoteRepo {
        key: text(&v["full_name"]).unwrap_or_default(),
        full_name: text(&v["full_name"]).unwrap_or_default(),
        description: text(&v["description"]),
        private: v["is_private"].as_bool().unwrap_or(true),
        fork: v["parent"].is_object(),
        web_url: text(&v["links"]["html"]["href"]).unwrap_or_default(),
        clone_https: clone_link(&v["links"]["clone"], &["https"]),
        clone_ssh: clone_link(&v["links"]["clone"], &["ssh"]),
        default_branch: text(&v["mainbranch"]["name"]),
        updated: text(&v["updated_on"]).and_then(|d| parse_iso(&d)),
        stars: None,
        language: text(&v["language"]),
        readme_path: None,
    }
}

fn bitbucket_server_repo(v: &Value) -> RemoteRepo {
    let key = format!("{}/{}", v["project"]["key"].as_str().unwrap_or_default(), v["slug"].as_str().unwrap_or_default());
    RemoteRepo {
        full_name: key.clone(),
        key,
        description: text(&v["description"]),
        private: !v["public"].as_bool().unwrap_or(false),
        fork: v["origin"].is_object(),
        web_url: items(&v["links"]["self"]).first().and_then(|l| text(&l["href"])).unwrap_or_default(),
        clone_https: clone_link(&v["links"]["clone"], &["http", "https"]),
        clone_ssh: clone_link(&v["links"]["clone"], &["ssh"]),
        default_branch: None,
        updated: None,
        stars: None,
        language: None,
        readme_path: None,
    }
}

/// Names a README usually has, in the order they are looked for.
const README_NAMES: [&str; 7] = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.rst", "README.txt", "README"];

/// The README of a repository, on its default branch; `None` when it has none.
pub fn readme(account: &Account, repo: &RemoteRepo) -> Result<Option<Readme>, HostingError> {
    let client = client(account)?;
    readme_with(account.provider, &client, repo)
}

fn found<T>(result: Result<T, HostingError>) -> Result<Option<T>, HostingError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(HostingError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn readme_with(provider: Provider, client: &Client, repo: &RemoteRepo) -> Result<Option<Readme>, HostingError> {
    match provider {
        Provider::GitHub => {
            let Some(file) = found(client.get_json::<Value>(&format!("/repos/{}/readme", repo.key)))? else { return Ok(None) };
            let content: String = file["content"].as_str().unwrap_or_default().chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = base64::engine::general_purpose::STANDARD.decode(content).map_err(|e| HostingError::Format(e.to_string()))?;
            Ok(Some(Readme { name: text(&file["name"]).unwrap_or_else(|| "README.md".into()), text: String::from_utf8_lossy(&bytes).into_owned() }))
        }
        Provider::GitLab => {
            let (Some(path), Some(branch)) = (&repo.readme_path, &repo.default_branch) else { return Ok(None) };
            let answer = found(client.get(&format!("/projects/{}/repository/files/{}/raw?ref={}", repo.key, encode(path), encode(branch))))?;
            Ok(answer.map(|a| Readme { name: path.rsplit('/').next().unwrap_or(path).to_owned(), text: a.body }))
        }
        Provider::Bitbucket => {
            let Some(branch) = &repo.default_branch else { return Ok(None) };
            let Some(listing) = found(client.get_json::<Value>(&format!("/repositories/{}/src/{}/?pagelen=100", repo.key, encode(branch))))? else { return Ok(None) };
            let files: Vec<&str> = items(&listing["values"]).iter().filter_map(|f| f["path"].as_str()).collect();
            let Some(name) = README_NAMES.iter().find(|n| files.contains(n)).copied().or_else(|| files.iter().find(|f| f.to_lowercase().starts_with("readme")).copied()) else { return Ok(None) };
            let answer = client.get(&format!("/repositories/{}/src/{}/{}", repo.key, encode(branch), encode(name)))?;
            Ok(Some(Readme { name: name.to_owned(), text: answer.body }))
        }
        Provider::BitbucketServer => {
            let (project, slug) = repo.key.split_once('/').unwrap_or((&repo.key, ""));
            for name in README_NAMES {
                if let Some(answer) = found(client.get(&format!("/projects/{}/repos/{}/raw/{name}", encode(project), encode(slug))))? {
                    return Ok(Some(Readme { name: name.to_owned(), text: answer.body }));
                }
            }
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::serve;
    use crate::http::Auth;

    fn bearer(base: &str) -> Client {
        Client::new(base, Auth::Bearer("t".into()))
    }

    #[test]
    fn searches_github_among_the_users_repositories() {
        let list = r#"[
            {"full_name":"steve/ramelo","description":"Git client","private":false,"fork":false,"html_url":"https://github.com/steve/ramelo",
             "clone_url":"https://github.com/steve/ramelo.git","ssh_url":"git@github.com:steve/ramelo.git","default_branch":"main",
             "pushed_at":"2026-10-01T10:00:00Z","stargazers_count":3,"language":"Rust"},
            {"full_name":"acme/firmware","private":true,"fork":true,"html_url":"https://github.com/acme/firmware","default_branch":"dev"}
        ]"#;
        let (base, requests) = serve(vec![(200, vec![], list.into())]);
        let repos = search_with(Provider::GitHub, &bearer(&base), "RAM", SearchScope::Mine).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].clone_ssh.as_deref(), Some("git@github.com:steve/ramelo.git"));
        assert_eq!(repos[0].updated, Some(1_790_848_800));
        assert!(requests.recv().unwrap().0.starts_with("GET /user/repos?per_page=100&page=1&sort=updated"));

        let (base, requests) = serve(vec![(200, vec![], format!(r#"{{"items":{list}}}"#))]);
        let repos = search_with(Provider::GitHub, &bearer(&base), "git client", SearchScope::All).unwrap();
        assert_eq!(repos.len(), 2);
        assert!(repos[1].private && repos[1].fork);
        assert_eq!(requests.recv().unwrap().0, "GET /search/repositories?q=git%20client&per_page=50 HTTP/1.1");
    }

    #[test]
    fn reads_gitlab_and_bitbucket_listings() {
        let project = r#"[{"id":42,"path_with_namespace":"team/sub/app","visibility":"internal","web_url":"https://gitlab.com/team/sub/app",
            "http_url_to_repo":"https://gitlab.com/team/sub/app.git","default_branch":"main","readme_url":"https://gitlab.com/team/sub/app/-/blob/main/docs/README.md",
            "last_activity_at":"2026-10-01T12:00:00.000+02:00","star_count":1}]"#;
        let (base, requests) = serve(vec![(200, vec![], project.into())]);
        let repos = search_with(Provider::GitLab, &bearer(&base), "app", SearchScope::Mine).unwrap();
        assert_eq!((repos[0].key.as_str(), repos[0].readme_path.as_deref()), ("42", Some("docs/README.md")));
        assert!(repos[0].private);
        assert_eq!(requests.recv().unwrap().0, "GET /projects?order_by=last_activity_at&per_page=50&membership=true&search=app HTTP/1.1");

        let page = r#"{"values":[{"full_name":"ws/repo","is_private":true,"links":{"html":{"href":"https://bitbucket.org/ws/repo"},
            "clone":[{"name":"https","href":"https://steve@bitbucket.org/ws/repo.git"},{"name":"ssh","href":"git@bitbucket.org:ws/repo.git"}]},
            "mainbranch":{"name":"master"},"updated_on":"2026-10-01T10:00:00.123456+00:00"}]}"#;
        let workspaces = r#"{"values":[{"workspace":{"slug":"ws"}},{"workspace":{"slug":"acme"}}]}"#;
        let (base, requests) = serve(vec![(200, vec![], workspaces.into()), (200, vec![], page.into()), (200, vec![], r#"{"values":[]}"#.into())]);
        let repos = search_with(Provider::Bitbucket, &bearer(&base), "repo", SearchScope::All).unwrap();
        assert_eq!(repos[0].clone_ssh.as_deref(), Some("git@bitbucket.org:ws/repo.git"));
        assert_eq!(repos[0].default_branch.as_deref(), Some("master"));
        assert!(requests.recv().unwrap().0.starts_with("GET /user/workspaces"));
        assert!(requests.recv().unwrap().0.contains("/repositories/ws?sort=-updated_on&pagelen=50&q=name%20~%20%22repo%22"));
        assert!(requests.recv().unwrap().0.contains("/repositories/acme?"));

        // A query naming a workspace lists all its repositories, that workspace first.
        let (base, requests) = serve(vec![(200, vec![], workspaces.into()), (200, vec![], page.into()), (200, vec![], r#"{"values":[]}"#.into())]);
        search_with(Provider::Bitbucket, &bearer(&base), "acme", SearchScope::Mine).unwrap();
        requests.recv().unwrap();
        let first = requests.recv().unwrap().0;
        assert!(first.contains("/repositories/acme?") && !first.contains("&q="), "{first}");

        let page = r#"{"values":[{"slug":"tool","project":{"key":"PLAT"},"public":false,"links":{"self":[{"href":"https://bb.corp/projects/PLAT/repos/tool/browse"}],
            "clone":[{"name":"http","href":"https://bb.corp/scm/plat/tool.git"},{"name":"ssh","href":"ssh://git@bb.corp:7999/plat/tool.git"}]}}]}"#;
        let (base, _) = serve(vec![(200, vec![], page.into())]);
        let repos = search_with(Provider::BitbucketServer, &bearer(&base), "", SearchScope::Mine).unwrap();
        assert_eq!(repos[0].key, "PLAT/tool");
        assert_eq!(repos[0].clone_https.as_deref(), Some("https://bb.corp/scm/plat/tool.git"));
    }

    #[test]
    fn reads_readmes() {
        let repo = RemoteRepo {
            key: "steve/ramelo".into(), full_name: "steve/ramelo".into(), description: None, private: false, fork: false,
            web_url: String::new(), clone_https: None, clone_ssh: None, default_branch: Some("main".into()), updated: None,
            stars: None, language: None, readme_path: None,
        };
        let (base, _) = serve(vec![(200, vec![], r##"{"name":"README.md","encoding":"base64","content":"IyBSYW1l\nbG8K\n"}"##.into())]);
        assert_eq!(readme_with(Provider::GitHub, &bearer(&base), &repo).unwrap().unwrap().text, "# Ramelo\n");
        let (base, _) = serve(vec![(404, vec![], r#"{"message":"Not Found"}"#.into())]);
        assert_eq!(readme_with(Provider::GitHub, &bearer(&base), &repo).unwrap(), None);

        let (base, requests) = serve(vec![
            (200, vec![], r#"{"values":[{"path":"src","type":"commit_directory"},{"path":"Readme.md","type":"commit_file"}]}"#.into()),
            (200, vec![], "Hello".into()),
        ]);
        let readme = readme_with(Provider::Bitbucket, &bearer(&base), &repo).unwrap().unwrap();
        assert_eq!((readme.name.as_str(), readme.text.as_str()), ("Readme.md", "Hello"));
        requests.recv().unwrap();
        assert_eq!(requests.recv().unwrap().0, "GET /repositories/steve/ramelo/src/main/Readme.md HTTP/1.1");

        let server = RemoteRepo { key: "PLAT/tool".into(), ..repo };
        let (base, requests) = serve(vec![(404, vec![], "{}".into()), (200, vec![], "Docs".into())]);
        let readme = readme_with(Provider::BitbucketServer, &bearer(&base), &server).unwrap().unwrap();
        assert_eq!(readme.name, "readme.md");
        assert_eq!(requests.recv().unwrap().0, "GET /projects/PLAT/repos/tool/raw/README.md HTTP/1.1");
    }
}
