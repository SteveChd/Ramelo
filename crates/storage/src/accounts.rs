//! Accounts on git hosting services (GitHub, GitLab, Bitbucket), kept in `accounts.json`. Only what
//! identifies an account is written here: its token is kept by the system's credential store.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{atomic, StorageError};

const FILE_NAME: &str = "accounts.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    /// github.com, or GitHub Enterprise Server.
    #[serde(rename = "github")]
    GitHub,
    /// gitlab.com, or a self-hosted GitLab.
    #[serde(rename = "gitlab")]
    GitLab,
    /// Bitbucket Cloud (bitbucket.org).
    Bitbucket,
    /// Bitbucket Data Center / Server, self-hosted.
    BitbucketServer,
}

impl Provider {
    /// Address of the public service; `None` for a service that is always self-hosted.
    pub fn default_url(self) -> Option<&'static str> {
        match self {
            Self::GitHub => Some("https://github.com"),
            Self::GitLab => Some("https://gitlab.com"),
            Self::Bitbucket => Some("https://bitbucket.org"),
            Self::BitbucketServer => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Stable identifier, also the key of the token in the credential store.
    pub id: String,
    pub provider: Provider,
    /// Web address of the service, without a trailing slash (« https://github.com »).
    pub url: String,
    /// The user the token belongs to, as the service names them.
    pub username: String,
    /// Full name shown next to the user name, when the service gives one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// What goes with the token to sign in, when the service asks for more than the token (the
    /// e-mail address of an Atlassian account, for Bitbucket Cloud).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
}

impl Account {
    /// Name of the server, without the port (« github.com »): what a remote of a repository on it
    /// starts with, over https or ssh.
    pub fn hostname(&self) -> &str {
        let rest = self.url.split_once("://").map_or(self.url.as_str(), |(_, rest)| rest);
        let host = rest.split('/').next().unwrap_or(rest);
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Accounts {
    pub accounts: Vec<Account>,
}

impl Accounts {
    /// Reads the accounts; a missing or unreadable file gives none.
    pub fn load(dir: &Path) -> Self {
        fs::read_to_string(dir.join(FILE_NAME))
            .ok()
            .and_then(|text| serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), StorageError> {
        let path = dir.join(FILE_NAME);
        let json = serde_json::to_vec_pretty(self).map_err(|source| StorageError::Format { path: path.clone(), source })?;
        atomic::write(&path, &json)
    }

    pub fn get(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }

    /// Adds an account, or replaces the one with the same identifier (a new token for it).
    pub fn put(&mut self, account: Account) {
        match self.accounts.iter_mut().find(|a| a.id == account.id) {
            Some(existing) => *existing = account,
            None => self.accounts.push(account),
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.accounts.retain(|a| a.id != id);
    }

    /// The accounts on the server named `hostname` (without port), the one of a repository's remote.
    pub fn for_host<'a>(&'a self, hostname: &'a str) -> impl Iterator<Item = &'a Account> + 'a {
        self.accounts.iter().filter(move |a| a.hostname().eq_ignore_ascii_case(hostname))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, url: &str) -> Account {
        Account { id: id.into(), provider: Provider::GitLab, url: url.into(), username: "steve".into(), name: None, login: None }
    }

    #[test]
    fn keeps_accounts_and_finds_them_by_host() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Accounts::load(dir.path()), Accounts::default());
        let mut list = Accounts::default();
        list.put(account("a", "https://gitlab.com"));
        list.put(account("b", "https://git.example.com:8443/gitlab"));
        list.put(Account { name: Some("Steve".into()), ..account("a", "https://gitlab.com") });
        assert_eq!(list.accounts.len(), 2);
        list.save(dir.path()).unwrap();
        let loaded = Accounts::load(dir.path());
        assert_eq!(loaded, list);
        assert_eq!(loaded.get("a").unwrap().name.as_deref(), Some("Steve"));
        assert_eq!(loaded.for_host("git.example.com").count(), 1);
        assert_eq!(loaded.for_host("GitLab.com").count(), 1);
        let text = fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(text.contains("\"provider\": \"gitlab\""));
        list.remove("a");
        assert!(list.get("a").is_none());
    }
}
