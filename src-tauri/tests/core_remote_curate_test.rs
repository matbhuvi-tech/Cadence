use cadence_core_lib::core_runtime::curate::{
    assert_local_worker_can_write_root, CurateDraftInput, CurateFieldChange, CurateJobStatus,
    RemoteCurateError,
};
use cadence_core_lib::core_runtime::{HeadlessConfig, HeadlessCoreRuntime, COOLDOWN_DURATION};
use cadence_core_lib::core_session::{Output, Renderer, RendererAction, RendererError};
use cadence_core_lib::db::AppDb;
use rusqlite::params;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
struct FakeRenderer {
    actions: Arc<Mutex<Vec<RendererAction>>>,
}

impl Renderer for FakeRenderer {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        self.actions.lock().unwrap().push(action.clone());
        Ok(())
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cadence_phase8_{}_{}",
        name,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn seed_track_with_audio_file(
    db_path: &Path,
    audio_path: &Path,
    track_id: &str,
    title: &str,
    payload: &[u8],
) {
    fs::write(audio_path, payload).unwrap();
    let db = AppDb::new(db_path.to_path_buf()).unwrap();
    let conn = db.conn.lock();
    let folder_str = audio_path.parent().unwrap().to_string_lossy().to_string();
    let file_name = audio_path.file_name().unwrap().to_string_lossy().to_string();
    conn.execute(
        "INSERT OR REPLACE INTO storage_mounts (id, name, mount_path, mount_type, file_system, last_seen_timestamp) VALUES (?1, ?2, ?3, 'local_disk', 'ext4', '2026-11-15T00:00:00Z')",
        params!["mnt-1", "Test Mount", &folder_str],
    )
    .unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO releases (id, title, folder_path, folder_name, artist_credit, created_at) VALUES (?1, ?2, ?3, ?4, ?5, '2026-11-15T00:00:00Z')",
        params!["rel-1", "Test Album", &folder_str, "Test Album", "Test Artist"],
    )
    .unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11, 180.0, 'FLAC', '2026-11-15T00:00:00Z')",
        params![
            track_id,
            "rel-1",
            "mnt-1",
            &folder_str,
            "Test Album",
            audio_path.to_string_lossy().to_string(),
            &file_name,
            payload.len() as i64,
            title,
            "Test Artist",
            "Test Album"
        ],
    )
    .unwrap();
}

fn make_config(db_path: PathBuf) -> HeadlessConfig {
    HeadlessConfig {
        db_path,
        engine_id: "core-truenas-1".to_string(),
        library_id: "lib-1".to_string(),
        label: "Music Room Core".to_string(),
        output: Some(Output {
            id: "rs130".to_string(),
            label: "HiFi ROSE RS130".to_string(),
            transport: "upnp".to_string(),
        }),
        headroom_bytes: 0,
    }
}

