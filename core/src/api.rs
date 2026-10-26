//! The server's HTTP API.

use crate::error::CoreError;
use crate::note::NoteSummary;
use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize, uniffi::Record)]
pub struct DeviceCredentials {
    pub id: String,
    pub name: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    /// This is the device making the request.
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize, uniffi::Record)]
pub struct SearchHit {
    pub id: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: i64,
    pub saved_at: i64,
    pub title: String,
    pub length: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: i64,
    pub saved_at: i64,
    pub body: String,
    pub tags: Vec<String>,
}

#[derive(Clone)]
pub struct Api {
    http: reqwest::Client,
    base: String,
    token: String,
}

pub fn http_client() -> Result<reqwest::Client, CoreError> {
    reqwest::Client::builder()
        .tls_backend_preconfigured((*crate::tls::client_config()?).clone())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(CoreError::other)
}

async fn check(res: Response) -> Result<Response, CoreError> {
    match res.status() {
        s if s.is_success() => Ok(res),
        StatusCode::UNAUTHORIZED => Err(CoreError::Unauthorized),
        StatusCode::NOT_FOUND => Err(CoreError::NotFound),
        StatusCode::TOO_MANY_REQUESTS => {
            let retry_after_secs = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())
                .unwrap_or(60);
            Err(CoreError::RateLimited { retry_after_secs })
        }
        s => Err(CoreError::Server { status: s.as_u16() }),
    }
}

/// Registers this device with the registration token (the server's
/// AUTH_TOKEN) and returns its own token. The registration token is not kept.
pub async fn register_device(
    http: &reqwest::Client,
    server_url: &str,
    registration_token: &str,
    name: &str,
) -> Result<DeviceCredentials, CoreError> {
    let res = http
        .post(format!("{}/api/devices", server_url.trim_end_matches('/')))
        .bearer_auth(registration_token)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await?;
    Ok(check(res).await?.json().await?)
}

impl Api {
    pub fn new(http: reqwest::Client, server_url: &str, device_token: &str) -> Self {
        Api { http, base: server_url.trim_end_matches('/').to_owned(), token: device_token.to_owned() }
    }

    pub fn with_token(&self, device_token: &str) -> Self {
        Api { token: device_token.to_owned(), ..self.clone() }
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.http.request(method, format!("{}{}", self.base, path)).bearer_auth(&self.token)
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, CoreError> {
        let res = self.request(Method::GET, path).send().await?;
        Ok(check(res).await?.json().await?)
    }

    pub async fn notes(&self) -> Result<Vec<NoteSummary>, CoreError> {
        self.get("/api/notes").await
    }

    pub async fn search(&self, query: &str) -> Result<Vec<SearchHit>, CoreError> {
        let res = self.request(Method::GET, "/api/search").query(&[("q", query)]).send().await?;
        Ok(check(res).await?.json().await?)
    }

    pub async fn versions(&self, note_id: &str) -> Result<Vec<VersionInfo>, CoreError> {
        self.get(&format!("/api/notes/{note_id}/versions")).await
    }

    pub async fn version(&self, note_id: &str, version_id: i64) -> Result<Version, CoreError> {
        self.get(&format!("/api/notes/{note_id}/versions/{version_id}")).await
    }

    pub async fn devices(&self) -> Result<Vec<DeviceInfo>, CoreError> {
        self.get("/api/devices").await
    }

    pub async fn rename_this_device(&self, name: &str) -> Result<(), CoreError> {
        let res = self
            .request(Method::PATCH, "/api/devices/current")
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await?;
        check(res).await?;
        Ok(())
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<(), CoreError> {
        let res = self.request(Method::DELETE, &format!("/api/devices/{device_id}")).send().await?;
        check(res).await?;
        Ok(())
    }

    /// All notes as a zip of text files plus notes.json.
    pub async fn export_zip(&self, include_trash: bool) -> Result<Vec<u8>, CoreError> {
        let path = if include_trash { "/api/export.zip?trash=1" } else { "/api/export.zip" };
        let res = self.request(Method::GET, path).send().await?;
        Ok(check(res).await?.bytes().await?.to_vec())
    }
}
