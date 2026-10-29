//! Accounts on hosting services: adding one checks its token with the service and keeps it in the
//! system's credential store; the accounts file only names them.

use ramelo_hosting::{HostingError, Readme, RemoteRepo, SearchScope};
use ramelo_storage::{Account, Provider};
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::state::AppState;

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Vec<Account> {
    state.accounts().accounts.clone()
}

/// Checks `token` on the service at `url` (empty: the public service), then keeps the account; an
/// account of the same user on the same server gets the new token. `login`: the e-mail address that
/// goes with the token on Bitbucket Cloud.
#[tauri::command]
pub async fn add_account(
    state: State<'_, AppState>,
    provider: Provider,
    url: String,
    login: Option<String>,
    token: String,
) -> CommandResult<Vec<Account>> {
    let url = ramelo_hosting::normalize_url(provider, &url)
        .map_err(|_| CommandError::new("server_url_invalid", Some(url.trim().to_owned()), "this is not the web address of a server"))?;
    let token = token.trim();
    let login = login.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
    if token.is_empty() {
        return Err(CommandError::new("token_missing", None, "the token is empty"));
    }
    if provider == Provider::Bitbucket && login.is_none() {
        return Err(CommandError::new("login_missing", None, "Bitbucket Cloud needs the e-mail address of the account"));
    }
    // An address of the service in place of the e-mail (easy to paste there) is refused before asking it.
    if let Some(login) = login.as_deref().filter(|l| !l.contains('@') || l.contains('/')) {
        return Err(CommandError::new("login_not_email", Some(login.to_owned()), "the login of a Bitbucket Cloud account is its e-mail address"));
    }
    let profile = ramelo_hosting::verify(provider, &url, login.as_deref(), token).map_err(|error| match error {
        // On Bitbucket Cloud, the token alone does not say what is wrong: the usual causes are listed.
        ramelo_hosting::HostingError::Unauthorized(said) if provider == Provider::Bitbucket => {
            CommandError::new("bitbucket_unauthorized", Some(said).filter(|s| !s.is_empty()), "Bitbucket Cloud refused the e-mail address and token")
        }
        other => other.into(),
    })?;
    let id = format!("{}@{url}", profile.username);
    ramelo_hosting::set_token(&id, token)?;
    let account = Account { id, provider, url, username: profile.username, name: profile.name, login };
    state.edit_accounts(|accounts| accounts.put(account))?;
    Ok(state.accounts().accounts.clone())
}

/// Checks that the token of an account is still accepted.
#[tauri::command]
pub async fn check_account(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    let account = account(&state, &id)?;
    let token = ramelo_hosting::token(&account.id)?;
    ramelo_hosting::verify(account.provider, &account.url, account.login.as_deref(), &token)?;
    Ok(())
}

/// Forgets an account and its token. The account goes even when the credential store cannot be used
/// (it then holds no token of it anyway).
#[tauri::command]
pub fn remove_account(state: State<'_, AppState>, id: String) -> CommandResult<Vec<Account>> {
    let _ = ramelo_hosting::delete_token(&id);
    state.edit_accounts(|accounts| accounts.remove(&id))?;
    Ok(state.accounts().accounts.clone())
}

/// The page of the service where a token is created (`url` empty: the public service).
#[tauri::command]
pub fn token_page(provider: Provider, url: String) -> CommandResult<String> {
    let url = ramelo_hosting::normalize_url(provider, &url)?;
    Ok(ramelo_hosting::token_page(provider, &url))
}

/// Opens a web page in the default browser.
#[tauri::command]
pub fn open_url(url: String) -> CommandResult<()> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(HostingError::InvalidUrl(url).into());
    }
    open::that_detached(&url).map_err(|e| CommandError::new("open_failed", Some(url), e.to_string()))
}

fn account(state: &AppState, id: &str) -> CommandResult<Account> {
    Ok(state.accounts().get(id).cloned().ok_or_else(|| HostingError::NoAccount(id.to_owned()))?)
}

/// Repositories of an account whose name matches `query` (empty: the most recently active ones).
#[tauri::command]
pub async fn search_repositories(state: State<'_, AppState>, account_id: String, query: String, scope: SearchScope) -> CommandResult<Vec<RemoteRepo>> {
    let account = account(&state, &account_id)?;
    Ok(ramelo_hosting::search_repositories(&account, &query, scope)?)
}

/// The README of a repository found on an account; `None` when it has none.
#[tauri::command]
pub async fn repository_readme(state: State<'_, AppState>, account_id: String, repo: RemoteRepo) -> CommandResult<Option<Readme>> {
    let account = account(&state, &account_id)?;
    Ok(ramelo_hosting::readme(&account, &repo)?)
}
