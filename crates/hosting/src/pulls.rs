//! Pull requests (merge requests on GitLab): listing them, reading one with its comments, commenting,
//! merging or closing it, and opening a new one. Their changes are read with git from the commits,
//! fetched with the reference each service publishes (see [`fetch_source`]).

use ramelo_storage::{Account, Provider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::client;
use crate::http::{encode, Client};
use crate::time::parse_iso;
use crate::HostingError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullState {
    Open,
    Merged,
    /// Closed without merging (« declined » on Bitbucket).
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    /// The number shown on the service (« #12 », « !12 » on GitLab).
    pub number: u64,
    pub title: String,
    pub author: String,
    pub state: PullState,
    pub draft: bool,
    pub source_branch: String,
    pub target_branch: String,
    /// The repository the changes come from, when it is another one (a fork): its name on the service.
    pub source_repo: Option<String>,
    /// Address to fetch the source branch from, when it is a fork that the service publishes no
    /// reference of in the target repository (Bitbucket Cloud).
    pub source_clone_url: Option<String>,
    pub head_oid: Option<String>,
    pub created: Option<i64>,
    pub updated: Option<i64>,
    pub web_url: String,
    pub comments: Option<u32>,
    pub reviewers: Vec<String>,
    /// The user of the account is asked to review it.
    pub review_requested: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    /// A merge commit.
    Merge,
    /// One commit with all the changes.
    Squash,
    /// The commits replayed on the target branch.
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullDetails {
    #[serde(flatten)]
    pub pull: PullRequest,
    /// The description, in Markdown.
    pub body: String,
    /// Whether the service would merge it now; `None` while it does not know yet.
    pub mergeable: Option<bool>,
    pub conflicts: bool,
    /// How it can be merged, as the service offers.
    pub merge_methods: Vec<MergeMethod>,
    /// Version of the pull request, which Bitbucket Data Center asks for to change it.
    #[serde(skip)]
    pub version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullComment {
    pub id: String,
    pub author: String,
    /// In Markdown.
    pub body: String,
    pub created: Option<i64>,
    /// The file and line it is about, for a comment on the changes.
    pub path: Option<String>,
    pub line: Option<u32>,
    /// The line is on the side before the changes (a removed line).
    pub old_side: bool,
    /// The line changed since: the comment is no longer on the changes as they are.
    pub outdated: bool,
}

/// A comment on one line of the changes of a pull request. A line both sides have (unchanged) has
/// both numbers; a removed line only `old_line`, an added one only `new_line`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineComment {
    pub path: String,
    pub old_path: Option<String>,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub body: String,
}

/// What is asked to open a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPull {
    pub source_branch: String,
    pub target_branch: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

/// The name of a repository in the API of its service, from the path of its remote on the server
/// (`path` as [`crate::parse_remote`] gives it).
pub fn repo_key(account: &Account, path: &str) -> String {
    // A server under a sub-folder (« https://host/gitlab »): its remotes over https start with it.
    let prefix = account.url.split_once("://").and_then(|(_, rest)| rest.split_once('/')).map_or("", |(_, p)| p.trim_matches('/'));
    let path = if prefix.is_empty() { path } else { path.strip_prefix(prefix).map_or(path, |p| p.trim_start_matches('/')) };
    match account.provider {
        // « scm/PROJ/repo » over https, « proj/repo » over ssh: the project key is upper case.
        Provider::BitbucketServer => {
            let path = path.strip_prefix("scm/").unwrap_or(path);
            let (project, slug) = path.split_once('/').unwrap_or(("", path));
            let project = if project.starts_with('~') { project.to_owned() } else { project.to_ascii_uppercase() };
            format!("{project}/{slug}")
        }
        _ => path.to_owned(),
    }
}

/// The web page of a repository on its service.
pub fn repo_web_url(account: &Account, key: &str) -> String {
    match account.provider {
        Provider::BitbucketServer => {
            let (project, slug) = key.split_once('/').unwrap_or(("", key));
            format!("{}/projects/{project}/repos/{slug}", account.url)
        }
        _ => format!("{}/{key}", account.url),
    }
}

/// Where the API of the service has the pull requests of a repository.
fn base(provider: Provider, key: &str) -> String {
    match provider {
        Provider::GitHub => format!("/repos/{key}/pulls"),
        Provider::GitLab => format!("/projects/{}/merge_requests", encode(key)),
        Provider::Bitbucket => format!("/repositories/{key}/pullrequests"),
        Provider::BitbucketServer => {
            let (project, slug) = key.split_once('/').unwrap_or(("", key));
            format!("/projects/{}/repos/{}/pull-requests", encode(project), encode(slug))
        }
    }
}

/// The reference under which the service publishes the commits of a pull request in the target
/// repository; `None` for Bitbucket Cloud, where the source branch is fetched instead.
pub fn pull_ref(provider: Provider, number: u64) -> Option<String> {
    match provider {
        Provider::GitHub => Some(format!("refs/pull/{number}/head")),
        Provider::GitLab => Some(format!("refs/merge-requests/{number}/head")),
        Provider::BitbucketServer => Some(format!("refs/pull-requests/{number}/from")),
        Provider::Bitbucket => None,
    }
}

/// What to fetch to have the commits of a pull request: from which address (`None`: the remote of the
/// repository) and which reference.
pub fn fetch_source(provider: Provider, pull: &PullRequest) -> (Option<String>, String) {
    match pull_ref(provider, pull.number) {
        Some(reference) => (None, reference),
        None => (pull.source_clone_url.clone(), format!("refs/heads/{}", pull.source_branch)),
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn items(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn millis(v: &Value) -> Option<i64> {
    v.as_i64().map(|ms| ms / 1000)
}

fn names(list: &Value, field: &[&str]) -> Vec<String> {
    items(list)
        .iter()
        .filter_map(|r| text(field.iter().fold(r, |v, f| &v[*f])))
        .collect()
}

fn github_pull(v: &Value, me: &str) -> PullRequest {
    let reviewers = names(&v["requested_reviewers"], &["login"]);
    let state = if v["merged_at"].is_string() { PullState::Merged } else if v["state"] == "open" { PullState::Open } else { PullState::Closed };
    let head_repo = text(&v["head"]["repo"]["full_name"]);
    let base_repo = text(&v["base"]["repo"]["full_name"]);
    PullRequest {
        number: v["number"].as_u64().unwrap_or_default(),
        title: text(&v["title"]).unwrap_or_default(),
        author: text(&v["user"]["login"]).unwrap_or_default(),
        state,
        draft: v["draft"].as_bool().unwrap_or(false),
        source_branch: text(&v["head"]["ref"]).unwrap_or_default(),
        target_branch: text(&v["base"]["ref"]).unwrap_or_default(),
        source_repo: head_repo.filter(|h| Some(h) != base_repo.as_ref()),
        source_clone_url: None,
        head_oid: text(&v["head"]["sha"]),
        created: text(&v["created_at"]).and_then(|d| parse_iso(&d)),
        updated: text(&v["updated_at"]).and_then(|d| parse_iso(&d)),
        web_url: text(&v["html_url"]).unwrap_or_default(),
        comments: v["comments"].as_u64().map(|c| c as u32 + v["review_comments"].as_u64().unwrap_or(0) as u32),
        review_requested: reviewers.iter().any(|r| r.eq_ignore_ascii_case(me)),
        reviewers,
    }
}

fn gitlab_pull(v: &Value, me: &str) -> PullRequest {
    let reviewers = names(&v["reviewers"], &["username"]);
    let state = match v["state"].as_str() {
        Some("opened") | Some("locked") => PullState::Open,
        Some("merged") => PullState::Merged,
        _ => PullState::Closed,
    };
    PullRequest {
        number: v["iid"].as_u64().unwrap_or_default(),
        title: text(&v["title"]).unwrap_or_default(),
        author: text(&v["author"]["username"]).unwrap_or_default(),
        state,
        draft: v["draft"].as_bool().or(v["work_in_progress"].as_bool()).unwrap_or(false),
        source_branch: text(&v["source_branch"]).unwrap_or_default(),
        target_branch: text(&v["target_branch"]).unwrap_or_default(),
        source_repo: (v["source_project_id"] != v["target_project_id"]).then(|| v["source_project_id"].to_string()),
        source_clone_url: None,
        head_oid: text(&v["sha"]),
        created: text(&v["created_at"]).and_then(|d| parse_iso(&d)),
        updated: text(&v["updated_at"]).and_then(|d| parse_iso(&d)),
        web_url: text(&v["web_url"]).unwrap_or_default(),
        comments: v["user_notes_count"].as_u64().map(|c| c as u32),
        review_requested: reviewers.iter().any(|r| r.eq_ignore_ascii_case(me)),
        reviewers,
    }
}

fn bitbucket_pull(v: &Value, me: &str, repo: &str) -> PullRequest {
    let reviewers = names(&v["reviewers"], &["nickname"]);
    let state = match v["state"].as_str() {
        Some("OPEN") => PullState::Open,
        Some("MERGED") => PullState::Merged,
        _ => PullState::Closed,
    };
    let source = text(&v["source"]["repository"]["full_name"]).filter(|s| s != repo);
    PullRequest {
        number: v["id"].as_u64().unwrap_or_default(),
        title: text(&v["title"]).unwrap_or_default(),
        author: text(&v["author"]["nickname"]).or_else(|| text(&v["author"]["display_name"])).unwrap_or_default(),
        state,
        draft: v["draft"].as_bool().unwrap_or(false),
        source_branch: text(&v["source"]["branch"]["name"]).unwrap_or_default(),
        target_branch: text(&v["destination"]["branch"]["name"]).unwrap_or_default(),
        source_clone_url: source.as_ref().map(|s| format!("https://bitbucket.org/{s}.git")),
        source_repo: source,
        // Bitbucket Cloud gives a short commit id here; the fetched branch gives the whole one.
        head_oid: None,
        created: text(&v["created_on"]).and_then(|d| parse_iso(&d)),
        updated: text(&v["updated_on"]).and_then(|d| parse_iso(&d)),
        web_url: text(&v["links"]["html"]["href"]).unwrap_or_default(),
        comments: v["comment_count"].as_u64().map(|c| c as u32),
        review_requested: reviewers.iter().any(|r| r.eq_ignore_ascii_case(me)),
        reviewers,
    }
}

fn bitbucket_server_pull(v: &Value, me: &str) -> PullRequest {
    let reviewers = names(&v["reviewers"], &["user", "name"]);
    let state = match v["state"].as_str() {
        Some("OPEN") => PullState::Open,
        Some("MERGED") => PullState::Merged,
        _ => PullState::Closed,
    };
    let repo_of = |r: &Value| format!("{}/{}", r["repository"]["project"]["key"].as_str().unwrap_or_default(), r["repository"]["slug"].as_str().unwrap_or_default());
    let (from, to) = (repo_of(&v["fromRef"]), repo_of(&v["toRef"]));
    PullRequest {
        number: v["id"].as_u64().unwrap_or_default(),
        title: text(&v["title"]).unwrap_or_default(),
        author: text(&v["author"]["user"]["name"]).unwrap_or_default(),
        state,
        draft: v["draft"].as_bool().unwrap_or(false),
        source_branch: text(&v["fromRef"]["displayId"]).unwrap_or_default(),
        target_branch: text(&v["toRef"]["displayId"]).unwrap_or_default(),
        source_repo: (from != to).then_some(from),
        source_clone_url: None,
        head_oid: text(&v["fromRef"]["latestCommit"]),
        created: millis(&v["createdDate"]),
        updated: millis(&v["updatedDate"]),
        web_url: items(&v["links"]["self"]).first().and_then(|l| text(&l["href"])).unwrap_or_default(),
        comments: v["properties"]["commentCount"].as_u64().map(|c| c as u32),
        review_requested: reviewers.iter().any(|r| r.eq_ignore_ascii_case(me)),
        reviewers,
    }
}

/// The pull requests of a repository: the open ones, or all of them (the most recent first).
pub fn list_pulls(account: &Account, key: &str, open_only: bool) -> Result<Vec<PullRequest>, HostingError> {
    list_with(account, &client(account)?, key, open_only)
}

fn list_with(account: &Account, client: &Client, key: &str, open_only: bool) -> Result<Vec<PullRequest>, HostingError> {
    let me = account.username.as_str();
    let base = base(account.provider, key);
    Ok(match account.provider {
        Provider::GitHub => {
            let state = if open_only { "open" } else { "all" };
            let list: Value = client.get_json(&format!("{base}?state={state}&per_page=50&sort=updated&direction=desc"))?;
            items(&list).iter().map(|v| github_pull(v, me)).collect()
        }
        Provider::GitLab => {
            let state = if open_only { "&state=opened" } else { "" };
            let list: Value = client.get_json(&format!("{base}?per_page=50&order_by=updated_at{state}"))?;
            items(&list).iter().map(|v| gitlab_pull(v, me)).collect()
        }
        Provider::Bitbucket => {
            let state = if open_only { "state=OPEN" } else { "state=OPEN&state=MERGED&state=DECLINED" };
            let page: Value = client.get_json(&format!("{base}?{state}&pagelen=50&sort=-updated_on"))?;
            items(&page["values"]).iter().map(|v| bitbucket_pull(v, me, key)).collect()
        }
        Provider::BitbucketServer => {
            let state = if open_only { "OPEN" } else { "ALL" };
            let page: Value = client.get_json(&format!("{base}?state={state}&limit=50&order=NEWEST"))?;
            items(&page["values"]).iter().map(|v| bitbucket_server_pull(v, me)).collect()
        }
    })
}

/// One pull request with its description and whether it can be merged.
pub fn pull_details(account: &Account, key: &str, number: u64) -> Result<PullDetails, HostingError> {
    details_with(account, &client(account)?, key, number)
}

fn details_with(account: &Account, client: &Client, key: &str, number: u64) -> Result<PullDetails, HostingError> {
    let me = account.username.as_str();
    let url = format!("{}/{number}", base(account.provider, key));
    let v: Value = client.get_json(&url)?;
    Ok(match account.provider {
        Provider::GitHub => PullDetails {
            pull: github_pull(&v, me),
            body: text(&v["body"]).unwrap_or_default(),
            mergeable: v["mergeable"].as_bool(),
            conflicts: v["mergeable_state"] == "dirty",
            merge_methods: vec![MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase],
            version: None,
        },
        Provider::GitLab => {
            let status = v["detailed_merge_status"].as_str().or(v["merge_status"].as_str()).unwrap_or_default();
            PullDetails {
                pull: gitlab_pull(&v, me),
                body: text(&v["description"]).unwrap_or_default(),
                mergeable: match status {
                    "mergeable" | "can_be_merged" => Some(true),
                    "checking" | "unchecked" | "preparing" | "" => None,
                    _ => Some(false),
                },
                conflicts: v["has_conflicts"].as_bool().unwrap_or(false),
                merge_methods: vec![MergeMethod::Merge, MergeMethod::Squash],
                version: None,
            }
        }
        Provider::Bitbucket => PullDetails {
            pull: bitbucket_pull(&v, me, key),
            body: text(&v["description"]).or_else(|| text(&v["summary"]["raw"])).unwrap_or_default(),
            mergeable: None,
            conflicts: false,
            merge_methods: vec![MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase],
            version: None,
        },
        Provider::BitbucketServer => {
            let check: Option<Value> = client.get_json(&format!("{url}/merge")).ok();
            PullDetails {
                pull: bitbucket_server_pull(&v, me),
                body: text(&v["description"]).unwrap_or_default(),
                mergeable: check.as_ref().and_then(|c| c["canMerge"].as_bool()),
                conflicts: check.as_ref().and_then(|c| c["conflicted"].as_bool()).unwrap_or(false),
                merge_methods: vec![MergeMethod::Merge, MergeMethod::Squash],
                version: v["version"].as_i64(),
            }
        }
    })
}

/// The comments of a pull request, oldest first: on the conversation and on the changes.
pub fn pull_comments(account: &Account, key: &str, number: u64) -> Result<Vec<PullComment>, HostingError> {
    comments_with(account.provider, &client(account)?, key, number)
}

fn comments_with(provider: Provider, client: &Client, key: &str, number: u64) -> Result<Vec<PullComment>, HostingError> {
    let url = format!("{}/{number}", base(provider, key));
    let mut comments: Vec<PullComment> = match provider {
        Provider::GitHub => {
            let conversation: Value = client.get_json(&format!("/repos/{key}/issues/{number}/comments?per_page=100"))?;
            let review: Value = client.get_json(&format!("{url}/comments?per_page=100"))?;
            items(&conversation)
                .iter()
                .chain(items(&review))
                .map(|c| PullComment {
                    id: c["id"].to_string(),
                    author: text(&c["user"]["login"]).unwrap_or_default(),
                    body: text(&c["body"]).unwrap_or_default(),
                    created: text(&c["created_at"]).and_then(|d| parse_iso(&d)),
                    path: text(&c["path"]),
                    line: c["line"].as_u64().or(c["original_line"].as_u64()).map(|l| l as u32),
                    old_side: c["side"] == "LEFT",
                    // A review comment whose line is gone from the current changes keeps only its original line.
                    outdated: c["path"].is_string() && c["line"].is_null(),
                })
                .collect()
        }
        Provider::GitLab => {
            let notes: Value = client.get_json(&format!("{url}/notes?sort=asc&order_by=created_at&per_page=100"))?;
            items(&notes)
                .iter()
                // « added 2 commits », « approved this merge request »… are told by GitLab, not written.
                .filter(|n| !n["system"].as_bool().unwrap_or(false))
                .map(|n| PullComment {
                    id: n["id"].to_string(),
                    author: text(&n["author"]["username"]).unwrap_or_default(),
                    body: text(&n["body"]).unwrap_or_default(),
                    created: text(&n["created_at"]).and_then(|d| parse_iso(&d)),
                    path: text(&n["position"]["new_path"]).or_else(|| text(&n["position"]["old_path"])),
                    line: n["position"]["new_line"].as_u64().or(n["position"]["old_line"].as_u64()).map(|l| l as u32),
                    old_side: n["position"]["new_line"].is_null() && n["position"]["old_line"].is_u64(),
                    outdated: false,
                })
                .collect()
        }
        Provider::Bitbucket => {
            let page: Value = client.get_json(&format!("{url}/comments?pagelen=100"))?;
            items(&page["values"])
                .iter()
                .filter(|c| !c["deleted"].as_bool().unwrap_or(false))
                .map(|c| PullComment {
                    id: c["id"].to_string(),
                    author: text(&c["user"]["nickname"]).or_else(|| text(&c["user"]["display_name"])).unwrap_or_default(),
                    body: text(&c["content"]["raw"]).unwrap_or_default(),
                    created: text(&c["created_on"]).and_then(|d| parse_iso(&d)),
                    path: text(&c["inline"]["path"]),
                    line: c["inline"]["to"].as_u64().or(c["inline"]["from"].as_u64()).map(|l| l as u32),
                    old_side: c["inline"]["to"].is_null() && c["inline"]["from"].is_u64(),
                    outdated: c["inline"]["outdated"].as_bool().unwrap_or(false),
                })
                .collect()
        }
        Provider::BitbucketServer => {
            let page: Value = client.get_json(&format!("{url}/activities?limit=100"))?;
            items(&page["values"])
                .iter()
                .filter(|a| a["action"] == "COMMENTED")
                .map(|a| {
                    let c = &a["comment"];
                    PullComment {
                        id: c["id"].to_string(),
                        author: text(&c["author"]["name"]).unwrap_or_default(),
                        body: text(&c["text"]).unwrap_or_default(),
                        created: millis(&c["createdDate"]),
                        path: text(&a["commentAnchor"]["path"]),
                        line: a["commentAnchor"]["line"].as_u64().map(|l| l as u32),
                        old_side: a["commentAnchor"]["fileType"] == "FROM",
                        outdated: a["commentAnchor"]["orphaned"].as_bool().unwrap_or(false),
                    }
                })
                .collect()
        }
    };
    comments.sort_by_key(|c| c.created.unwrap_or(0));
    Ok(comments)
}

/// Adds a comment to the conversation of a pull request.
pub fn add_comment(account: &Account, key: &str, number: u64, body: &str) -> Result<(), HostingError> {
    add_comment_with(account.provider, &client(account)?, key, number, body)
}

fn add_comment_with(provider: Provider, client: &Client, key: &str, number: u64, body: &str) -> Result<(), HostingError> {
    let url = format!("{}/{number}", base(provider, key));
    let _: Value = match provider {
        Provider::GitHub => client.post_json(&format!("/repos/{key}/issues/{number}/comments"), &json!({ "body": body }))?,
        Provider::GitLab => client.post_json(&format!("{url}/notes"), &json!({ "body": body }))?,
        Provider::Bitbucket => client.post_json(&format!("{url}/comments"), &json!({ "content": { "raw": body } }))?,
        Provider::BitbucketServer => client.post_json(&format!("{url}/comments"), &json!({ "text": body }))?,
    };
    Ok(())
}

/// Comments one line of the changes of a pull request, as they are on the service now.
pub fn add_line_comment(account: &Account, key: &str, number: u64, comment: &LineComment) -> Result<(), HostingError> {
    line_comment_with(account.provider, &client(account)?, key, number, comment)
}

fn line_comment_with(provider: Provider, client: &Client, key: &str, number: u64, c: &LineComment) -> Result<(), HostingError> {
    let url = format!("{}/{number}", base(provider, key));
    let on_new = c.new_line.is_some();
    let line = c.new_line.or(c.old_line).ok_or_else(|| HostingError::Format("a line comment needs a line".into()))?;
    let _: Value = match provider {
        Provider::GitHub => {
            // The line is counted in the changes up to the last commit of the pull request.
            let pull: Value = client.get_json(&url)?;
            let commit = text(&pull["head"]["sha"]).ok_or_else(|| HostingError::Format("no head commit".into()))?;
            let side = if on_new { "RIGHT" } else { "LEFT" };
            client.post_json(&format!("{url}/comments"), &json!({ "body": c.body, "commit_id": commit, "path": c.path, "line": line, "side": side }))?
        }
        Provider::GitLab => {
            let request: Value = client.get_json(&url)?;
            let refs = &request["diff_refs"];
            let mut position = json!({
                "position_type": "text",
                "base_sha": refs["base_sha"], "start_sha": refs["start_sha"], "head_sha": refs["head_sha"],
                "new_path": c.path, "old_path": c.old_path.as_deref().unwrap_or(&c.path),
            });
            if let Some(n) = c.new_line {
                position["new_line"] = json!(n);
            }
            if let Some(n) = c.old_line {
                position["old_line"] = json!(n);
            }
            client.post_json(&format!("{url}/discussions"), &json!({ "body": c.body, "position": position }))?
        }
        Provider::Bitbucket => {
            let inline = if on_new { json!({ "path": c.path, "to": line }) } else { json!({ "path": c.path, "from": line }) };
            client.post_json(&format!("{url}/comments"), &json!({ "content": { "raw": c.body }, "inline": inline }))?
        }
        Provider::BitbucketServer => {
            let line_type = match (c.old_line, c.new_line) {
                (Some(_), Some(_)) => "CONTEXT",
                (None, Some(_)) => "ADDED",
                _ => "REMOVED",
            };
            let mut anchor = json!({ "path": c.path, "line": line, "lineType": line_type, "fileType": if on_new { "TO" } else { "FROM" }, "diffType": "EFFECTIVE" });
            if let Some(old) = &c.old_path {
                anchor["srcPath"] = json!(old);
            }
            client.post_json(&format!("{url}/comments"), &json!({ "text": c.body, "anchor": anchor }))?
        }
    };
    Ok(())
}

/// Merges a pull request. `message`: the message of the merge or squashed commit, when given.
pub fn merge_pull(account: &Account, key: &str, number: u64, method: MergeMethod, message: Option<&str>) -> Result<(), HostingError> {
    merge_with(account, &client(account)?, key, number, method, message)
}

fn merge_with(account: &Account, client: &Client, key: &str, number: u64, method: MergeMethod, message: Option<&str>) -> Result<(), HostingError> {
    let url = format!("{}/{number}", base(account.provider, key));
    let _: Value = match account.provider {
        Provider::GitHub => {
            let method = match method {
                MergeMethod::Merge => "merge",
                MergeMethod::Squash => "squash",
                MergeMethod::Rebase => "rebase",
            };
            let mut body = json!({ "merge_method": method });
            if let Some(message) = message {
                let (title, rest) = message.split_once('\n').unwrap_or((message, ""));
                body["commit_title"] = json!(title.trim());
                body["commit_message"] = json!(rest.trim());
            }
            client.put_json(&format!("{url}/merge"), &body)?
        }
        Provider::GitLab => {
            let mut body = json!({ "squash": method == MergeMethod::Squash });
            if let Some(message) = message {
                body[if method == MergeMethod::Squash { "squash_commit_message" } else { "merge_commit_message" }] = json!(message);
            }
            client.put_json(&format!("{url}/merge"), &body)?
        }
        Provider::Bitbucket => {
            let strategy = match method {
                MergeMethod::Merge => "merge_commit",
                MergeMethod::Squash => "squash",
                MergeMethod::Rebase => "fast_forward",
            };
            let mut body = json!({ "merge_strategy": strategy });
            if let Some(message) = message {
                body["message"] = json!(message);
            }
            client.post_json(&format!("{url}/merge"), &body)?
        }
        Provider::BitbucketServer => {
            let version = details_with(account, client, key, number)?.version.unwrap_or(0);
            let mut body = json!({});
            if method == MergeMethod::Squash {
                body["strategyId"] = json!("squash");
            }
            if let Some(message) = message {
                body["message"] = json!(message);
            }
            client.post_json(&format!("{url}/merge?version={version}"), &body)?
        }
    };
    Ok(())
}

/// Closes a pull request without merging it (declines it, on Bitbucket).
pub fn close_pull(account: &Account, key: &str, number: u64) -> Result<(), HostingError> {
    close_with(account, &client(account)?, key, number)
}

fn close_with(account: &Account, client: &Client, key: &str, number: u64) -> Result<(), HostingError> {
    let url = format!("{}/{number}", base(account.provider, key));
    let _: Value = match account.provider {
        Provider::GitHub => client.patch_json(&url, &json!({ "state": "closed" }))?,
        Provider::GitLab => client.put_json(&url, &json!({ "state_event": "close" }))?,
        Provider::Bitbucket => client.post_json(&format!("{url}/decline"), &json!({}))?,
        Provider::BitbucketServer => {
            let version = details_with(account, client, key, number)?.version.unwrap_or(0);
            client.post_json(&format!("{url}/decline?version={version}"), &json!({}))?
        }
    };
    Ok(())
}

/// Opens a pull request from a branch already pushed to the repository; returns it.
pub fn create_pull(account: &Account, key: &str, new: &NewPull) -> Result<PullRequest, HostingError> {
    create_with(account, &client(account)?, key, new)
}

fn create_with(account: &Account, client: &Client, key: &str, new: &NewPull) -> Result<PullRequest, HostingError> {
    let me = account.username.as_str();
    let base = base(account.provider, key);
    Ok(match account.provider {
        Provider::GitHub => {
            let body = json!({ "title": new.title, "body": new.body, "head": new.source_branch, "base": new.target_branch, "draft": new.draft });
            github_pull(&client.post_json(&base, &body)?, me)
        }
        Provider::GitLab => {
            // GitLab marks a draft by its title.
            let title = if new.draft && !new.title.to_lowercase().starts_with("draft:") { format!("Draft: {}", new.title) } else { new.title.clone() };
            let body = json!({ "title": title, "description": new.body, "source_branch": new.source_branch, "target_branch": new.target_branch });
            gitlab_pull(&client.post_json(&base, &body)?, me)
        }
        Provider::Bitbucket => {
            let body = json!({
                "title": new.title, "description": new.body, "draft": new.draft,
                "source": { "branch": { "name": new.source_branch } },
                "destination": { "branch": { "name": new.target_branch } },
            });
            bitbucket_pull(&client.post_json(&base, &body)?, me, key)
        }
        Provider::BitbucketServer => {
            let (project, slug) = key.split_once('/').unwrap_or(("", key));
            let side = |branch: &str| json!({ "id": format!("refs/heads/{branch}"), "repository": { "slug": slug, "project": { "key": project } } });
            let body = json!({
                "title": new.title, "description": new.body, "draft": new.draft,
                "fromRef": side(&new.source_branch), "toRef": side(&new.target_branch),
            });
            bitbucket_server_pull(&client.post_json(&base, &body)?, me)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::serve;
    use crate::http::Auth;

    fn account(provider: Provider, url: &str) -> Account {
        Account { id: "a".into(), provider, url: url.into(), username: "steve".into(), name: None, login: None }
    }

    fn bearer(base: &str) -> Client {
        Client::new(base, Auth::Bearer("t".into()))
    }

    #[test]
    fn names_repositories_from_their_remote() {
        let gitlab = account(Provider::GitLab, "https://git.corp/gitlab");
        assert_eq!(repo_key(&gitlab, "gitlab/team/app"), "team/app");
        assert_eq!(repo_key(&gitlab, "team/app"), "team/app");
        let server = account(Provider::BitbucketServer, "https://bb.corp");
        assert_eq!(repo_key(&server, "scm/plat/tool"), "PLAT/tool");
        assert_eq!(repo_key(&server, "plat/tool"), "PLAT/tool");
        assert_eq!(repo_key(&server, "scm/~steve/tool"), "~steve/tool");
        assert_eq!(repo_web_url(&server, "PLAT/tool"), "https://bb.corp/projects/PLAT/repos/tool");
        assert_eq!(pull_ref(Provider::GitLab, 7).as_deref(), Some("refs/merge-requests/7/head"));
    }

    #[test]
    fn lists_github_pull_requests() {
        let list = r#"[{"number":12,"title":"Add sections","user":{"login":"anna"},"state":"open","draft":false,
            "head":{"ref":"sections","sha":"abc123","repo":{"full_name":"anna/ramelo"}},"base":{"ref":"main","repo":{"full_name":"steve/ramelo"}},
            "created_at":"2026-10-01T10:00:00Z","updated_at":"2026-10-02T10:00:00Z","html_url":"https://github.com/steve/ramelo/pull/12",
            "requested_reviewers":[{"login":"Steve"}]}]"#;
        let (base, requests) = serve(vec![(200, vec![], list.into())]);
        let pulls = list_with(&account(Provider::GitHub, "https://github.com"), &bearer(&base), "steve/ramelo", true).unwrap();
        assert_eq!(requests.recv().unwrap().0, "GET /repos/steve/ramelo/pulls?state=open&per_page=50&sort=updated&direction=desc HTTP/1.1");
        let pull = &pulls[0];
        assert_eq!((pull.number, pull.state, pull.source_repo.as_deref()), (12, PullState::Open, Some("anna/ramelo")));
        assert!(pull.review_requested);
        assert_eq!(fetch_source(Provider::GitHub, pull), (None, "refs/pull/12/head".into()));
    }

    #[test]
    fn reads_gitlab_merge_requests_and_their_notes() {
        let mr = r#"{"iid":3,"title":"Draft: Faster scan","author":{"username":"steve"},"state":"opened","draft":true,"source_branch":"scan",
            "target_branch":"main","source_project_id":1,"target_project_id":1,"sha":"def","web_url":"https://gitlab.com/t/a/-/merge_requests/3",
            "description":"Body","detailed_merge_status":"mergeable","has_conflicts":false,"user_notes_count":2}"#;
        let notes = r#"[{"id":1,"body":"added 1 commit","system":true,"author":{"username":"steve"},"created_at":"2026-10-01T10:00:00Z"},
            {"id":2,"body":"Looks good","system":false,"author":{"username":"anna"},"created_at":"2026-10-01T11:00:00Z",
             "position":{"new_path":"src/scan.rs","new_line":40}}]"#;
        let (base, requests) = serve(vec![(200, vec![], mr.into()), (200, vec![], notes.into())]);
        let client = bearer(&base);
        let gitlab = account(Provider::GitLab, "https://gitlab.com");
        let details = details_with(&gitlab, &client, "t/a", 3).unwrap();
        assert_eq!(requests.recv().unwrap().0, "GET /projects/t%2Fa/merge_requests/3 HTTP/1.1");
        assert_eq!((details.mergeable, details.pull.draft, details.body.as_str()), (Some(true), true, "Body"));
        let comments = comments_with(Provider::GitLab, &client, "t/a", 3).unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!((comments[0].path.as_deref(), comments[0].line), (Some("src/scan.rs"), Some(40)));
    }

    #[test]
    fn comments_merges_and_closes() {
        let (base, requests) = serve(vec![(201, vec![], "{}".into()), (200, vec![], r#"{"merged":true}"#.into()), (200, vec![], "{}".into())]);
        let client = bearer(&base);
        let github = account(Provider::GitHub, "https://github.com");
        add_comment_with(Provider::GitHub, &client, "o/r", 5, "Thanks!").unwrap();
        let (line, _, body) = requests.recv().unwrap();
        assert_eq!((line.as_str(), body.as_str()), ("POST /repos/o/r/issues/5/comments HTTP/1.1", r#"{"body":"Thanks!"}"#));
        merge_with(&github, &client, "o/r", 5, MergeMethod::Squash, Some("Title\n\nBody")).unwrap();
        let (line, _, body) = requests.recv().unwrap();
        assert_eq!(line, "PUT /repos/o/r/pulls/5/merge HTTP/1.1");
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!((body["merge_method"].as_str(), body["commit_title"].as_str(), body["commit_message"].as_str()), (Some("squash"), Some("Title"), Some("Body")));
        close_with(&github, &client, "o/r", 5).unwrap();
        assert_eq!(requests.recv().unwrap().0, "PATCH /repos/o/r/pulls/5 HTTP/1.1");
    }

    #[test]
    fn comments_a_line_of_the_changes() {
        let removed = LineComment { path: "src/a.rs".into(), old_path: None, old_line: Some(7), new_line: None, body: "Why?".into() };
        let unchanged = LineComment { old_line: Some(3), new_line: Some(4), ..removed.clone() };

        let (base, requests) = serve(vec![(200, vec![], r#"{"head":{"sha":"abc"}}"#.into()), (201, vec![], "{}".into())]);
        line_comment_with(Provider::GitHub, &bearer(&base), "o/r", 5, &removed).unwrap();
        requests.recv().unwrap();
        let (line, _, body) = requests.recv().unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(line, "POST /repos/o/r/pulls/5/comments HTTP/1.1");
        assert_eq!((body["commit_id"].as_str(), body["line"].as_u64(), body["side"].as_str()), (Some("abc"), Some(7), Some("LEFT")));

        let refs = r#"{"diff_refs":{"base_sha":"b","start_sha":"s","head_sha":"h"}}"#;
        let (base, requests) = serve(vec![(200, vec![], refs.into()), (201, vec![], "{}".into())]);
        line_comment_with(Provider::GitLab, &bearer(&base), "t/a", 3, &unchanged).unwrap();
        requests.recv().unwrap();
        let (line, _, body) = requests.recv().unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(line, "POST /projects/t%2Fa/merge_requests/3/discussions HTTP/1.1");
        assert_eq!((body["position"]["old_line"].as_u64(), body["position"]["new_line"].as_u64(), body["position"]["head_sha"].as_str()), (Some(3), Some(4), Some("h")));

        let (base, requests) = serve(vec![(201, vec![], "{}".into())]);
        line_comment_with(Provider::Bitbucket, &bearer(&base), "ws/r", 2, &removed).unwrap();
        let body: Value = serde_json::from_str(&requests.recv().unwrap().2).unwrap();
        assert_eq!((body["inline"]["from"].as_u64(), body["inline"]["to"].is_null()), (Some(7), true));

        let (base, requests) = serve(vec![(201, vec![], "{}".into())]);
        line_comment_with(Provider::BitbucketServer, &bearer(&base), "PLAT/tool", 2, &unchanged).unwrap();
        let body: Value = serde_json::from_str(&requests.recv().unwrap().2).unwrap();
        assert_eq!((body["anchor"]["line"].as_u64(), body["anchor"]["lineType"].as_str(), body["anchor"]["fileType"].as_str()), (Some(4), Some("CONTEXT"), Some("TO")));
    }

    #[test]
    fn declines_on_bitbucket_data_center_with_the_version() {
        let pr = r#"{"id":9,"version":4,"title":"T","state":"OPEN","author":{"user":{"name":"steve"}},
            "fromRef":{"displayId":"feature","latestCommit":"aaa","repository":{"slug":"tool","project":{"key":"PLAT"}}},
            "toRef":{"displayId":"main","repository":{"slug":"tool","project":{"key":"PLAT"}}},"createdDate":1790848800000,"links":{"self":[{"href":"https://bb.corp/x"}]}}"#;
        let (base, requests) = serve(vec![(200, vec![], pr.into()), (200, vec![], r#"{"canMerge":true}"#.into()), (200, vec![], "{}".into())]);
        close_with(&account(Provider::BitbucketServer, "https://bb.corp"), &bearer(&base), "PLAT/tool", 9).unwrap();
        requests.recv().unwrap();
        requests.recv().unwrap();
        assert_eq!(requests.recv().unwrap().0, "POST /projects/PLAT/repos/tool/pull-requests/9/decline?version=4 HTTP/1.1");
    }

    #[test]
    fn opens_pull_requests() {
        let created = r#"{"id":4,"title":"New","state":"OPEN","author":{"nickname":"steve"},"source":{"branch":{"name":"feat"},"repository":{"full_name":"ws/repo"}},
            "destination":{"branch":{"name":"main"}},"links":{"html":{"href":"https://bitbucket.org/ws/repo/pull-requests/4"}}}"#;
        let (base, requests) = serve(vec![(201, vec![], created.into())]);
        let new = NewPull { source_branch: "feat".into(), target_branch: "main".into(), title: "New".into(), body: "B".into(), draft: false };
        let pull = create_with(&account(Provider::Bitbucket, "https://bitbucket.org"), &bearer(&base), "ws/repo", &new).unwrap();
        assert_eq!((pull.number, pull.source_repo.as_deref()), (4, None));
        let (line, _, body) = requests.recv().unwrap();
        assert_eq!(line, "POST /repositories/ws/repo/pullrequests HTTP/1.1");
        assert!(body.contains(r#""destination":{"branch":{"name":"main"}}"#));
    }
}
