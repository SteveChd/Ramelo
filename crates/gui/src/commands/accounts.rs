//! Accounts on hosting services: adding one checks its token with the service and keeps it in the
//! system's credential store; the accounts file only names them.

use ramelo_hosting::HostingError;
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
    let url = ramelo_hosting::normalize_url(provider, &url)?;
    let token = token.trim();
    let login = login.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
    if token.is_empty() {
        return Err(CommandError::new("token_missing", None, "the token is empty"));
    }
    if provider == Provider::Bitbucket && login.is_none() {
        return Err(CommandError::new("login_missing", None, "Bitbucket Cloud needs the e-mail address of the account"));
    }
    let profile = ramelo_hosting::verify(provider, &url, login.as_deref(), token)?;
    let id = format!("{}@{url}", profile.username);
    ramelo_hosting::set_token(&id, token)?;
    let account = Account { id, provider, url, username: profile.username, name: profile.name, login };
    state.edit_accounts(|accounts| accounts.put(account))?;
    Ok(state.accounts().accounts.clone())
}

/// Checks that the token of an account is still accepted.
#[tauri::command]
pub async fn check_account(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    let account = state.accounts().get(&id).cloned().ok_or_else(|| HostingError::NoAccount(id.clone()))?;
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
