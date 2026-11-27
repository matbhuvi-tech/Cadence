//! Consent-first diagnostic support bundle builder, multi-DB lineage auditor,
//! actionable self-diagnosis engine, PII/secret redactor, and pure-Rust ZIP writer.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::core_runtime::doctor::run_engine_doctor;
use crate::core_runtime::dragonfish::DEFAULT_CONTROL_PORT;
use crate::diagnostics::{self, list_crash_logs, read_log_tail_from_dir, DebugLogState};

pub const SUPPORT_EMAIL: &str = "matbhuvitech@gmail.com";
pub const DEFAULT_SUPPORT_WEBHOOK_URL: &str =
    "https://script.google.com/macros/s/AKfycbzdnWVHCUtReC9EPOYDVIvUBbZy-9IoItxPwu5JlEY0-DVz9pTYMQQ5SA3RXss9d2L_wg/exec";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportScenarioInfo {
    pub id: String,
    pub label: String,
    pub description: String,
}

pub fn support_scenarios() -> Vec<SupportScenarioInfo> {
    vec![
        SupportScenarioInfo {
            id: "engine_not_connecting".into(),
            label: "App is not connecting with playback engine".into(),
            description: "Desktop UI cannot reach, pair with, or stay connected to Cadence Playback Engine.".into(),
        },
        SupportScenarioInfo {
            id: "upnp_discovery_failed".into(),
            label: "App is not discovering UPnP or playback speakers".into(),
            description: "UPnP renderers, USB DACs, or audio output devices are missing from the output list.".into(),
        },
        SupportScenarioInfo {
            id: "enrichment_stuck".into(),
            label: "Enrichment is not working or got stuck".into(),
            description: "Metadata or cover art enrichment stopped progressing or stays paused/pending.".into(),
        },
        SupportScenarioInfo {
            id: "enrichment_slow".into(),
            label: "Enrichment is going slow".into(),
            description: "Album matching or artwork fetching is taking unusually long.".into(),
        },
        SupportScenarioInfo {
            id: "app_crashed".into(),
            label: "App crashed or closed unexpectedly".into(),
            description: "Desktop or Playback Engine exited abruptly or generated a crash report.".into(),
        },
        SupportScenarioInfo {
            id: "mobile_not_connecting".into(),
            label: "Mobile is not connecting with playback engine".into(),
            description: "Cadence Remote on phone/tablet cannot discover, trust, or authenticate with the engine.".into(),
        },
        SupportScenarioInfo {
            id: "smb_mount_failed".into(),
            label: "Not able to add an SMB folder".into(),
            description: "Adding or mounting a network SMB/NAS share fails or returns permission/path errors.".into(),
        },
        SupportScenarioInfo {
            id: "lost_library_after_upgrade".into(),
            label: "Lost library after upgrading playback engine".into(),
            description: "Tracks, playlists, or folders disappeared after updating or switching Tray/Service mode.".into(),
        },
        SupportScenarioInfo {
            id: "wasapi_exclusive_failed".into(),
            label: "WASAPI Exclusive / ASIO bit-perfect playback failed".into(),
            description: "Bit-perfect audio device initialization or sample-rate switching fails.".into(),
        },
        SupportScenarioInfo {
            id: "upnp_dropouts".into(),
            label: "UPnP playback stutters, drops out, or cuts off early".into(),
            description: "Network streaming to a UPnP renderer pauses, skips, or stops mid-track.".into(),
        },
        SupportScenarioInfo {
            id: "ram_lock_admission_failed".into(),
            label: "Track failed to pre-load into RAM (VirtualLock / memlock)".into(),
            description: "Playback fails with not_ready or memory lock budget errors on large hi-res/DSD files.".into(),
        },
        SupportScenarioInfo {
            id: "scanner_skipped_files".into(),
            label: "Library scan skipped files or shows wrong format".into(),
            description: "Some audio files are missing after scanning or DSD/PCM metadata looks wrong.".into(),
        },
        SupportScenarioInfo {
            id: "tag_commit_stuck".into(),
            label: "Tag writes / Curation commits are stuck or failing".into(),
            description: "Approved metadata changes stay queued or fail to write to audio files.".into(),
        },
        SupportScenarioInfo {
            id: "gemini_provenance_failed".into(),
            label: "Gemini AI / Compilation provenance resolution failed".into(),
            description: "AI metadata resolution or soundtrack provenance lookup returns errors.".into(),
        },
        SupportScenarioInfo {
            id: "missing_artwork".into(),
            label: "Album covers or artist portraits are missing".into(),
            description: "Releases or artists show placeholders even when local or remote art exists.".into(),
        },
        SupportScenarioInfo {
            id: "cooldown_deadlock".into(),
            label: "Actions keep saying 'deferred until idle' when stopped".into(),
            description: "Folder scans, discovery, or curation stay blocked after playback stops.".into(),
        },
    ]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseLineageEntry {
    pub label: String,
    pub path: String,
    pub exists: bool,
    pub db_exists: bool,
    pub db_size_bytes: Option<u64>,
    pub db_modified_utc: Option<String>,
    pub tracks_count: Option<i64>,
    pub releases_count: Option<i64>,
    pub playlists_count: Option<i64>,
    pub watched_folders_count: Option<i64>,
    pub curation_drafts_count: Option<i64>,
    pub engine_id: Option<String>,
    pub library_id: Option<String>,
    pub schema_version: Option<u32>,
    pub has_localhost_pairing: bool,
    pub crash_log_count: usize,
    pub migration_history: Value,
    pub inspect_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfDiagnosisHint {
    pub severity: String, // "error" | "warn" | "info"
    pub code: String,
    pub title: String,
    pub detail: String,
    pub recommended_action: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportDiagnosticsPreview {
    pub scenario_id: String,
    pub scenario_label: String,
    pub generated_at_utc: String,
    pub support_email: String,
    pub desktop_version: String,
    pub os_info: String,
    pub windows_service_running: bool,
    pub active_engine_url: Option<String>,
    pub active_engine_reachable: bool,
    pub active_engine_probe_error: Option<String>,
    pub desktop_debug_state: DebugLogState,
    pub hints: Vec<SelfDiagnosisHint>,
    pub database_lineage: Vec<DatabaseLineageEntry>,
    pub doctor_reports: Vec<Value>,
    pub planned_bundle_files: Vec<String>,
    pub email_subject: String,
    pub email_body: String,
    pub mailto_url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleRequest {
    pub scenario_id: String,
    pub user_notes: Option<String>,
    pub contact_email: Option<String>,
    pub webhook_url: Option<String>,
    pub redact_paths: Option<bool>,
    pub consent_granted: bool,
    pub active_engine_url: Option<String>,
    pub active_engine_reachable: Option<bool>,
    pub active_engine_probe_error: Option<String>,
    pub engine_snapshot: Option<Value>,
    pub frontend_context: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportWebhookConfig {
    pub webhook_url: Option<String>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSubmissionResult {
    pub submitted: bool,
    pub ticket_id: String,
    pub message: String,
    pub drive_file_url: Option<String>,
    pub bundle: GeneratedSupportBundle,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedSupportBundle {
    pub zip_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub files_included: Vec<String>,
    pub email_to: String,
    pub email_subject: String,
    pub email_body: String,
    pub mailto_url: String,
    pub preview: SupportDiagnosticsPreview,
}

fn sanitize_scenario_slug(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "general_issue".to_string()
    } else {
        cleaned
    }
}

pub fn redact_sensitive_text(input: &str, redact_paths: bool) -> String {
    let mut out = input.to_string();

    for key in [
        "token",
        "pairingToken",
        "pairing_token",
        "password",
        "apiKey",
        "api_key",
        "geminiApiKey",
    ] {
        out = redact_json_string_field(&out, key);
    }

    for header in ["x-cadence-token:", "Authorization:", "PASSWD="] {
        out = redact_line_after_prefix(&out, header);
    }

    out = redact_prefixed_token(&out, "AIza", 35);
    out = redact_pem_private_keys(&out);

    if redact_paths {
        if let Ok(user) = std::env::var("USERNAME").or_else(|_| std::env::var("USER")) {
            let trimmed = user.trim();
            if trimmed.len() >= 2 {
                out = out.replace(&format!("\\Users\\{trimmed}\\"), "\\Users\\<USER>\\");
                out = out.replace(&format!("/Users/{trimmed}/"), "/Users/<USER>/");
                out = out.replace(&format!("/home/{trimmed}/"), "/home/<USER>/");
                out = out.replace(&format!("\\Users\\{trimmed}"), "\\Users\\<USER>");
            }
        }
    }

    out
}

fn redact_json_string_field(text: &str, field: &str) -> String {
    let pattern = format!("\"{field}\"");
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find(&pattern) {
        let after_key = &rest[idx + pattern.len()..];
        let Some(colon_pos) = after_key.find(':') else {
            result.push_str(&rest[..idx + pattern.len()]);
            rest = after_key;
            continue;
        };
        let between = &after_key[..colon_pos + 1];
        if !between[..colon_pos].trim().is_empty() {
            result.push_str(&rest[..idx + pattern.len()]);
            rest = after_key;
            continue;
        }
        let after_colon = &after_key[colon_pos + 1..];
        let ws_len = after_colon.len() - after_colon.trim_start().len();
        let val_start = &after_colon[ws_len..];
        if let Some(stripped) = val_start.strip_prefix('"') {
            if let Some(end_quote) = find_unescaped_quote(stripped) {
                result.push_str(&rest[..idx + pattern.len()]);
                result.push_str(between);
                result.push_str(&after_colon[..ws_len]);
                result.push_str("\"[REDACTED]\"");
                rest = &stripped[end_quote + 1..];
                continue;
            }
        }
        result.push_str(&rest[..idx + pattern.len()]);
        rest = after_key;
    }
    result.push_str(rest);
    result
}

fn find_unescaped_quote(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn redact_line_after_prefix(text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (idx, line) in text.split_inclusive('\n').enumerate() {
        let _ = idx;
        if let Some(pos) = line.find(prefix) {
            out.push_str(&line[..pos + prefix.len()]);
            out.push_str(" [REDACTED]");
            if line.ends_with('\n') {
                out.push('\n');
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

fn redact_prefixed_token(text: &str, prefix: &str, min_tail: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(prefix) {
        out.push_str(&rest[..pos]);
        let cand = &rest[pos..];
        let token_len = cand
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
            .count();
        if token_len >= prefix.len() + min_tail.saturating_sub(5) {
            out.push_str("[REDACTED_KEY]");
            rest = &cand[token_len..];
        } else {
            out.push_str(prefix);
            rest = &cand[prefix.len()..];
        }
    }
    out.push_str(rest);
    out
}

fn redact_pem_private_keys(text: &str) -> String {
    const BEGIN: &str = "-----BEGIN ";
    const END_MARKER: &str = "PRIVATE KEY-----";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(BEGIN) {
        let after = &rest[start..];
        let Some(first_line_end) = after.find('\n') else {
            break;
        };
        if !after[..first_line_end].contains(END_MARKER) {
            out.push_str(&rest[..start + BEGIN.len()]);
            rest = &rest[start + BEGIN.len()..];
            continue;
        }
        out.push_str(&rest[..start]);
        if let Some(end_pos) = after.find("-----END ") {
            if let Some(tail_nl) = after[end_pos..].find('\n') {
                out.push_str("[REDACTED_PRIVATE_KEY]\n");
                rest = &after[end_pos + tail_nl + 1..];
                continue;
            }
        }
        out.push_str("[REDACTED_PRIVATE_KEY]");
        rest = "";
        break;
    }
    out.push_str(rest);
    out
}

pub fn candidate_database_directories() -> Vec<(String, PathBuf)> {
    let mut raw_dirs: Vec<(String, PathBuf)> = Vec::new();

    if let Ok(explicit) = std::env::var("CADENCE_DATA_DIR") {
        let t = explicit.trim();
        if !t.is_empty() {
            raw_dirs.push(("Env CADENCE_DATA_DIR".into(), PathBuf::from(t)));
        }
    }

    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let t = local.trim();
            if !t.is_empty() {
                raw_dirs.push((
                    "Windows Engine (User Tray)".into(),
                    PathBuf::from(t).join("CadenceEngine"),
                ));
            }
        }
        #[cfg(any(feature = "desktop", feature = "engine-audio"))]
        if let Some(svc_dir) = crate::core_runtime::windows_engine::installed_windows_service_data_dir()
        {
            raw_dirs.push(("Windows Engine (Configured Service)".into(), svc_dir));
        }
        let prog_data = std::env::var("ProgramData")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| r"C:\ProgramData".to_string());
        raw_dirs.push((
            "Windows Engine (Default Service)".into(),
            PathBuf::from(prog_data).join("CadenceEngine"),
        ));
        if let Ok(app_data) = std::env::var("APPDATA") {
            let base = PathBuf::from(app_data.trim());
            raw_dirs.push(("Desktop AppData (com.cadence.core)".into(), base.join("com.cadence.core")));
            raw_dirs.push(("Desktop Legacy (com.cadence.app)".into(), base.join("com.cadence.app")));
            raw_dirs.push(("Desktop Legacy (Cadence)".into(), base.join("Cadence")));
            raw_dirs.push(("Desktop Legacy (AppData Root)".into(), base));
        }
    }

    #[cfg(not(windows))]
    {
        raw_dirs.push(("Linux Core (/var/lib/cadence)".into(), PathBuf::from("/var/lib/cadence")));
        if let Ok(home) = std::env::var("HOME") {
            let h = PathBuf::from(home);
            raw_dirs.push(("User Local Data".into(), h.join(".local/share/com.cadence.core")));
            raw_dirs.push(("User Engine Data".into(), h.join(".local/share/CadenceEngine")));
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut deduped: Vec<(String, PathBuf)> = Vec::new();
    for (label, dir) in raw_dirs {
        let key = dir.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            deduped.push((label, dir));
        }
    }
    deduped
}

pub fn inspect_single_database_dir(label: &str, dir: &Path) -> DatabaseLineageEntry {
    let exists = dir.is_dir();
    let db_path = dir.join("cadence.db");
    let db_exists = exists && db_path.is_file();

    let (db_size_bytes, db_modified_utc) = if db_exists {
        match fs::metadata(&db_path) {
            Ok(meta) => {
                let mtime = meta.modified().ok().map(|st| {
                    let dt: DateTime<Utc> = st.into();
                    dt.to_rfc3339()
                });
                (Some(meta.len()), mtime)
            }
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    let (mut tracks_count, mut releases_count, mut playlists_count, mut watched_folders_count, mut curation_drafts_count) =
        (None, None, None, None, None);
    let mut inspect_error = None;

    if db_exists {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        match Connection::open_with_flags(&db_path, flags) {
            Ok(conn) => {
                let count_table = |tbl: &str| -> Option<i64> {
                    conn.query_row(&format!("SELECT COUNT(*) FROM {tbl}"), [], |r| r.get(0))
                        .ok()
                };
                tracks_count = count_table("tracks");
                releases_count = count_table("releases");
                playlists_count = count_table("playlists");
                watched_folders_count = count_table("watched_folders");
                curation_drafts_count = count_table("curation_drafts");
            }
            Err(e) => {
                inspect_error = Some(e.to_string());
            }
        }
    }

    let id_path = dir.join("node-identity.json");
    let mut engine_id = None;
    let mut library_id = None;
    let mut schema_version = None;
    if id_path.is_file() {
        if let Ok(raw) = fs::read_to_string(&id_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                engine_id = v.get("engineId").and_then(Value::as_str).map(str::to_string);
                library_id = v.get("libraryId").and_then(Value::as_str).map(str::to_string);
                schema_version = v
                    .get("schemaVersion")
                    .and_then(Value::as_u64)
                    .map(|n| n as u32);
            }
        }
    }

    let migration_history = fs::read_to_string(dir.join("migration-history.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);

    let crash_log_count = list_crash_logs(&dir.join("logs")).len();

    DatabaseLineageEntry {
        label: label.to_string(),
        path: dir.to_string_lossy().to_string(),
        exists,
        db_exists,
        db_size_bytes,
        db_modified_utc,
        tracks_count,
        releases_count,
        playlists_count,
        watched_folders_count,
        curation_drafts_count,
        engine_id,
        library_id,
        schema_version,
        has_localhost_pairing: dir.join("localhost-pairing.json").is_file(),
        crash_log_count,
        migration_history,
        inspect_error,
    }
}

pub fn inspect_database_lineage_for_dirs(dirs: &[(String, PathBuf)]) -> Vec<DatabaseLineageEntry> {
    let mut out = Vec::new();
    for (label, dir) in dirs {
        out.push(inspect_single_database_dir(label, dir));
        for sub in ["backups", "rollback"] {
            let sub_dir = dir.join(sub);
            if let Ok(entries) = fs::read_dir(&sub_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() && p.join("cadence.db").is_file() {
                        let name = p
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| sub.to_string());
                        out.push(inspect_single_database_dir(
                            &format!("{label} ({sub}/{name})"),
                            &p,
                        ));
                    }
                }
            }
        }
    }
    out
}

pub fn compute_self_diagnosis_hints(
    scenario_id: &str,
    lineage: &[DatabaseLineageEntry],
    doctor_reports: &[Value],
    windows_service_running: bool,
    active_engine_reachable: bool,
    active_engine_probe_error: Option<&str>,
    engine_snapshot: Option<&Value>,
    desktop_debug_state: &DebugLogState,
) -> Vec<SelfDiagnosisHint> {
    let mut hints = Vec::new();

    // 1. Crash log detection (desktop or any engine dir)
    let total_crashes: usize = desktop_debug_state.crash_log_count
        + lineage.iter().map(|e| e.crash_log_count).sum::<usize>();
    if total_crashes > 0 {
        hints.push(SelfDiagnosisHint {
            severity: "error".into(),
            code: "CRASH_LOG_DETECTED".into(),
            title: format!("Detected {total_crashes} crash/panic report(s) from an earlier session"),
            detail: "A crash breadcrumb file was captured on disk and will be included in the support bundle.".into(),
            recommended_action: "Attach the generated support bundle when reporting the crash so we can inspect the panic stack and ring buffer tail.".into(),
        });
    }

    // 1b. Corrupt / unreadable database inspection errors (works for both Engine and Desktop DBs)
    for entry in lineage {
        if let Some(ref err) = entry.inspect_error {
            hints.push(SelfDiagnosisHint {
                severity: "warn".into(),
                code: "DATABASE_INSPECT_ERROR".into(),
                title: format!("Database could not be inspected cleanly in {}", entry.label),
                detail: format!("{}: {err}", entry.path),
                recommended_action: "Check file permissions or restore a backup if this database fails to open.".into(),
            });
        }
    }

    // 2. Split or unmigrated library detection (Scenario 8 & general health)
    let primary_engine = lineage.iter().find(|e| {
        e.db_exists
            && !e.label.contains("(backups/")
            && !e.label.contains("(rollback/")
            && ((windows_service_running && e.label.contains("Service"))
                || (!windows_service_running && e.label.contains("User Tray"))
                || e.label.contains("Linux Core")
                || e.label.contains("CADENCE_DATA_DIR"))
    });
    let richest_other = lineage
        .iter()
        .filter(|e| e.tracks_count.unwrap_or(0) > 0)
        .filter(|e| primary_engine.map_or(true, |p| p.path != e.path))
        .max_by_key(|e| e.tracks_count.unwrap_or(0));

    if let Some(other) = richest_other {
        let other_tracks = other.tracks_count.unwrap_or(0);
        let primary_tracks = primary_engine.and_then(|p| p.tracks_count).unwrap_or(0);
        if primary_tracks == 0 || other_tracks > primary_tracks.saturating_mul(2) {
            let active_desc = primary_engine
                .map(|p| format!("{} ({} tracks)", p.path, primary_tracks))
                .unwrap_or_else(|| "no active engine database".to_string());
            hints.push(SelfDiagnosisHint {
                severity: "warn".into(),
                code: "SPLIT_OR_UNMIGRATED_LIBRARY_DETECTED".into(),
                title: format!(
                    "Found a library with {other_tracks} tracks in {}",
                    other.label
                ),
                detail: format!(
                    "Database at '{}' has {other_tracks} tracks, while the current engine database is {active_desc}. Switching between User Tray mode and Windows Service mode changes the data directory.",
                    other.path
                ),
                recommended_action: "Verify whether Cadence is running in User Tray vs. Windows Service mode, or restore/migrate from the database containing your tracks.".into(),
            });
        }
    }

    // 3. Engine connection probe & Windows Service checks
    if !active_engine_reachable {
        let has_any_pairing = lineage.iter().any(|e| e.has_localhost_pairing);
        let err_desc = active_engine_probe_error.unwrap_or("unreachable");
        hints.push(SelfDiagnosisHint {
            severity: "error".into(),
            code: "ENGINE_NOT_REACHABLE".into(),
            title: "Playback Engine is currently unreachable from Desktop UI".into(),
            detail: format!(
                "Probe status: {err_desc}. Windows Service running: {windows_service_running}. Pairing metadata found: {has_any_pairing}."
            ),
            recommended_action: if !has_any_pairing && !windows_service_running {
                "Start the Cadence Playback Engine (system tray or Windows Service) or verify port 4040 is not blocked by another process.".into()
            } else {
                "Check Playback Engine status in Settings → Playback Engine, and verify firewall/port 4040 or re-pair if the TLS certificate changed.".into()
            },
        });
    }

    // 4. Doctor check failures / warnings
    for rep in doctor_reports {
        let dir = rep
            .get("dataDir")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if let Some(checks) = rep.get("checks").and_then(Value::as_array) {
            for check in checks {
                let status = check.get("status").and_then(Value::as_str).unwrap_or("");
                let name = check.get("name").and_then(Value::as_str).unwrap_or("");
                let detail = check.get("detail").and_then(Value::as_str).unwrap_or("");
                if status == "FAIL" {
                    hints.push(SelfDiagnosisHint {
                        severity: "error".into(),
                        code: "DOCTOR_CHECK_FAILED".into(),
                        title: format!("Engine Doctor FAIL: {name}"),
                        detail: format!("{dir}: {detail}"),
                        recommended_action: "Review the failed check detail (such as SQLite integrity or identity files) and consider restoring a pre-upgrade backup.".into(),
                    });
                } else if status == "WARN" && name == "memory_lock_limits" {
                    hints.push(SelfDiagnosisHint {
                        severity: "warn".into(),
                        code: "LOW_MEMORY_LOCK_BUDGET".into(),
                        title: "Locked memory budget is constrained".into(),
                        detail: format!("{dir}: {detail}"),
                        recommended_action: "Increase container memory limit / RLIMIT_MEMLOCK or grant CAP_IPC_LOCK on Linux.".into(),
                    });
                }
            }
        }
    }

    // 5. Enrichment & Cooldown / Gate diagnostics from live engine snapshot
    if let Some(snap) = engine_snapshot {
        let idle = snap.get("idle").and_then(Value::as_bool).unwrap_or(true);
        let activity = snap
            .get("activity")
            .and_then(Value::as_str)
            .unwrap_or("idle");
        if !idle && matches!(scenario_id, "enrichment_stuck" | "cooldown_deadlock" | "upnp_discovery_failed" | "tag_commit_stuck") {
            hints.push(SelfDiagnosisHint {
                severity: "info".into(),
                code: "AUDIO_HYGIENE_GUARD_ACTIVE".into(),
                title: format!("Audio hygiene guard active (transport: {activity})"),
                detail: "Background enrichment, folder scans, UPnP discovery, and tag writes are intentionally suspended during active/paused playback and for 30s afterward.".into(),
                recommended_action: "Stop playback and wait 30 seconds for the post-playback cooldown to clear.".into(),
            });
        }

        if let Some(enr) = snap.get("enrichment") {
            let rt_state = enr
                .get("runtimeState")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if matches!(rt_state, "disabled" | "user_paused") {
                hints.push(SelfDiagnosisHint {
                    severity: "warn".into(),
                    code: "ENRICHMENT_GATE_BLOCKED".into(),
                    title: format!("Enrichment is currently {rt_state}"),
                    detail: "Auto-enrichment will not process pending albums while disabled or user-paused.".into(),
                    recommended_action: "Resume or enable metadata enrichment in Curate / Enrichment status.".into(),
                });
            }
            if let Some(gates) = enr.get("providerGates").and_then(Value::as_array) {
                for gate in gates {
                    let circuit = gate.get("circuit").and_then(Value::as_str).unwrap_or("closed");
                    if circuit != "closed" {
                        let prov = gate.get("provider").and_then(Value::as_str).unwrap_or("provider");
                        let retry = gate.get("retryAfterSecs").and_then(Value::as_u64);
                        hints.push(SelfDiagnosisHint {
                            severity: "warn".into(),
                            code: "ENRICHMENT_PROVIDER_BREAKER_OPEN".into(),
                            title: format!("Provider circuit breaker '{circuit}' for {prov}"),
                            detail: format!(
                                "External metadata lookups to {prov} are temporarily deferred (retry_after_secs={retry:?}) due to rate limits or transient errors."
                            ),
                            recommended_action: "Wait for the backoff window to clear; check internet/DNS connectivity if errors persist.".into(),
                        });
                    }
                }
            }
        }

        // 6. SMB checks
        if scenario_id == "smb_mount_failed" {
            if let Some(smb_support) = snap.get("smb").and_then(|s| s.get("support")) {
                let supported = smb_support
                    .get("supported")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !supported {
                    let reason = smb_support
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Runtime SMB mount not supported on this host OS.");
                    hints.push(SelfDiagnosisHint {
                        severity: "info".into(),
                        code: "SMB_PLATFORM_GUIDANCE".into(),
                        title: if windows_service_running {
                            "Windows Service (Session 0) SMB drive visibility"
                        } else {
                            "Runtime SMB mount status"
                        }
                        .into(),
                        detail: if windows_service_running {
                            format!("{reason} Note: Windows Services run in Session 0 under LocalSystem and cannot see user-mapped drive letters (like Z:\\); use UNC paths (\\\\server\\share) or User Tray mode.")
                        } else {
                            reason.to_string()
                        },
                        recommended_action: if windows_service_running {
                            "Add UNC paths (\\\\NAS\\Music) with service share permissions, or switch to User Tray mode for mapped Windows drives.".into()
                        } else {
                            "On Windows, mount the share in Explorer or use a UNC path (\\\\server\\share). On Linux Core, ensure root + CAP_SYS_ADMIN + CAP_DAC_READ_SEARCH + cifs-utils.".into()
                        },
                    });
                }
            }
        }
    }

    if hints.is_empty() {
        hints.push(SelfDiagnosisHint {
            severity: "info".into(),
            code: "NO_OBVIOUS_LOCAL_FAULT".into(),
            title: "No blocking local fault detected automatically".into(),
            detail: "Database integrity, engine identity, and local configuration checks completed without fatal errors.".into(),
            recommended_action: "If you are still experiencing the issue, enable Debug Logging (or Diagnostic Capture Mode while reproducing) and submit this bundle to support.".into(),
        });
    }

    hints
}

fn should_run_engine_doctor(label: &str, dir: &Path) -> bool {
    (!label.starts_with("Desktop ") && dir.join("cadence.db").is_file())
        || dir.join("node-identity.json").is_file()
}

pub fn collect_doctor_reports(dirs: &[(String, PathBuf)]) -> Vec<Value> {
    let mut doctor_reports = Vec::new();
    for (label, dir) in dirs {
        if should_run_engine_doctor(label, dir) {
            let report = run_engine_doctor(dir, DEFAULT_CONTROL_PORT);
            let checks_json: Vec<Value> = report
                .checks
                .iter()
                .map(|c| {
                    json!({
                        "name": c.name,
                        "status": c.status.label(),
                        "detail": c.detail,
                    })
                })
                .collect();
            doctor_reports.push(json!({
                "label": label,
                "dataDir": dir.to_string_lossy(),
                "healthy": report.is_healthy(),
                "checks": checks_json,
            }));
        }
    }
    doctor_reports
}

pub fn build_support_preview(
    scenario_id: &str,
    active_engine_url: Option<&str>,
    active_engine_reachable: bool,
    active_engine_probe_error: Option<&str>,
    engine_snapshot: Option<&Value>,
) -> SupportDiagnosticsPreview {
    let scenarios = support_scenarios();
    let scenario_info = scenarios
        .iter()
        .find(|s| s.id == scenario_id)
        .cloned()
        .unwrap_or(SupportScenarioInfo {
            id: sanitize_scenario_slug(scenario_id),
            label: scenario_id.to_string(),
            description: String::new(),
        });

    let dirs = candidate_database_directories();
    let lineage = inspect_database_lineage_for_dirs(&dirs);
    let doctor_reports = collect_doctor_reports(&dirs);

    #[cfg(any(feature = "desktop", feature = "engine-audio"))]
    let windows_service_running = crate::core_runtime::windows_engine::is_windows_service_running();
    #[cfg(not(any(feature = "desktop", feature = "engine-audio")))]
    let windows_service_running = false;

    let desktop_debug_state = diagnostics::get_state();
    let hints = compute_self_diagnosis_hints(
        &scenario_info.id,
        &lineage,
        &doctor_reports,
        windows_service_running,
        active_engine_reachable,
        active_engine_probe_error,
        engine_snapshot,
        &desktop_debug_state,
    );

    let build_info = crate::build_info::current_build_info();
    let os_info = format!("{} ({})", std::env::consts::OS, std::env::consts::ARCH);
    let generated_at_utc = Utc::now().to_rfc3339();

    let mut planned_bundle_files = vec![
        "manifest.json".to_string(),
        "self-diagnosis.json".to_string(),
        "doctor-report.json".to_string(),
        "database-lineage.json".to_string(),
        "engine-snapshot.json".to_string(),
        "logs/desktop-debug.log".to_string(),
        "logs/engine-debug.log".to_string(),
    ];
    for (_, dir) in &dirs {
        if dir.join("service.log").is_file() {
            planned_bundle_files.push("logs/service.log".to_string());
            break;
        }
    }
    if desktop_debug_state.crash_log_count > 0 || lineage.iter().any(|l| l.crash_log_count > 0) {
        planned_bundle_files.push("logs/crash-*.log".to_string());
    }

    let email_subject = format!(
        "[Cadence Support] {} (v{})",
        scenario_info.label, build_info.display
    );
    let hint_lines: Vec<String> = hints
        .iter()
        .take(5)
        .map(|h| format!("- [{}] {}: {}", h.severity.to_uppercase(), h.code, h.title))
        .collect();
    let email_body = format!(
        "Issue Category: {}\nCadence Version: {}\nOS: {}\nWindows Service Running: {}\nEngine Reachable: {}\n\nSelf-Diagnosis Findings:\n{}\n\nPlease attach the generated .zip support bundle highlighted in your folder.",
        scenario_info.label,
        build_info.display,
        os_info,
        windows_service_running,
        active_engine_reachable,
        hint_lines.join("\n")
    );
    let mailto_url = format!(
        "mailto:{SUPPORT_EMAIL}?subject={}&body={}",
        percent_encode_mailto(&email_subject),
        percent_encode_mailto(&email_body)
    );

    SupportDiagnosticsPreview {
        scenario_id: scenario_info.id,
        scenario_label: scenario_info.label,
        generated_at_utc,
        support_email: SUPPORT_EMAIL.to_string(),
        desktop_version: build_info.display,
        os_info,
        windows_service_running,
        active_engine_url: active_engine_url.map(str::to_string),
        active_engine_reachable,
        active_engine_probe_error: active_engine_probe_error.map(str::to_string),
        desktop_debug_state,
        hints,
        database_lineage: lineage,
        doctor_reports,
        planned_bundle_files,
        email_subject,
        email_body,
        mailto_url,
    }
}

pub fn generate_support_bundle_to_dir(
    output_dir: &Path,
    req: SupportBundleRequest,
) -> Result<GeneratedSupportBundle, String> {
    if !req.consent_granted {
        return Err("Explicit user consent is required before packaging diagnostic data.".to_string());
    }
    let redact_paths = req.redact_paths.unwrap_or(true);
    let preview = build_support_preview(
        &req.scenario_id,
        req.active_engine_url.as_deref(),
        req.active_engine_reachable.unwrap_or(false),
        req.active_engine_probe_error.as_deref(),
        req.engine_snapshot.as_ref(),
    );

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut push_redacted = |name: String, raw: String| {
        let cleaned = redact_sensitive_text(&raw, redact_paths);
        entries.push((name, cleaned.into_bytes()));
    };

    let manifest = json!({
        "scenarioId": preview.scenario_id,
        "scenarioLabel": preview.scenario_label,
        "generatedAtUtc": preview.generated_at_utc,
        "desktopVersion": preview.desktop_version,
        "osInfo": preview.os_info,
        "windowsServiceRunning": preview.windows_service_running,
        "activeEngineUrl": preview.active_engine_url,
        "activeEngineReachable": preview.active_engine_reachable,
        "activeEngineProbeError": preview.active_engine_probe_error,
        "redactPaths": redact_paths,
        "userNotes": req.user_notes.as_deref().unwrap_or(""),
        "frontendContext": req.frontend_context.clone().unwrap_or(Value::Null),
    });
    push_redacted(
        "manifest.json".into(),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    );
    push_redacted(
        "self-diagnosis.json".into(),
        serde_json::to_string_pretty(&preview.hints).unwrap_or_default(),
    );
    push_redacted(
        "doctor-report.json".into(),
        serde_json::to_string_pretty(&preview.doctor_reports).unwrap_or_default(),
    );
    push_redacted(
        "database-lineage.json".into(),
        serde_json::to_string_pretty(&preview.database_lineage).unwrap_or_default(),
    );
    push_redacted(
        "engine-snapshot.json".into(),
        serde_json::to_string_pretty(&req.engine_snapshot.clone().unwrap_or(Value::Null))
            .unwrap_or_default(),
    );

    // Desktop logs
    let mut desktop_log = diagnostics::read_persisted_log_tail(128 * 1024);
    let recent_desktop = diagnostics::get_recent_logs();
    if !recent_desktop.is_empty() {
        desktop_log.push_str("\n--- Recent Desktop Ring Buffer ---\n");
        desktop_log.push_str(&recent_desktop.join("\n"));
    }
    push_redacted("logs/desktop-debug.log".into(), desktop_log);

    // Engine logs (prefer live engine snapshot; fallback to local candidate engine directories)
    let mut engine_log = String::new();
    if let Some(snap) = req.engine_snapshot.as_ref() {
        if let Some(tail) = snap.get("persistedLogTail").and_then(Value::as_str) {
            engine_log.push_str(tail);
        }
        if let Some(recent) = snap.get("recentLogs").and_then(Value::as_array) {
            if !recent.is_empty() {
                engine_log.push_str("\n--- Recent Engine Ring Buffer ---\n");
                for line in recent {
                    if let Some(s) = line.as_str() {
                        engine_log.push_str(s);
                        engine_log.push('\n');
                    }
                }
            }
        }
    }
    let dirs = candidate_database_directories();
    if engine_log.trim().is_empty() {
        for (label, dir) in &dirs {
            let tail = read_log_tail_from_dir(&dir.join("logs"), 64 * 1024);
            if !tail.is_empty() {
                engine_log.push_str(&format!("=== {label} ===\n{tail}\n"));
            }
        }
    }
    push_redacted("logs/engine-debug.log".into(), engine_log);

    // Service logs & crash logs
    let mut seen_crash_names = HashSet::new();
    for (idx, (_, dir)) in dirs.iter().enumerate() {
        let svc_log = dir.join("service.log");
        if svc_log.is_file() {
            if let Ok(raw) = fs::read_to_string(&svc_log) {
                let tail: String = if raw.len() > 64 * 1024 {
                    raw[raw.len() - 64 * 1024..].to_string()
                } else {
                    raw
                };
                push_redacted(format!("logs/service-{idx}.log"), tail);
            }
        }
        for crash_path in list_crash_logs(&dir.join("logs")).into_iter().take(5) {
            let fname = crash_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "crash.log".to_string());
            if seen_crash_names.insert(fname.clone()) {
                if let Ok(raw) = fs::read_to_string(&crash_path) {
                    push_redacted(format!("logs/{fname}"), raw);
                }
            }
        }
    }
    if let Some(desktop_log_dir) = diagnostics::log_dir_path() {
        for crash_path in list_crash_logs(&desktop_log_dir).into_iter().take(5) {
            let fname = crash_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "crash.log".to_string());
            if seen_crash_names.insert(fname.clone()) {
                if let Ok(raw) = fs::read_to_string(&crash_path) {
                    push_redacted(format!("logs/{fname}"), raw);
                }
            }
        }
    }

    fs::create_dir_all(output_dir)
        .map_err(|e| format!("Failed to create support bundle folder: {e}"))?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let slug = sanitize_scenario_slug(&preview.scenario_id);
    let file_name = format!("cadence-support-{stamp}-{slug}.zip");
    let zip_path = output_dir.join(&file_name);

    let files_included: Vec<String> = entries.iter().map(|(n, _)| n.clone()).collect();
    write_uncompressed_zip(&zip_path, &entries)?;
    let size_bytes = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);

    let full_email_body = if let Some(notes) = req.user_notes.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        format!("User Notes:\n{}\n\n{}", redact_sensitive_text(notes, redact_paths), preview.email_body)
    } else {
        preview.email_body.clone()
    };
    let mailto_url = format!(
        "mailto:{SUPPORT_EMAIL}?subject={}&body={}",
        percent_encode_mailto(&preview.email_subject),
        percent_encode_mailto(&full_email_body)
    );

    Ok(GeneratedSupportBundle {
        zip_path: zip_path.to_string_lossy().to_string(),
        file_name,
        size_bytes,
        files_included,
        email_to: SUPPORT_EMAIL.to_string(),
        email_subject: preview.email_subject.clone(),
        email_body: full_email_body,
        mailto_url,
        preview,
    })
}

fn validate_webhook_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Support webhook URL is empty.".to_string());
    }
    if !(trimmed.starts_with("https://")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://localhost"))
    {
        return Err("Support webhook URL must start with https://".to_string());
    }
    Ok(trimmed.to_string())
}

fn webhook_config_file_path() -> Option<PathBuf> {
    diagnostics::log_dir_path()
        .and_then(|log_dir| log_dir.parent().map(|p| p.join("support-webhook.json")))
}

pub fn resolve_support_webhook_url(explicit: Option<&str>) -> Option<(String, String)> {
    if let Some(raw) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(valid) = validate_webhook_url(raw) {
            return Some((valid, "request".to_string()));
        }
    }
    if let Ok(env_val) = std::env::var("CADENCE_SUPPORT_WEBHOOK_URL") {
        if let Ok(valid) = validate_webhook_url(&env_val) {
            return Some((valid, "env".to_string()));
        }
    }
    if let Some(path) = webhook_config_file_path() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(saved) = val.get("webhookUrl").and_then(Value::as_str) {
                    if let Ok(valid) = validate_webhook_url(saved) {
                        return Some((valid, "saved".to_string()));
                    }
                }
            }
        }
    }
    if let Some(compiled) = option_env!("CADENCE_SUPPORT_WEBHOOK_URL") {
        if let Ok(valid) = validate_webhook_url(compiled) {
            return Some((valid, "builtin".to_string()));
        }
    }
    if let Ok(valid) = validate_webhook_url(DEFAULT_SUPPORT_WEBHOOK_URL) {
        return Some((valid, "default".to_string()));
    }
    None
}

pub fn get_support_webhook_config() -> SupportWebhookConfig {
    match resolve_support_webhook_url(None) {
        Some((url, source)) => SupportWebhookConfig {
            webhook_url: Some(url),
            source,
        },
        None => SupportWebhookConfig {
            webhook_url: None,
            source: "unconfigured".to_string(),
        },
    }
}

pub fn save_support_webhook_url(url: &str) -> Result<SupportWebhookConfig, String> {
    let path = webhook_config_file_path()
        .ok_or_else(|| "Diagnostics storage path is not initialized yet.".to_string())?;
    let trimmed = url.trim();
    if trimmed.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(get_support_webhook_config());
    }
    let valid = validate_webhook_url(trimmed)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed creating config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&json!({ "webhookUrl": valid }))
        .map_err(|e| format!("Failed serializing webhook config: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed saving webhook config: {e}"))?;
    Ok(SupportWebhookConfig {
        webhook_url: Some(valid),
        source: "saved".to_string(),
    })
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = *chunk.get(1).unwrap_or(&0) as usize;
        let b2 = *chunk.get(2).unwrap_or(&0) as usize;
        out.push(TABLE[b0 >> 2] as char);
        out.push(TABLE[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((b1 & 0x0f) << 2) | (b2 >> 6)] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[b2 & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

pub async fn submit_support_bundle_to_dir(
    output_dir: &Path,
    req: SupportBundleRequest,
) -> Result<SupportSubmissionResult, String> {
    if !req.consent_granted {
        return Err("Explicit user consent is required before submitting diagnostic data.".to_string());
    }
    let (webhook_url, _) = resolve_support_webhook_url(req.webhook_url.as_deref()).ok_or_else(|| {
        "No Support Webhook URL is configured yet. Paste your Google Apps Script Web App URL in Webhook Settings first.".to_string()
    })?;

    let contact_email = req
        .contact_email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let user_notes = req.user_notes.clone().unwrap_or_default();

    let bundle = generate_support_bundle_to_dir(output_dir, req)?;
    let zip_bytes =
        fs::read(&bundle.zip_path).map_err(|e| format!("Failed reading generated zip bundle: {e}"))?;
    let zip_base64 = encode_base64(&zip_bytes);

    let short_id = uuid::Uuid::new_v4().simple().to_string();
    let default_ticket = format!(
        "CAD-{}-{}",
        Utc::now().format("%Y%m%d"),
        short_id[..4].to_ascii_uppercase()
    );

    let payload = json!({
        "ticketId": default_ticket,
        "source": "cadence-desktop",
        "scenarioId": bundle.preview.scenario_id,
        "scenarioLabel": bundle.preview.scenario_label,
        "contactEmail": contact_email,
        "userNotes": user_notes,
        "desktopVersion": bundle.preview.desktop_version,
        "osInfo": bundle.preview.os_info,
        "windowsServiceRunning": bundle.preview.windows_service_running,
        "activeEngineReachable": bundle.preview.active_engine_reachable,
        "hints": bundle.preview.hints,
        "fileName": bundle.file_name,
        "mimeType": "application/zip",
        "zipBase64": zip_base64,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed creating HTTP client: {e}"))?;
    let response = client
        .post(&webhook_url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed uploading diagnostics to webhook: {e}"))?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Support webhook returned HTTP {status}: {}",
            body_text.chars().take(200).collect::<String>()
        ));
    }

    if let Ok(resp_json) = serde_json::from_str::<Value>(&body_text) {
        if resp_json.get("ok").and_then(Value::as_bool) == Some(false) {
            let err_msg = resp_json
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Support webhook rejected submission.");
            return Err(err_msg.to_string());
        }
        let ticket_id = resp_json
            .get("ticketId")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&default_ticket)
            .to_string();
        let message = resp_json
            .get("message")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Diagnostics delivered to {SUPPORT_EMAIL} ({ticket_id})."));
        let drive_file_url = resp_json
            .get("driveFileUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string);
        return Ok(SupportSubmissionResult {
            submitted: true,
            ticket_id,
            message,
            drive_file_url,
            bundle,
        });
    }

    Ok(SupportSubmissionResult {
        submitted: true,
        ticket_id: default_ticket.clone(),
        message: format!("Diagnostics submitted to {SUPPORT_EMAIL} ({default_ticket})."),
        drive_file_url: None,
        bundle,
    })
}

fn percent_encode_mailto(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 2);
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b'\n' => out.push_str("%0D%0A"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320u32 & mask);
        }
    }
    !crc
}

