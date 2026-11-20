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
    fs::write(audio_path, wav(payload)).unwrap();
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
        "INSERT OR REPLACE INTO tracks (id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, duration_secs, format, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11, 180.0, 'WAV', '2026-11-15T00:00:00Z')",
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
    fs::write(&audio_path, wav(b"AUDIO_STREAM_MODIFIED_EXTERNALLY")).unwrap();
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
    assert_eq!(cadence_core_lib::curation::tag_writer::payload_digest(&written_bytes,lofty::file::FileType::Wav).unwrap(),
        cadence_core_lib::curation::tag_writer::payload_digest(&wav(b"AUDIO_STREAM_MODIFIED_EXTERNALLY"),lofty::file::FileType::Wav).unwrap());
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
        let receipt=rt.approve_curate_draft_at("draft-gate",&report.approval_hash,"cmd-approve-1",base_time).unwrap();
        job_id=receipt.job_id.clone();
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

        // Approval rereads files and must be rejected during active playback.
        assert_eq!(rt.approve_curate_draft_at("draft-gate",&report.approval_hash,"cmd-blocked",base_time),Err(RemoteCurateError::TransportNotIdle));

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
        assert_eq!(fs::read(&audio_path).unwrap(), wav(b"PCM_FRAMES_123456"));

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

