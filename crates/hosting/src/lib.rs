//! Git hosting services: GitHub (and GitHub Enterprise), GitLab (gitlab.com or self-hosted), Bitbucket
//! Cloud and Bitbucket Data Center, through their web API. Their tokens are kept by the system's
//! credential store.

mod api;
mod error;
mod http;
mod remote_url;
mod repos;
mod secrets;
mod time;

pub use api::{api_base, normalize_url, token_page, verify, Profile};
pub use error::HostingError;
pub use remote_url::{parse as parse_remote, RemoteLocation};
pub use repos::{readme, search_repositories, Readme, RemoteRepo, SearchScope};
pub use secrets::{delete_token, set_token, token};
