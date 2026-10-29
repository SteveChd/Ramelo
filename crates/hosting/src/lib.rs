//! Git hosting services: GitHub (and GitHub Enterprise), GitLab (gitlab.com or self-hosted), Bitbucket
//! Cloud and Bitbucket Data Center, through their web API. Their tokens are kept by the system's
//! credential store.

mod api;
mod error;
mod http;
mod pulls;
mod remote_url;
mod repos;
mod secrets;
mod time;

pub use api::{api_base, normalize_url, token_page, verify, Profile};
pub use error::HostingError;
pub use pulls::{
    add_comment, close_pull, create_pull, fetch_source, list_pulls, merge_pull, pull_comments, pull_details, pull_ref, repo_key, repo_web_url,
    MergeMethod, NewPull, PullComment, PullDetails, PullRequest, PullState,
};
pub use remote_url::{parse as parse_remote, RemoteLocation};
pub use repos::{readme, search_repositories, Readme, RemoteRepo, SearchScope};
pub use secrets::{delete_token, set_token, token};
