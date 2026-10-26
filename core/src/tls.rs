//! TLS that trusts the operating system's certificate store, so a root
//! certificate the user installed for the server's local CA is honored.

use crate::error::CoreError;
use std::sync::Arc;

pub fn client_config() -> Result<Arc<rustls::ClientConfig>, CoreError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone()).map_err(CoreError::other)?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(CoreError::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(Arc::new(config))
}
