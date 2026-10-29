use thiserror::Error;

/// Failure of a call to a hosting service. As in the core, [`HostingError::code`] lets the interface
/// translate it.
#[derive(Debug, Error)]
pub enum HostingError {
    #[error("the address « {0} » is not a web address (https://…)")]
    InvalidUrl(String),
    #[error("the service refused the token: it is wrong, expired or revoked")]
    Unauthorized,
    #[error("the token does not allow this: {0}")]
    Forbidden(String),
    #[error("not found on the service: {0}")]
    NotFound(String),
    #[error("too many requests: the service asks to wait before trying again")]
    RateLimited,
    #[error("the service cannot be reached: {0}")]
    Network(String),
    #[error("the service answered {status}: {message}")]
    Http { status: u16, message: String },
    #[error("the answer of the service cannot be read: {0}")]
    Format(String),
    #[error("no token is stored for the account « {0} »: add it again")]
    NoToken(String),
    #[error("the system credential store cannot be used: {0}")]
    Keyring(String),
    #[error("no account is set up for « {0} »")]
    NoAccount(String),
}

impl HostingError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidUrl(_) => "invalid_url",
            Self::Unauthorized => "hosting_unauthorized",
            Self::Forbidden(_) => "hosting_forbidden",
            Self::NotFound(_) => "hosting_not_found",
            Self::RateLimited => "hosting_rate_limited",
            Self::Network(_) => "hosting_network",
            Self::Http { .. } => "hosting_http",
            Self::Format(_) => "hosting_format",
            Self::NoToken(_) => "hosting_no_token",
            Self::Keyring(_) => "keyring",
            Self::NoAccount(_) => "hosting_no_account",
        }
    }

    pub fn subject(&self) -> Option<String> {
        match self {
            Self::InvalidUrl(s) | Self::Forbidden(s) | Self::NotFound(s) | Self::Network(s) | Self::NoToken(s) | Self::Keyring(s) | Self::NoAccount(s) => Some(s.clone()),
            Self::Http { message, .. } => Some(message.clone()),
            Self::Unauthorized | Self::RateLimited | Self::Format(_) => None,
        }
    }
}