#[test]
fn draft_durability_and_optimistic_revision_conflict() {
    let dir = temp_dir("draft_conflict");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.bin");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Original Title", b"AUDIO_PAYLOAD_V1");

    {
        let mut rt = HeadlessCoreRuntime::open(make_config(db_path.clone()), FakeRenderer::default()).unwrap();
        let saved = rt
            .save_curate_draft(CurateDraftInput {
                draft_id: "draft-1".into(),
                track_id: "trk-1".into(),
                expected_revision: None,
                changes: vec![CurateFieldChange {
                    field: "title".into(),
                    before: "Original Title".into(),
                    after: "Updated Title".into(),
                }],
                updated_by: "windows-controller".into(),
            })
            .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.status, CurateJobStatus::DraftSaved);

        // Stale expected_revision = Some(0) must be rejected without overwriting
        let conflict = rt.save_curate_draft(CurateDraftInput {
            draft_id: "draft-1".into(),
            track_id: "trk-1".into(),
            expected_revision: Some(0),
            changes: vec![CurateFieldChange {
                field: "title".into(),
                before: "Original Title".into(),
                after: "Stale Overwrite".into(),
            }],
            updated_by: "other-controller".into(),
        });
        assert_eq!(conflict, Err(RemoteCurateError::RevisionConflict));
        rt.shutdown().unwrap();
    }

    // Reopen runtime and verify draft survived restart
    let mut rt2 = HeadlessCoreRuntime::open(make_config(db_path), FakeRenderer::default()).unwrap();
    let report = rt2.dry_run_curate_draft_at("draft-1", Instant::now()).unwrap();
    assert_eq!(report.draft_revision, 1);
    assert_eq!(report.changes[0].after, "Updated Title");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_only_root_allows_drafts_and_dry_run_but_blocks_apply_clearly() {
    let dir = temp_dir("read_only");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.bin");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Title A", b"AUDIO_PAYLOAD_RO");

    let mut rt = HeadlessCoreRuntime::open(make_config(db_path), FakeRenderer::default()).unwrap();
    rt.set_music_read_only(true);

    rt.save_curate_draft(CurateDraftInput {
        draft_id: "draft-ro".into(),
        track_id: "trk-1".into(),
        expected_revision: None,
        changes: vec![CurateFieldChange {
            field: "title".into(),
            before: "Title A".into(),
            after: "Title B".into(),
        }],
        updated_by: "windows".into(),
    })
    .unwrap();

    let report = rt.dry_run_curate_draft_at("draft-ro", Instant::now()).unwrap();
    assert!(report.read_only);
    assert!(!report.apply_available);
    assert!(report.block_reason.as_deref().unwrap_or("").contains("read-only"));

    let approve_err = rt.approve_curate_draft_at("draft-ro", &report.approval_hash, "cmd-ro-1", Instant::now());
    assert!(matches!(approve_err, Err(RemoteCurateError::ReadOnlyRoot(_))));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn immutable_approval_duplicate_commit_and_external_file_change_rejection() {
    let dir = temp_dir("immutable_approval");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.bin");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Title A", b"AUDIO_STREAM_DATA");

    let mut rt = HeadlessCoreRuntime::open(make_config(db_path), FakeRenderer::default()).unwrap();
    rt.register_writable_root(&dir).unwrap();
    rt.set_music_read_only(false);

    rt.save_curate_draft(CurateDraftInput {
        draft_id: "draft-imm".into(),
        track_id: "trk-1".into(),
        expected_revision: None,
        changes: vec![CurateFieldChange {
            field: "title".into(),
            before: "Title A".into(),
            after: "Title B".into(),
        }],
        updated_by: "windows".into(),
    })
    .unwrap();

    let report = rt.dry_run_curate_draft_at("draft-imm", Instant::now()).unwrap();
    assert!(report.apply_available);

    // Wrong approval hash rejected
    let wrong_hash = rt.approve_curate_draft_at("draft-imm", "wrong-hash", "cmd-1", Instant::now());
    assert_eq!(wrong_hash, Err(RemoteCurateError::RevisionConflict));

    // Simulate external file modification between dry-run and approval
    fs::write(&audio_path, b"AUDIO_STREAM_MODIFIED_EXTERNALLY").unwrap();
    let changed_err = rt.approve_curate_draft_at("draft-imm", &report.approval_hash, "cmd-2", Instant::now());
    assert_eq!(changed_err, Err(RemoteCurateError::ExternalFileChanged));

    // Re-run dry-run against current file contents -> approve -> verify -> duplicate commit rejected
    let report2 = rt.dry_run_curate_draft_at("draft-imm", Instant::now()).unwrap();
    let receipt = rt
        .approve_curate_draft_at("draft-imm", &report2.approval_hash, "cmd-3", Instant::now())
        .unwrap();
    assert_eq!(receipt.status, CurateJobStatus::ApprovedWaitingIdle);

    let executed = rt.execute_pending_curate_jobs_at(Instant::now()).unwrap();
    assert_eq!(executed.len(), 1);
    assert_eq!(executed[0].status, CurateJobStatus::Verified);

    // Duplicate commit of already-approved/verified change set is rejected
    let dup = rt.approve_curate_draft_at("draft-imm", &report2.approval_hash, "cmd-4", Instant::now());
    assert_eq!(dup, Err(RemoteCurateError::DuplicateApproval));

    // Verify original audio stream bytes are preserved intact
    let written_bytes = fs::read(&audio_path).unwrap();
    assert!(written_bytes.starts_with(b"AUDIO_STREAM_MODIFIED_EXTERNALLY"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn playback_and_cooldown_gates_defer_disk_writes_and_recover_across_restart() {
    let dir = temp_dir("playback_cooldown");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.bin");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Before", b"PCM_FRAMES_123456");

    let base_time = Instant::now();
    let job_id: String;
    {
        let mut rt = HeadlessCoreRuntime::open(make_config(db_path.clone()), FakeRenderer::default()).unwrap();
        rt.register_writable_root(&dir).unwrap();
        rt.set_music_read_only(false);

        rt.save_curate_draft(CurateDraftInput {
            draft_id: "draft-gate".into(),
            track_id: "trk-1".into(),
            expected_revision: None,
            changes: vec![CurateFieldChange {
                field: "title".into(),
                before: "Before".into(),
                after: "After".into(),
            }],
            updated_by: "windows".into(),
        })
        .unwrap();

        let report = rt.dry_run_curate_draft_at("draft-gate", base_time).unwrap();
        // Start playback via /v1/core (admit first)
        rt.admit_tracks(&["trk-1".to_string()]).unwrap();
        let play_req = json!({
            "protocolVersion": 1,
            "engineId": "core-truenas-1",
            "libraryId": "lib-1",
            "operation": "playback.control",
            "commandId": "cmd-play-1",
            "expectedRevision": 0,
            "action": "play",
            "trackId": "trk-1"
        });
        let play_resp = rt.request_at(&serde_json::to_vec(&play_req).unwrap(), base_time);
        assert_eq!(play_resp["ok"], true);

        // Dry-run during active playback must be blocked by storage-bus silence
        assert_eq!(
            rt.dry_run_curate_draft_at("draft-gate", base_time),
            Err(RemoteCurateError::TransportNotIdle)
        );

        // Approval while playing is queued durably as ApprovedWaitingIdle without touching disk
        let receipt = rt
            .approve_curate_draft_at("draft-gate", &report.approval_hash, "cmd-approve-1", base_time)
            .unwrap();
        assert_eq!(receipt.status, CurateJobStatus::ApprovedWaitingIdle);
        job_id = receipt.job_id.clone();

        // Executing while playing defers cleanly
        let deferred = rt.execute_pending_curate_jobs_at(base_time).unwrap();
        assert_eq!(deferred[0].status, CurateJobStatus::ApprovedWaitingIdle);

        // Stop playback -> enters 30s cooldown
        let stop_time = base_time + Duration::from_secs(5);
        let stop_req = json!({
            "protocolVersion": 1,
            "engineId": "core-truenas-1",
            "libraryId": "lib-1",
            "operation": "playback.control",
            "commandId": "cmd-stop-1",
            "expectedRevision": 1,
            "action": "stop"
        });
        let stop_resp = rt.request_at(&serde_json::to_vec(&stop_req).unwrap(), stop_time);
        assert_eq!(stop_resp["ok"], true);

        // 10s after stop (< 30s cooldown) -> CoolingDown, no disk mutation yet
        let cooling = rt
            .execute_pending_curate_jobs_at(stop_time + Duration::from_secs(10))
            .unwrap();
        assert_eq!(cooling[0].status, CurateJobStatus::CoolingDown);
        assert_eq!(fs::read(&audio_path).unwrap(), b"PCM_FRAMES_123456");

        rt.shutdown().unwrap();
    }

    // Restart Core when idle & outside cooldown -> durable job resumes and completes Verified
    let mut rt2 = HeadlessCoreRuntime::open(make_config(db_path), FakeRenderer::default()).unwrap();
    rt2.set_music_read_only(false);
    let pending_before = rt2.get_curate_job(&job_id).unwrap().unwrap();
    assert!(matches!(
        pending_before.status,
        CurateJobStatus::ApprovedWaitingIdle | CurateJobStatus::CoolingDown
    ));

    let executed = rt2
        .execute_pending_curate_jobs_at(base_time + COOLDOWN_DURATION + Duration::from_secs(10))
        .unwrap();
    assert_eq!(executed.len(), 1);
    assert_eq!(executed[0].status, CurateJobStatus::Verified);

    // Executing again must NOT replay the already-verified job
    let replay = rt2
        .execute_pending_curate_jobs_at(base_time + COOLDOWN_DURATION + Duration::from_secs(20))
        .unwrap();
    assert!(replay.is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn shared_root_writer_exclusion_blocks_standalone_worker_on_core_leased_root() {
    let dir = temp_dir("writer_exclusion");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.bin");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Before", b"AUDIO_BYTES");

    let mut rt = HeadlessCoreRuntime::open(make_config(db_path.clone()), FakeRenderer::default()).unwrap();
    let lease = rt.register_writable_root(&dir).unwrap();
    assert_eq!(lease.engine_id, "core-truenas-1");
    rt.shutdown().unwrap();

    // Standalone Windows commit worker checking the DB lease for this root must be blocked
    let db = AppDb::new(db_path).unwrap();
    let check = assert_local_worker_can_write_root(&db, &dir, "windows-local");
    assert!(matches!(check, Err(RemoteCurateError::RootLeasedByOtherWriter(_))));

    // Core owner itself is permitted
    assert!(assert_local_worker_can_write_root(&db, &dir, "core-truenas-1").is_ok());
    let _ = fs::remove_dir_all(&dir);
}