/// Pure-Rust standard PKZIP writer using uncompressed STORE (method 0).
pub fn write_uncompressed_zip(dest: &Path, entries: &[(String, Vec<u8>)]) -> Result<(), String> {
    let mut file = File::create(dest).map_err(|e| format!("Failed to create zip file: {e}"))?;
    let mut central_dir = Vec::new();
    let mut offset: u32 = 0;

    for (name, data) in entries {
        let name_bytes = name.as_bytes();
        let name_len = u16::try_from(name_bytes.len())
            .map_err(|_| "Zip entry name too long".to_string())?;
        let data_len = u32::try_from(data.len())
            .map_err(|_| "Zip entry exceeds 4 GiB limit".to_string())?;
        let crc = crc32_ieee(data);

        // Local file header (30 bytes + filename)
        let mut lfh = Vec::with_capacity(30 + name_bytes.len());
        lfh.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        lfh.extend_from_slice(&20u16.to_le_bytes()); // version needed
        lfh.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        lfh.extend_from_slice(&0u16.to_le_bytes()); // method STORE
        lfh.extend_from_slice(&0u16.to_le_bytes()); // mod time
        lfh.extend_from_slice(&0x5421u16.to_le_bytes()); // mod date
        lfh.extend_from_slice(&crc.to_le_bytes());
        lfh.extend_from_slice(&data_len.to_le_bytes());
        lfh.extend_from_slice(&data_len.to_le_bytes());
        lfh.extend_from_slice(&name_len.to_le_bytes());
        lfh.extend_from_slice(&0u16.to_le_bytes()); // extra len
        lfh.extend_from_slice(name_bytes);

        file.write_all(&lfh)
            .and_then(|_| file.write_all(data))
            .map_err(|e| format!("Failed writing zip entry: {e}"))?;

        // Central directory header (46 bytes + filename)
        central_dir.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central_dir.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // method STORE
        central_dir.extend_from_slice(&0u16.to_le_bytes());
        central_dir.extend_from_slice(&0x5421u16.to_le_bytes());
        central_dir.extend_from_slice(&crc.to_le_bytes());
        central_dir.extend_from_slice(&data_len.to_le_bytes());
        central_dir.extend_from_slice(&data_len.to_le_bytes());
        central_dir.extend_from_slice(&name_len.to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // disk number
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central_dir.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central_dir.extend_from_slice(&offset.to_le_bytes());
        central_dir.extend_from_slice(name_bytes);

        offset = offset
            .checked_add(lfh.len() as u32)
            .and_then(|v| v.checked_add(data_len))
            .ok_or_else(|| "Zip archive exceeds 4 GiB offset limit".to_string())?;
    }

    let cd_offset = offset;
    let cd_size = central_dir.len() as u32;
    let count = u16::try_from(entries.len())
        .map_err(|_| "Too many entries in zip archive".to_string())?;

    file.write_all(&central_dir)
        .map_err(|e| format!("Failed writing zip central directory: {e}"))?;

    // End of central directory record (22 bytes)
    let mut eocd = Vec::with_capacity(22);
    eocd.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    eocd.extend_from_slice(&0u16.to_le_bytes());
    eocd.extend_from_slice(&0u16.to_le_bytes());
    eocd.extend_from_slice(&count.to_le_bytes());
    eocd.extend_from_slice(&count.to_le_bytes());
    eocd.extend_from_slice(&cd_size.to_le_bytes());
    eocd.extend_from_slice(&cd_offset.to_le_bytes());
    eocd.extend_from_slice(&0u16.to_le_bytes());

    file.write_all(&eocd)
        .and_then(|_| file.flush())
        .map_err(|e| format!("Failed writing zip EOCD: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cadence_support_bundle_{}_{}_{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn redactor_strips_secrets_and_os_usernames() {
        let raw = r#"{"pairingToken":"super-secret-pin","password":"my-nas-password","key":"AIzaSyDummyKey123456789012345678901234"}
x-cadence-token: abc12345
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEF
-----END PRIVATE KEY-----
path=C:\Users\TestUser\Music\album.flac"#;

        std::env::set_var("USERNAME", "TestUser");
        let redacted = redact_sensitive_text(raw, true);
        assert!(!redacted.contains("super-secret-pin"));
        assert!(!redacted.contains("my-nas-password"));
        assert!(!redacted.contains("AIzaSyDummyKey"));
        assert!(!redacted.contains("abc12345"));
        assert!(!redacted.contains("MIIEvQIBADANBgkqhkiG9w0BAQEF"));
        assert!(!redacted.contains("TestUser"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.contains("[REDACTED_PRIVATE_KEY]"));
        assert!(redacted.contains("<USER>"));
    }

    #[test]
    fn database_lineage_and_self_diagnosis_detects_split_library_after_upgrade() {
        let root = temp_dir("lineage");
        let tray_dir = root.join("tray");
        let svc_dir = root.join("svc");
        fs::create_dir_all(&tray_dir).unwrap();
        fs::create_dir_all(&svc_dir).unwrap();

        {
            let conn = Connection::open(tray_dir.join("cadence.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE tracks (id TEXT PRIMARY KEY);
                 CREATE TABLE releases (id TEXT PRIMARY KEY);
                 CREATE TABLE playlists (id TEXT PRIMARY KEY);
                 CREATE TABLE watched_folders (id TEXT PRIMARY KEY);
                 CREATE TABLE curation_drafts (album_id TEXT PRIMARY KEY);
                 INSERT INTO tracks VALUES ('t1'), ('t2'), ('t3');",
            )
            .unwrap();
        }
        {
            let conn = Connection::open(svc_dir.join("cadence.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE tracks (id TEXT PRIMARY KEY);
                 CREATE TABLE releases (id TEXT PRIMARY KEY);
                 CREATE TABLE playlists (id TEXT PRIMARY KEY);
                 CREATE TABLE watched_folders (id TEXT PRIMARY KEY);
                 CREATE TABLE curation_drafts (album_id TEXT PRIMARY KEY);",
            )
            .unwrap();
        }

        let lineage = inspect_database_lineage_for_dirs(&[
            ("Windows Engine (Default Service)".into(), svc_dir.clone()),
            ("Windows Engine (User Tray)".into(), tray_dir.clone()),
        ]);
        assert_eq!(lineage.len(), 2);
        assert_eq!(lineage[0].tracks_count, Some(0));
        assert_eq!(lineage[1].tracks_count, Some(3));

        let hints = compute_self_diagnosis_hints(
            "lost_library_after_upgrade",
            &lineage,
            &[],
            true,
            true,
            None,
            None,
            &diagnostics::get_state(),
        );
        assert!(
            hints.iter().any(|h| h.code == "SPLIT_OR_UNMIGRATED_LIBRARY_DETECTED"),
            "expected split library hint, got: {hints:?}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn consent_is_enforced_and_zip_archive_has_valid_headers() {
        let root = temp_dir("zip");
        let err = generate_support_bundle_to_dir(
            &root,
            SupportBundleRequest {
                scenario_id: "enrichment_stuck".into(),
                user_notes: None,
                contact_email: None,
                webhook_url: None,
                redact_paths: Some(true),
                consent_granted: false,
                active_engine_url: None,
                active_engine_reachable: Some(false),
                active_engine_probe_error: Some("unavailable".into()),
                engine_snapshot: None,
                frontend_context: None,
            },
        )
        .unwrap_err();
        assert!(err.contains("consent"));

        let res = generate_support_bundle_to_dir(
            &root,
            SupportBundleRequest {
                scenario_id: "enrichment_stuck".into(),
                user_notes: Some("Stuck at 40%".into()),
                contact_email: None,
                webhook_url: None,
                redact_paths: Some(true),
                consent_granted: true,
                active_engine_url: Some("https://127.0.0.1:4040".into()),
                active_engine_reachable: Some(true),
                active_engine_probe_error: None,
                engine_snapshot: Some(json!({
                    "idle": true,
                    "activity": "idle",
                    "enrichment": {
                        "runtimeState": "user_paused",
                        "providerGates": [
                            { "provider": "MusicBrainz", "circuit": "open", "retryAfterSecs": 45 }
                        ]
                    }
                })),
                frontend_context: Some(json!({ "route": "curate" })),
            },
        )
        .unwrap();

        assert_eq!(res.email_to, "matbhuvitech@gmail.com");
        assert!(res.mailto_url.starts_with("mailto:matbhuvitech@gmail.com?subject="));
        assert!(res.preview.hints.iter().any(|h| h.code == "ENRICHMENT_GATE_BLOCKED"));
        assert!(res.preview.hints.iter().any(|h| h.code == "ENRICHMENT_PROVIDER_BREAKER_OPEN"));

        let zip_bytes = fs::read(&res.zip_path).unwrap();
        assert!(zip_bytes.starts_with(b"PK\x03\x04"));
        let eocd_sig = [0x50, 0x4b, 0x05, 0x06];
        assert!(zip_bytes.windows(4).any(|w| w == eocd_sig));
        assert!(res.files_included.contains(&"manifest.json".to_string()));
        assert!(res.files_included.contains(&"self-diagnosis.json".to_string()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn desktop_appdata_db_without_node_identity_does_not_trigger_doctor_fail() {
        let root = temp_dir("desktop_appdata");
        let desktop_dir = root.join("com.cadence.core");
        fs::create_dir_all(&desktop_dir).unwrap();
        {
            let conn = Connection::open(desktop_dir.join("cadence.db")).unwrap();
            conn.execute_batch("CREATE TABLE tracks (id TEXT PRIMARY KEY);")
                .unwrap();
        }

        let dirs = vec![("Desktop AppData (com.cadence.core)".into(), desktop_dir.clone())];
        let lineage = inspect_database_lineage_for_dirs(&dirs);
        let doctor_reports = collect_doctor_reports(&dirs);
        assert!(
            doctor_reports.is_empty(),
            "desktop directory without node-identity.json should not be checked by Engine Doctor"
        );

        let hints = compute_self_diagnosis_hints(
            "engine_not_connecting",
            &lineage,
            &doctor_reports,
            false,
            true,
            None,
            None,
            &diagnostics::get_state(),
        );
        assert!(
            !hints.iter().any(|h| h.code == "DOCTOR_CHECK_FAILED"),
            "unexpected DOCTOR_CHECK_FAILED hint: {hints:?}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn submit_support_bundle_posts_base64_zip_to_webhook_and_returns_ticket_id() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let root = temp_dir("webhook_submit");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock webhook");
        let port = listener.local_addr().unwrap().port();
        let captured_body = std::sync::Arc::new(parking_lot::Mutex::new(String::new()));
        let captured_clone = std::sync::Arc::clone(&captured_body);

        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let mut expected_total: Option<usize> = None;
                let mut header_end: Option<usize> = None;
                loop {
                    let n = stream.read(&mut tmp).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if header_end.is_none() {
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let hdr = String::from_utf8_lossy(&buf[..pos]);
                            let content_len = hdr
                                .lines()
                                .find_map(|l| {
                                    let (k, v) = l.split_once(':')?;
                                    k.eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse::<usize>().ok())?
                                })
                                .unwrap_or(0);
                            header_end = Some(pos + 4);
                            expected_total = Some(pos + 4 + content_len);
                        }
                    }
                    if let Some(total) = expected_total {
                        if buf.len() >= total {
                            break;
                        }
                    }
                }
                if let Some(start) = header_end {
                    *captured_clone.lock() = String::from_utf8_lossy(&buf[start..]).to_string();
                }
                let resp_json = r#"{"ok":true,"ticketId":"CAD-TEST-9001","driveFileUrl":"https://drive.google.com/file/d/abc/view","message":"Saved & emailed"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp_json.len(),
                    resp_json
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });

        let result = submit_support_bundle_to_dir(
            &root,
            SupportBundleRequest {
                scenario_id: "engine_not_connecting".into(),
                user_notes: Some("Cannot reach local engine".into()),
                contact_email: Some("listener@example.com".into()),
                webhook_url: Some(format!("http://127.0.0.1:{port}/exec")),
                redact_paths: Some(true),
                consent_granted: true,
                active_engine_url: None,
                active_engine_reachable: Some(false),
                active_engine_probe_error: Some("unavailable".into()),
                engine_snapshot: None,
                frontend_context: None,
            },
        )
        .await
        .expect("webhook submission succeeds");

        handle.join().unwrap();
        assert!(result.submitted);
        assert_eq!(result.ticket_id, "CAD-TEST-9001");
        assert_eq!(
            result.drive_file_url.as_deref(),
            Some("https://drive.google.com/file/d/abc/view")
        );

        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(encode_base64(b"Ma"), "TWE=");
        assert_eq!(encode_base64(b"M"), "TQ==");

        let body_json: Value = serde_json::from_str(&captured_body.lock()).unwrap();
        assert_eq!(body_json["source"], "cadence-desktop");
        assert_eq!(body_json["contactEmail"], "listener@example.com");
        assert!(body_json["zipBase64"].as_str().is_some_and(|s| s.starts_with("UEsDB")));

        let _ = fs::remove_dir_all(&root);
    }
}
