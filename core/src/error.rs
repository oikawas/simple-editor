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
    /// The server's certificate was not trusted, typically because this
    /// device does not trust the root certificate of the server's local CA.
    #[error("certificate error: {message}")]
    Certificate { message: String },
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
        } else if is_certificate_error(&e) {
            CoreError::Certificate { message: with_sources(&e) }
        } else {
            CoreError::Network { message: with_sources(&e) }
        }
    }
}

/// Whether a TLS certificate that could not be verified is among the error's
/// causes. rustls reports it inside an `io::Error`, whose `source()` skips the
/// wrapped error, so that is looked into as well.
pub fn is_certificate_error(e: &(dyn std::error::Error + 'static)) -> bool {
    fn is_cert(e: &(dyn std::error::Error + 'static)) -> bool {
        matches!(
            e.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_) | rustls::Error::InvalidCertRevocationList(_))
        )
    }
    let mut next = Some(e);
    while let Some(cause) = next {
        if is_cert(cause) {
            return true;
        }
        if let Some(inner) = cause.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            if is_certificate_error(inner) {
                return true;
            }
        }
        next = cause.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("request failed")]
    struct Wrapper(#[source] std::io::Error);

    #[test]
    fn finds_a_certificate_error_behind_an_io_error() {
        let tls = rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer);
        let e = Wrapper(std::io::Error::new(std::io::ErrorKind::InvalidData, tls));
        assert!(is_certificate_error(&e));
    }

    #[test]
    fn other_failures_are_not_certificate_errors() {
        let refused = Wrapper(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(!is_certificate_error(&refused));
        let tls = Wrapper(std::io::Error::new(std::io::ErrorKind::InvalidData, rustls::Error::DecryptError));
        assert!(!is_certificate_error(&tls));
    }
}

/// The error and its causes, such as a TLS failure behind a failed request.
pub fn with_sources(e: &dyn std::error::Error) -> String {
    let mut message = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}
