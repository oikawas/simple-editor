#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CoreError {
    /// The token was refused: the device was revoked, or the registration token is wrong.
    #[error("unauthorized")]
    Unauthorized,
    /// Too many failed attempts from this address; try again after the given seconds.
    #[error("too many failed attempts; retry in {retry_after_secs} seconds")]
    RateLimited { retry_after_secs: u64 },
    #[error("not found")]
    NotFound,
    /// The server could not be reached.
    #[error("network error: {message}")]
    Network { message: String },
    #[error("server error {status}")]
    Server { status: u16 },
    #[error("{message}")]
    Other { message: String },
}

impl CoreError {
    pub fn other(e: impl std::fmt::Display) -> Self {
        CoreError::Other { message: e.to_string() }
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        CoreError::other(e)
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_decode() {
            CoreError::other(e)
        } else {
            CoreError::Network { message: e.to_string() }
        }
    }
}
