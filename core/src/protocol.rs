//! Hocuspocus wire format (v4, without session awareness): every message is
//! `varString(documentName) varUint(type) payload`, multiplexing several
//! documents over one WebSocket. Sync payloads are y-protocols sync messages;
//! awareness payloads are y-protocols awareness updates.

use yrs::encoding::read::{Cursor, Read};
use yrs::encoding::write::Write;
use yrs::sync::SyncMessage;
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};

const SYNC: u32 = 0;
const AWARENESS: u32 = 1;
const AUTH: u32 = 2;
const QUERY_AWARENESS: u32 = 3;
const STATELESS: u32 = 5;
const CLOSE: u32 = 7;
const SYNC_STATUS: u32 = 8;
const PING: u8 = 9;

const AUTH_TOKEN: u32 = 0;
const AUTH_PERMISSION_DENIED: u32 = 1;
const AUTH_AUTHENTICATED: u32 = 2;

/// Sent with the token; the server records it as the provider version.
pub const CLIENT_VERSION: &str = concat!("simple-editor-core/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Sync(SyncMessage),
    Authenticated,
    PermissionDenied(String),
    /// The server asks for the token again.
    TokenRequest,
    Stateless(String),
    /// Acknowledges an update or sync step 2; `true` when it was applied.
    SyncStatus(bool),
    Close(String),
    /// Who else has the document open (y-protocols awareness update).
    Awareness(Vec<AwarenessEntry>),
    /// The server asks for this client's awareness state.
    QueryAwareness,
}

/// One client's presence in an awareness update. `state` is JSON, or `None`
/// when the client went away.
#[derive(Debug, Clone, PartialEq)]
pub struct AwarenessEntry {
    pub client: u64,
    pub clock: u32,
    pub state: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("malformed message: {0}")]
    Malformed(#[from] yrs::encoding::read::Error),
    #[error("unknown message type {0}")]
    UnknownType(u32),
}

fn header(document: &str, kind: u32) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.write_string(document);
    buf.write_var(kind);
    buf
}

pub fn auth(document: &str, token: &str) -> Vec<u8> {
    let mut buf = header(document, AUTH);
    buf.write_var(AUTH_TOKEN);
    buf.write_string(token);
    buf.write_string(CLIENT_VERSION);
    buf
}

pub fn sync(document: &str, message: &SyncMessage) -> Vec<u8> {
    let mut encoder = EncoderV1::new();
    message.encode(&mut encoder);
    let mut buf = header(document, SYNC);
    buf.extend_from_slice(&encoder.to_vec());
    buf
}

/// An awareness update: `varUint8Array(varUint(count) (varUint(client)
/// varUint(clock) varString(json))*)`, with "null" for a client that left.
pub fn awareness(document: &str, entries: &[AwarenessEntry]) -> Vec<u8> {
    let mut update = Vec::new();
    update.write_var(entries.len() as u32);
    for e in entries {
        update.write_var(e.client);
        update.write_var(e.clock);
        update.write_string(e.state.as_deref().unwrap_or("null"));
    }
    let mut buf = header(document, AWARENESS);
    buf.write_buf(&update);
    buf
}

fn decode_awareness(update: &[u8]) -> Result<Vec<AwarenessEntry>, yrs::encoding::read::Error> {
    let mut cursor = Cursor::new(update);
    let count: u32 = cursor.read_var()?;
    let mut entries = Vec::new();
    for _ in 0..count {
        let client: u64 = cursor.read_var()?;
        let clock: u32 = cursor.read_var()?;
        let json = cursor.read_string()?;
        entries.push(AwarenessEntry { client, clock, state: (json != "null").then(|| json.to_owned()) });
    }
    Ok(entries)
}