#[test]
fn curate_execute_releases_handle_avoids_blob_journal_and_prunes_orphans() {
    use cadence_core_lib::core_runtime::curate::{
        approve_draft, dry_run_draft, ensure_schema, execute_pending_jobs, get_job, save_draft,
    };

    let dir = temp_dir("handle_and_blobs");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.wav");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Before", b"WAV_AUDIO_BYTES_OK");

    let db = AppDb::new(db_path).unwrap();
    ensure_schema(&db).unwrap();

    // Seed an orphaned legacy journal BLOB for a failed job and verify ensure_schema prunes it.
    {
        let conn = db.conn.lock();
        conn.execute(
            "INSERT INTO remote_curate_jobs (job_id, draft_id, track_id, draft_revision, command_id, approval_hash, expected_file_sha256, changes_json, status, error_message)
             VALUES ('job-old-fail', 'd-old', 'trk-1', 1, 'cmd-old', 'h-old', 's-old', '[]', 'failed', 'os error 5')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO remote_curate_journal (job_id, original_bytes, result_bytes) VALUES ('job-old-fail', X'0102', X'0304')",
            [],
        ).unwrap();
    }
    ensure_schema(&db).unwrap();
    let orphan_count: i64 = db
        .conn
        .lock()
        .query_row("SELECT COUNT(*) FROM remote_curate_journal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orphan_count, 0, "orphaned failed journal BLOBs must be pruned");

    // Save -> dry-run -> approve -> execute: must succeed without writing any BLOBs to remote_curate_journal
    save_draft(
        &db,
        CurateDraftInput {
            draft_id: "draft-noblob".into(),
            track_id: "trk-1".into(),
            expected_revision: None,
            changes: vec![CurateFieldChange {
                field: "title".into(),
                before: "Before".into(),
                after: "After Clean".into(),
            }],
            updated_by: "test".into(),
        },
    )
    .unwrap();
    let report = dry_run_draft(&db, "draft-noblob", false).unwrap();
    let receipt = approve_draft(&db, "draft-noblob", &report.approval_hash, "cmd-nb-1", false).unwrap();
    let executed = execute_pending_jobs(&db, false).unwrap();
    assert_eq!(executed.len(), 1);
    assert_eq!(executed[0].status, CurateJobStatus::Verified);

    let journal_after: i64 = db
        .conn
        .lock()
        .query_row("SELECT COUNT(*) FROM remote_curate_journal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(journal_after, 0, "normal commit must NOT store huge BLOBs in remote_curate_journal");

    // Crash recovery: simulate process crashing AFTER atomic_replace updated file on disk,
    // leaving job in status='applying' with matching result_file_sha256 before SQLite commit.
    let mut next_draft = save_draft(
        &db,
        CurateDraftInput {
            draft_id: "draft-noblob".into(),
            track_id: "trk-1".into(),
            expected_revision: Some(1),
            changes: vec![CurateFieldChange {
                field: "artist".into(),
                before: "Test Artist".into(),
                after: "Recovered Artist".into(),
            }],
            updated_by: "test".into(),
        },
    )
    .unwrap();
    let _ = &mut next_draft;
    let rep2 = dry_run_draft(&db, "draft-noblob", false).unwrap();
    let rec2 = approve_draft(&db, "draft-noblob", &rep2.approval_hash, "cmd-nb-2", false).unwrap();
    let swapped = cadence_core_lib::curation::tag_writer::prepare(
        &fs::read(&audio_path).unwrap(),
        &[("artist".into(), "Recovered Artist".into())],
    )
    .unwrap();
    fs::write(&audio_path, &swapped).unwrap();
    let swapped_sha = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&swapped))
    };
    db.conn
        .lock()
        .execute(
            "UPDATE remote_curate_jobs SET status = 'applying', result_file_sha256 = ?2 WHERE job_id = ?1",
            params![rec2.job_id, swapped_sha],
        )
        .unwrap();
    let recovered = execute_pending_jobs(&db, false).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].status, CurateJobStatus::Verified);
    assert_eq!(
        get_job(&db, &receipt.job_id).unwrap().unwrap().status,
        CurateJobStatus::Verified
    );
    let db_artist: String = db
        .conn
        .lock()
        .query_row("SELECT artist_credit FROM tracks WHERE id = 'trk-1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(db_artist, "Recovered Artist");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn curate_job_worker_runs_idle_respects_playback_and_runs_when_auto_enrichment_paused() {
    use cadence_core_lib::core_runtime::curate::{
        approve_draft, dry_run_draft, get_job, save_draft, CurateJobWorker,
    };
    use cadence_core_lib::core_runtime::enrichment::gate::GateRegistry;
    use cadence_core_lib::core_runtime::enrichment::worker::EnrichmentIdleGate;

    let dir = temp_dir("curate_worker_idle");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.wav");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Original", b"WORKER_AUDIO_PAYLOAD");

    let db = AppDb::new(db_path.clone()).unwrap();
    save_draft(
        &db,
        CurateDraftInput {
            draft_id: "draft-wrk".into(),
            track_id: "trk-1".into(),
            expected_revision: None,
            changes: vec![CurateFieldChange {
                field: "title".into(),
                before: "Original".into(),
                after: "Updated By Worker".into(),
            }],
            updated_by: "test".into(),
        },
    )
    .unwrap();
    let rep = dry_run_draft(&db, "draft-wrk", false).unwrap();
    let receipt = approve_draft(&db, "draft-wrk", &rep.approval_hash, "cmd-wrk-1", false).unwrap();

    let gates = Arc::new(GateRegistry::new());
    let gate = Arc::new(EnrichmentIdleGate::new(gates));
    gate.set_cooldown_ms(120);
    // Pausing Auto-Enrichment must NOT block explicit user Commit Album jobs!
    gate.sync_config(false, true);
    gate.set_transport_active(true);

    let mut worker = CurateJobWorker::start(db_path.clone(), false, Arc::clone(&gate));
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(
        get_job(&db, &receipt.job_id).unwrap().unwrap().status,
        CurateJobStatus::ApprovedWaitingIdle,
        "worker must NOT write while playback is active"
    );

    // Stopping enters cooldown; job moves to cooling_down without mutating disk yet
    gate.set_transport_active(false);
    std::thread::sleep(Duration::from_millis(50));
    let during_cooldown = get_job(&db, &receipt.job_id).unwrap().unwrap().status;
    assert_ne!(during_cooldown, CurateJobStatus::Verified, "must defer during cooldown");

    // Once cooldown elapses, worker completes asynchronously and emits dirty + curate.updated
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if get_job(&db, &receipt.job_id).unwrap().unwrap().status == CurateJobStatus::Verified {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    assert_eq!(get_job(&db, &receipt.job_id).unwrap().unwrap().status, CurateJobStatus::Verified);
    assert!(gate.catalog_dirty_version() >= 1);
    let events = gate.take_events();
    assert!(events.iter().any(|e| e["event"] == "curate.updated"));

    worker.shutdown();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn curate_approve_uses_dry_run_stat_cache_for_large_files_and_detects_external_changes() {
    use cadence_core_lib::core_runtime::curate::{
        approve_draft, dry_run_draft, execute_pending_jobs, save_draft,
    };

    let dir = temp_dir("curate_stat_cache");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("large_track.wav");
    let big_payload = vec![0x55u8; 1_200_000];
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Large Original", &big_payload);

    let db = AppDb::new(db_path).unwrap();
    save_draft(
        &db,
        CurateDraftInput {
            draft_id: "draft-stat-1".into(),
            track_id: "trk-1".into(),
            expected_revision: None,
            changes: vec![CurateFieldChange {
                field: "title".into(),
                before: "Large Original".into(),
                after: "Large Curated".into(),
            }],
            updated_by: "test".into(),
        },
    )
    .unwrap();

    let rep = dry_run_draft(&db, "draft-stat-1", false).unwrap();
    assert!(rep.apply_available);

    let (cached_rev, cached_sha, cached_size, cached_ok): (
        Option<i64>,
        Option<String>,
        Option<i64>,
        Option<i64>,
    ) = db
        .conn
        .lock()
        .query_row(
            "SELECT dry_run_revision, dry_run_file_sha256, dry_run_file_size, dry_run_writable_ok
             FROM remote_curate_drafts WHERE draft_id = 'draft-stat-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(cached_rev, Some(1));
    assert_eq!(cached_sha.as_deref(), Some(rep.file_sha256.as_str()));
    assert_eq!(cached_size, Some(rep.file_size_bytes as i64));
    assert_eq!(cached_ok, Some(1));

    let receipt = approve_draft(&db, "draft-stat-1", &rep.approval_hash, "cmd-stat-1", false).unwrap();
    assert_eq!(receipt.status, CurateJobStatus::ApprovedWaitingIdle);

    let executed = execute_pending_jobs(&db, false).unwrap();
    assert_eq!(executed.len(), 1);
    assert_eq!(executed[0].status, CurateJobStatus::Verified);

    // Second draft: dry-run then mutate file size externally -> approve must reject ExternalFileChanged.
    save_draft(
        &db,
        CurateDraftInput {
            draft_id: "draft-stat-1".into(),
            track_id: "trk-1".into(),
            expected_revision: Some(1),
            changes: vec![CurateFieldChange {
                field: "title".into(),
                before: "Large Curated".into(),
                after: "Large Curated V2".into(),
            }],
            updated_by: "test".into(),
        },
    )
    .unwrap();
    let rep2 = dry_run_draft(&db, "draft-stat-1", false).unwrap();
    let modified_payload = vec![0x77u8; 1_250_000];
    fs::write(&audio_path, wav(&modified_payload)).unwrap();

    let err = approve_draft(&db, "draft-stat-1", &rep2.approval_hash, "cmd-stat-2", false).unwrap_err();
    assert_eq!(err, RemoteCurateError::ExternalFileChanged);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn curate_job_worker_defers_while_curate_prep_is_active_and_runs_after_settle() {
    use cadence_core_lib::core_runtime::curate::{
        approve_draft, dry_run_draft, get_job, save_draft, CurateJobWorker,
    };
    use cadence_core_lib::core_runtime::enrichment::gate::GateRegistry;
    use cadence_core_lib::core_runtime::enrichment::worker::EnrichmentIdleGate;

    let dir = temp_dir("curate_worker_prep_settle");
    let db_path = dir.join("cadence.db");
    let audio_path = dir.join("track1.wav");
    seed_track_with_audio_file(&db_path, &audio_path, "trk-1", "Before Prep", b"PREP_SETTLE_PAYLOAD");

    let db = AppDb::new(db_path.clone()).unwrap();
    save_draft(
        &db,
        CurateDraftInput {
            draft_id: "draft-prep".into(),
            track_id: "trk-1".into(),
            expected_revision: None,
            changes: vec![CurateFieldChange {
                field: "title".into(),
                before: "Before Prep".into(),
                after: "After Prep".into(),
            }],
            updated_by: "test".into(),
        },
    )
    .unwrap();
    let rep = dry_run_draft(&db, "draft-prep", false).unwrap();
    let receipt = approve_draft(&db, "draft-prep", &rep.approval_hash, "cmd-prep-1", false).unwrap();

    let gates = Arc::new(GateRegistry::new());
    let gate = Arc::new(EnrichmentIdleGate::new(gates));
    gate.begin_curate_prep();

    let mut worker = CurateJobWorker::start(db_path.clone(), false, Arc::clone(&gate));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        get_job(&db, &receipt.job_id).unwrap().unwrap().status,
        CurateJobStatus::ApprovedWaitingIdle,
        "CurateJobWorker must yield while curate.dry_run/approve prep is in flight"
    );

    gate.end_curate_prep();
    std::thread::sleep(Duration::from_millis(250));
    assert_ne!(
        get_job(&db, &receipt.job_id).unwrap().unwrap().status,
        CurateJobStatus::Verified,
        "CurateJobWorker must wait for the 1.5s post-prep settle window before writing"
    );

    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if get_job(&db, &receipt.job_id).unwrap().unwrap().status == CurateJobStatus::Verified {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        get_job(&db, &receipt.job_id).unwrap().unwrap().status,
        CurateJobStatus::Verified
    );

    worker.shutdown();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn curate_dry_run_blocks_dsd_with_clear_cache_message_without_reading_full_file() {
    use cadence_core_lib::core_runtime::curate::{dry_run_draft, save_draft};

    let dir = temp_dir("curate_dsd_block");
    let db_path = dir.join("cadence.db");
    let dsf_path = dir.join("Iduppodu Sungidi.dsf");
    seed_track_with_audio_file(&db_path, &dsf_path, "trk-dsf-1", "Iduppodu Sungidi", b"DSD");
    fs::write(&dsf_path, b"DSD_RAW_HEADER_ONLY").unwrap();

    let db = AppDb::new(db_path).unwrap();
    save_draft(
        &db,
        CurateDraftInput {
            draft_id: "draft-dsf".into(),
            track_id: "trk-dsf-1".into(),
            expected_revision: None,
            changes: vec![CurateFieldChange {
                field: "album".into(),
                before: "Aalukkoru Aasai".into(),
                after: "Aalukkoru Aasai (Original Motion Picture Soundtrack) - EP".into(),
            }],
            updated_by: "test".into(),
        },
    )
    .unwrap();

    let report = dry_run_draft(&db, "draft-dsf", false).unwrap();
    assert!(!report.apply_available);
    let reason = report.block_reason.as_deref().unwrap_or("");
    assert!(
        reason.contains("DSD") && reason.contains("Save to Cache"),
        "expected clear DSD / Save to Cache guidance, got: {reason}"
    );
    assert_eq!(report.file_size_bytes, b"DSD_RAW_HEADER_ONLY".len() as u64);

    let _ = fs::remove_dir_all(&dir);
}

fn wav(payload:&[u8])->Vec<u8>{
    let mut data=b"RIFF".to_vec();
    let padded=payload.len()+payload.len()%2;
    data.extend_from_slice(&(36u32+padded as u32).to_le_bytes());
    data.extend_from_slice(b"WAVEfmt ");data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&44100u32.to_le_bytes());data.extend_from_slice(&88200u32.to_le_bytes());
    data.extend_from_slice(&2u16.to_le_bytes());data.extend_from_slice(&16u16.to_le_bytes());
    data.extend_from_slice(b"data");data.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    data.extend_from_slice(payload);if payload.len()%2!=0{data.push(0);}data
}
