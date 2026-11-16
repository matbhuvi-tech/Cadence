use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const MAX_MESSAGE_BYTES: usize = 1_048_576;
pub const MAX_QUEUE_ENTRIES: usize = 4096;
pub const MAX_PAGE_TRACKS: usize = 200;
pub const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidPayload,
    IncompatibleProtocol,
    IdentityMismatch,
    StaleRevision,
    NotReady,
    TakeoverRequired,
    Unavailable,
}

type Result<T> = std::result::Result<T, ErrorCode>;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_compilation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_number: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_year: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    pub id: String,
    pub label: String,
    pub transport: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEntry {
    pub entry_id: String,
    pub track_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Repeat {
    Off,
    One,
    All,
}

pub(crate) enum Operation {
    Hello,
    Snapshot,
    Page {
        cursor: Option<String>,
        limit: usize,
    },
    Mutate(Mutation),
}

pub(crate) struct Mutation {
    pub id: String,
    pub revision: u64,
    pub fingerprint: [u8; 32],
    pub action: Action,
}

pub(crate) enum Action {
    Play {
        track_id: String,
        force_takeover: bool,
    },
    Pause,
    Resume,
    Stop,
    Seek(f64),
    Replace(Vec<QueueEntry>),
    Next,
    Previous,
    Jump(String),
    Modes {
        repeat: Repeat,
        shuffle: bool,
    },
}

pub(crate) fn ensure(valid: bool) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(ErrorCode::InvalidPayload)
    }
}

pub(crate) fn token(value: &str) -> Result<()> {
    ensure(
        !value.is_empty()
            && value.len() <= 128
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
    )
}

pub(crate) fn text(value: &str) -> Result<()> {
    // Match JavaScript's UTF-16 length, including supplementary Unicode characters.
    ensure(value.encode_utf16().count() <= 1024 && !value.chars().any(|c| (c as u32) < 32))
}

pub(crate) fn seconds(value: f64) -> Result<()> {
    ensure(value.is_finite() && value >= 0.0 && value <= MAX_REVISION as f64)
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(ErrorCode::InvalidPayload)
}

fn fields(object: &Map<String, Value>, extra: &[&str]) -> Result<()> {
    let base = ["protocolVersion", "engineId", "libraryId", "operation"];
    ensure(
        object.len() == base.len() + extra.len()
            && base
                .iter()
                .chain(extra)
                .all(|key| object.contains_key(*key)),
    )
}

pub(crate) fn parse(input: &[u8], engine: &str, library: &str) -> Result<Operation> {
    ensure(input.len() <= MAX_MESSAGE_BYTES)?;
    let value: Value = serde_json::from_slice(input).map_err(|_| ErrorCode::InvalidPayload)?;
    let object = value.as_object().ok_or(ErrorCode::InvalidPayload)?;
    if object.get("protocolVersion").and_then(Value::as_f64) != Some(1.0) {
        return Err(ErrorCode::IncompatibleProtocol);
    }
    let engine_id = string(object, "engineId")?;
    let library_id = string(object, "libraryId")?;
    token(engine_id)?;
    token(library_id)?;
    if engine_id != engine || library_id != library {
        return Err(ErrorCode::IdentityMismatch);
    }
    let operation = string(object, "operation")?;
    match operation {
        "core.hello" => {
            fields(object, &[])?;
            Ok(Operation::Hello)
        }
        "session.snapshot" => {
            fields(object, &[])?;
            Ok(Operation::Snapshot)
        }
        "catalog.page" => {
            fields(object, &["cursor", "limit"])?;
            let cursor = if object["cursor"].is_null() {
                None
            } else {
                let cursor = string(object, "cursor")?;
                token(cursor)?;
                Some(cursor.to_owned())
            };
            let limit = object["limit"].as_f64().ok_or(ErrorCode::InvalidPayload)?;
            ensure(limit.fract() == 0.0 && limit >= 1.0 && limit <= MAX_PAGE_TRACKS as f64)?;
            Ok(Operation::Page {
                cursor,
                limit: limit as usize,
            })
        }
        "playback.control" | "queue.replace" | "queue.control" => {
            let id = string(object, "commandId")?;
            token(id)?;
            let revision = object
                .get("expectedRevision")
                .and_then(Value::as_f64)
                .ok_or(ErrorCode::InvalidPayload)?;
            seconds(revision)?;
            ensure(revision.fract() == 0.0)?;
            let action = if operation == "queue.replace" {
                fields(object, &["commandId", "expectedRevision", "entries"])?;
                let entries: Vec<QueueEntry> = serde_json::from_value(object["entries"].clone())
                    .map_err(|_| ErrorCode::InvalidPayload)?;
                ensure(entries.len() <= MAX_QUEUE_ENTRIES)?;
                let mut ids = HashSet::new();
                for entry in &entries {
                    token(&entry.entry_id)?;
                    token(&entry.track_id)?;
                    ensure(ids.insert(&entry.entry_id))?;
                }
                Action::Replace(entries)
            } else {
                let action = string(object, "action")?;
                let mut keys = vec!["commandId", "expectedRevision", "action"];
                let parsed = match (operation, action) {
                    ("playback.control", "play") => {
                        keys.push("trackId");
                        let id = string(object, "trackId")?;
                        token(id)?;
                        let force_takeover = if let Some(ft) = object.get("forceTakeover") {
                            keys.push("forceTakeover");
                            ft.as_bool().ok_or(ErrorCode::InvalidPayload)?
                        } else {
                            false
                        };
                        Action::Play {
                            track_id: id.to_owned(),
                            force_takeover,
                        }
                    }
                    ("playback.control", "pause") => Action::Pause,
                    ("playback.control", "resume") => Action::Resume,
                    ("playback.control", "stop") => Action::Stop,
                    ("playback.control", "seek") => {
                        keys.push("positionSeconds");
                        let position = object
                            .get("positionSeconds")
                            .and_then(Value::as_f64)
                            .ok_or(ErrorCode::InvalidPayload)?;
                        seconds(position)?;
                        Action::Seek(position)
                    }
                    ("queue.control", "next") => Action::Next,
                    ("queue.control", "previous") => Action::Previous,
                    ("queue.control", "jump") => {
                        keys.push("entryId");
                        let id = string(object, "entryId")?;
                        token(id)?;
                        Action::Jump(id.to_owned())
                    }
                    ("queue.control", "modes") => {
                        keys.extend(["repeat", "shuffle"]);
                        let repeat = serde_json::from_value(
                            object
                                .get("repeat")
                                .cloned()
                                .ok_or(ErrorCode::InvalidPayload)?,
                        )
                        .map_err(|_| ErrorCode::InvalidPayload)?;
                        let shuffle = object
                            .get("shuffle")
                            .and_then(Value::as_bool)
                            .ok_or(ErrorCode::InvalidPayload)?;
                        Action::Modes { repeat, shuffle }
                    }
                    _ => return Err(ErrorCode::InvalidPayload),
                };
                fields(object, &keys)?;
                parsed
            };
            // Value maps are ordered: field ordering/whitespace cannot change a command's identity.
            let fingerprint =
                Sha256::digest(serde_json::to_vec(&value).map_err(|_| ErrorCode::InvalidPayload)?)
                    .into();
            Ok(Operation::Mutate(Mutation {
                id: id.to_owned(),
                revision: revision as u64,
                fingerprint,
                action,
            }))
        }
        _ => Err(ErrorCode::InvalidPayload),
    }
}