/// Splits a server message into its document name and content. Returns
/// `None` for a bare ping, which carries no document.
pub fn decode(data: &[u8]) -> Result<Option<(String, Incoming)>, DecodeError> {
    if data == [PING] {
        return Ok(None);
    }
    let mut cursor = Cursor::new(data);
    let document = cursor.read_string()?.to_owned();
    let kind: u32 = cursor.read_var()?;
    let message = match kind {
        SYNC => {
            let rest = &data[cursor.next..];
            let mut decoder = DecoderV1::from(rest);
            Incoming::Sync(SyncMessage::decode(&mut decoder)?)
        }
        AUTH => match cursor.read_var::<u32>()? {
            AUTH_AUTHENTICATED => Incoming::Authenticated,
            AUTH_PERMISSION_DENIED => Incoming::PermissionDenied(cursor.read_string()?.to_owned()),
            AUTH_TOKEN => Incoming::TokenRequest,
            other => return Err(DecodeError::UnknownType(other)),
        },
        STATELESS => Incoming::Stateless(cursor.read_string()?.to_owned()),
        SYNC_STATUS => Incoming::SyncStatus(cursor.read_var::<u32>()? == 1),
        CLOSE => Incoming::Close(cursor.read_string()?.to_owned()),
        AWARENESS => Incoming::Awareness(decode_awareness(cursor.read_buf()?)?),
        QUERY_AWARENESS => Incoming::QueryAwareness,
        other => return Err(DecodeError::UnknownType(other)),
    };
    Ok(Some((document, message)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::StateVector;

    #[test]
    fn auth_message_layout() {
        let msg = auth("note:a", "tok");
        let mut c = Cursor::new(&msg);
        assert_eq!(c.read_string().unwrap(), "note:a");
        assert_eq!(c.read_var::<u32>().unwrap(), AUTH);
        assert_eq!(c.read_var::<u32>().unwrap(), AUTH_TOKEN);
        assert_eq!(c.read_string().unwrap(), "tok");
        assert_eq!(c.read_string().unwrap(), CLIENT_VERSION);
    }

    #[test]
    fn sync_roundtrip() {
        let msg = sync("d", &SyncMessage::SyncStep1(StateVector::default()));
        assert_eq!(
            decode(&msg).unwrap(),
            Some(("d".into(), Incoming::Sync(SyncMessage::SyncStep1(StateVector::default()))))
        );
    }

    #[test]
    fn server_messages() {
        let mut denied = header("d", AUTH);
        denied.write_var(AUTH_PERMISSION_DENIED);
        denied.write_string("rate-limited");
        assert_eq!(decode(&denied).unwrap(), Some(("d".into(), Incoming::PermissionDenied("rate-limited".into()))));

        let mut ok = header("d", AUTH);
        ok.write_var(AUTH_AUTHENTICATED);
        ok.write_string("read-write");
        assert_eq!(decode(&ok).unwrap(), Some(("d".into(), Incoming::Authenticated)));

        let mut status = header("d", SYNC_STATUS);
        status.write_var(1u32);
        assert_eq!(decode(&status).unwrap(), Some(("d".into(), Incoming::SyncStatus(true))));

        let mut stateless = header("__index", STATELESS);
        stateless.write_string("{\"type\":\"changed\"}");
        assert_eq!(
            decode(&stateless).unwrap(),
            Some(("__index".into(), Incoming::Stateless("{\"type\":\"changed\"}".into())))
        );
        assert_eq!(decode(&[PING]).unwrap(), None);
        assert_eq!(decode(&header("d", QUERY_AWARENESS)).unwrap(), Some(("d".into(), Incoming::QueryAwareness)));
        assert!(decode(&header("d", 42)).is_err());
    }

    #[test]
    fn awareness_roundtrip() {
        let entries = vec![
            AwarenessEntry { client: 1234567890123, clock: 3, state: Some(r#"{"user":{"name":"Mac"}}"#.into()) },
            AwarenessEntry { client: 7, clock: 9, state: None },
        ];
        assert_eq!(decode(&awareness("note:a", &entries)).unwrap(), Some(("note:a".into(), Incoming::Awareness(entries))));
    }
}
