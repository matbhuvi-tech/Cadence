use tauri::State;
use crate::audio::AudioEngine;
use crate::curation::{CurationDecisionTrace, CurationStorage};
use crate::db::AppDb;

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

