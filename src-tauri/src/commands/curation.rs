use tauri::{Manager, State};
use crate::audio::AudioEngine;
use crate::curation::{CurationDecisionTrace, CurationStorage};
use crate::db::AppDb;

#[tauri::command]
pub fn curation_export_snapshot(app: tauri::AppHandle, snapshot: String) -> Result<String, String> {
    if snapshot.len() > 64 * 1024 {
        return Err("Diagnostic snapshot exceeds the 64 KB limit".into());
    }
    let value: serde_json::Value = serde_json::from_str(&snapshot).map_err(|e| e.to_string())?;
    let object = value.as_object().ok_or("Diagnostic snapshot must be an object")?;
    if object.get("schema").and_then(|v| v.as_u64()) != Some(1)
        || object.get("albumId").and_then(|v| v.as_str()).is_none_or(str::is_empty)
    {
        return Err("Invalid diagnostic snapshot".into());
    }
    const ALLOWED: &[&str] = &["schema", "capturedAt", "albumId", "title", "activeTier",
        "calculatedTier", "queueIssue", "draft", "trace", "fields", "trackCount", "tracks", "commits"];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("Diagnostic snapshot contains an unexpected field".into());
    }
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("diagnostics");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!("curate-snapshot-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&path, snapshot).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn curation_save_evidence(db: State<AppDb>, album_id: String, run: serde_json::Value) -> Result<(), String> {
    CurationStorage::save_evidence(&db, &album_id, &run)
}

#[tauri::command]
pub fn curation_list_evidence(db: State<AppDb>, album_id: String) -> Result<Vec<serde_json::Value>, String> {
    CurationStorage::list_evidence(&db, &album_id)
}

#[tauri::command]
pub fn curation_get_evidence(db: State<AppDb>, album_id: String, id: String) -> Result<Option<serde_json::Value>, String> {
    CurationStorage::get_evidence(&db, &album_id, &id)
}

#[tauri::command]
pub fn curation_save_draft(
    db: State<AppDb>,
    album_id: String,
    draft: serde_json::Value,
) -> Result<(), String> {
    CurationStorage::save_draft(&db, &album_id, &draft)
}

#[tauri::command]
pub fn curation_get_draft(
    db: State<AppDb>,
    album_id: String,
) -> Result<Option<serde_json::Value>, String> {
    CurationStorage::get_draft(&db, &album_id)
}

#[tauri::command]
pub fn curation_save_trace(
    db: State<AppDb>,
    engine: State<AudioEngine>,
    album_id: String,
    trace: CurationDecisionTrace,
) -> Result<(), String> {
    CurationStorage::save_trace(&db, &engine, &album_id, trace)
}

#[tauri::command]
pub fn curation_get_trace(
    db: State<AppDb>,
    album_id: String,
) -> Result<Option<CurationDecisionTrace>, String> {
    CurationStorage::get_trace(&db, &album_id)
}

#[tauri::command]
pub fn curation_clear_trace(
    db: State<AppDb>,
    album_id: String,
) -> Result<(), String> {
    CurationStorage::clear_trace(&db, &album_id)
}

