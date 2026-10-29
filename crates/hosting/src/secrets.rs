//! Tokens in the system's credential store (Windows Credential Manager, the Secret Service on Linux,
//! the Keychain on macOS), never in a file of Ramelo.

use crate::HostingError;

const SERVICE: &str = "Ramelo";

fn entry(account_id: &str) -> Result<keyring::Entry, HostingError> {
    keyring::Entry::new(SERVICE, account_id).map_err(|e| HostingError::Keyring(e.to_string()))
}

pub fn token(account_id: &str) -> Result<String, HostingError> {
    match entry(account_id)?.get_password() {
        Ok(token) => Ok(token),
        Err(keyring::Error::NoEntry) => Err(HostingError::NoToken(account_id.to_owned())),
        Err(e) => Err(HostingError::Keyring(e.to_string())),
    }
}

pub fn set_token(account_id: &str, token: &str) -> Result<(), HostingError> {
    entry(account_id)?.set_password(token).map_err(|e| HostingError::Keyring(e.to_string()))
}

/// Forgets the token; one already gone is not an error.
pub fn delete_token(account_id: &str) -> Result<(), HostingError> {
    match entry(account_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(HostingError::Keyring(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a credential store: run with `cargo test -p ramelo-hosting -- --ignored` (on Linux, with
    /// a Secret Service such as gnome-keyring unlocked).
    #[test]
    #[ignore]
    fn keeps_and_forgets_a_token() {
        let id = "test@https://example.com";
        set_token(id, "secret-1").unwrap();
        assert_eq!(token(id).unwrap(), "secret-1");
        set_token(id, "secret-2").unwrap();
        assert_eq!(token(id).unwrap(), "secret-2");
        delete_token(id).unwrap();
        assert!(matches!(token(id), Err(HostingError::NoToken(_))));
        delete_token(id).unwrap();
    }
}
