use super::artwork_worker::{
    build_override_candidate_urls, handle_retry_budget, process_album_artwork_item,
    ArtworkProcessOutcome,
};
use super::gate::{GateOutcome, GateRegistry, BREAKER_PROBE_AFTER, BREAKER_RECOVERIES, BREAKER_THRESHOLD};
use super::image_store::ImageStore;
use super::matcher::{
    assign_tracks, evaluate_album_candidates, string_dist, CandidateAlbum, CandidateTrack,
    LocalAlbum, LocalTrack, MatchOutcome, VetoCode,
};
use super::providers::{BoxFuture, ExternalArtworkProvider, MetadataProvider, ProviderError};
use super::schema::{
    accept_album_proposal, apply_user_overlay, compute_enrichment_status, ensure_schema,
    get_enrichment_album_detail, record_file_commit_for_tracks, revert_album_to_file_tags,
    seed_pending_albums_and_artwork, unlock_album_for_enrichment,
};
use super::worker::{
    next_user_override_artwork_item, process_text_enrichment_album, EnrichmentIdleGate,
    EnrichmentWorker, EnrichmentWorkerConfig,
};
use crate::core_runtime::{derive_clean_edition, HeadlessConfig, HeadlessCoreRuntime};
use crate::core_session::{Renderer, RendererAction, RendererError};
use crate::db::AppDb;
use image::{ImageFormat, Rgb, RgbImage};
use rusqlite::params;
use serde_json::{json, Map};
use std::collections::HashSet;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

struct DummyRenderer;
impl Renderer for DummyRenderer {
    fn apply(&mut self, _action: &RendererAction) -> Result<(), RendererError> {
        Ok(())
    }
}

fn make_png_bytes(w: u32, h: u32, color: [u8; 3]) -> Vec<u8> {
    let img = RgbImage::from_pixel(w, h, Rgb(color));
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
    out
}

fn temp_dir(prefix: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn sample_local_track(id: &str, idx: u32, title: &str, artist: &str, dur: f64) -> LocalTrack {
    LocalTrack {
        track_id: id.to_string(),
        title: title.to_string(),
        artist: artist.to_string(),
        album_artist: None,
        track_number: Some(idx),
        disc_number: Some(1),
        duration_secs: dur,
        release_year: Some(1992),
        mb_recording_id: None,
        original_album: None,
        is_compilation: false,
        locked_fields: HashSet::new(),
    }
}

fn sample_cand_track(idx: u32, title: &str, artist: &str, dur: f64) -> CandidateTrack {
    CandidateTrack {
        track_id: Some(format!("mb-rec-{idx}")),
        title: title.to_string(),
        artist: artist.to_string(),
        index: idx,
        medium_index: idx,
        medium: 1,
        duration_secs: Some(dur),
    }
}

#[test]
fn beets_string_dist_preserves_unicode_and_normalizes_articles() {
    assert_eq!(string_dist(Some("Dark Side of the Moon, The"), Some("The Dark Side of the Moon")), 0.0);
    assert_eq!(string_dist(Some("Simon & Garfunkel"), Some("Simon and Garfunkel")), 0.0);

    // Tamil script should NOT collapse to empty strings (unlike pure ASCII unidecode)
    let d_same = string_dist(Some("இளையராஜா"), Some("இளையராஜா"));
    let d_diff = string_dist(Some("இளையராஜா"), Some("ரகுமான்"));
    assert_eq!(d_same, 0.0);
    assert!(d_diff > 0.7, "distinct Tamil names must stay distant: {d_diff}");

    // Minor parenthetical suffix has reduced Beets penalty
    let d_ep = string_dist(Some("Roja (CD Rip)"), Some("Roja"));
    assert!(d_ep < 0.35 && d_ep > 0.0, "d_ep={d_ep}");
}

#[test]
fn hungarian_assign_tracks_recovers_swapped_track_order() {
    let locals = vec![
        sample_local_track("t1", 2, "Pudhu Vellai Mazhai", "Sujatha", 315.0),
        sample_local_track("t2", 1, "Chinna Chinna Aasai", "Minmini", 295.0),
    ];
    let cands = vec![
        sample_cand_track(1, "Chinna Chinna Aasai", "Minmini", 295.0),
        sample_cand_track(2, "Pudhu Vellai Mazhai", "Sujatha", 315.0),
    ];
    let (pairs, extra_l, extra_c) = assign_tracks(&locals, &cands, true);
    assert!(extra_l.is_empty() && extra_c.is_empty());
    assert_eq!(pairs[0].0, 0);
    assert_eq!(pairs[0].1, 1);
    assert_eq!(pairs[1].0, 1);
    assert_eq!(pairs[1].1, 0);
}

#[test]
fn asymmetric_thresholds_strict_overwrite_vs_relaxed_missing_fill() {
    // 1. Existing non-empty album title with noticeable divergence on small album stays NeedsReview (> 0.05)
    let local_existing = LocalAlbum {
        release_id: "rel1".into(),
        title: "Roja OST Deluxe".into(),
        artist: "A. R. Rahman".into(),
        year: Some(1992),
        is_compilation: false,
        discs_total: 1,
        locked_release_fields: HashSet::new(),
        album_locked: false,
        tracks: vec![
            sample_local_track("t1", 1, "Chinna Chinna Aasai", "Minmini", 295.0),
            sample_local_track("t2", 2, "Rukkumani Rukkumani", "S. P. Balasubrahmanyam", 360.0),
        ],
    };
    let cand = CandidateAlbum {
        provider: "musicbrainz".into(),
        external_release_id: "mb-1".into(),
        album: "Roja".into(),
        artist: "A. R. Rahman".into(),
        is_va: false,
        year: Some(1992),
        original_year: Some(1992),
        mediums: 1,
        composer: None,
        genre: None,
        artwork_url: None,
        tracks: vec![
            sample_cand_track(1, "Chinna Chinna Aasai", "Minmini", 295.0),
            sample_cand_track(2, "Rukkumani Rukkumani", "S. P. Balasubrahmanyam", 360.0),
        ],
    };
    let eval_strict = evaluate_album_candidates(&local_existing, std::slice::from_ref(&cand));
    assert_eq!(eval_strict.outcome, MatchOutcome::NeedsReview);
    assert!(eval_strict.distance > 0.05);

    // 2. Same album with MISSING metadata ("Unknown Album" / "Unknown Artist") auto-fills under relaxed threshold
    let local_missing = LocalAlbum {
        release_id: "rel2".into(),
        title: "Unknown Album".into(),
        artist: "Unknown Artist".into(),
        year: None,
        is_compilation: false,
        discs_total: 1,
        locked_release_fields: HashSet::new(),
        album_locked: false,
        tracks: vec![
            sample_local_track("t1", 1, "Chinna Chinna Aasai", "Unknown Artist", 295.0),
            sample_local_track("t2", 2, "Rukkumani Rukkumani", "Unknown Artist", 360.0),
        ],
    };
    let eval_missing = evaluate_album_candidates(&local_missing, &[cand]);
    assert_eq!(eval_missing.outcome, MatchOutcome::AutoApply);
    let prop = eval_missing.proposal.unwrap();
    assert!(prop.auto_apply_release_fields.contains(&"album".to_string()));
    assert!(prop.auto_apply_release_fields.contains(&"album_artist".to_string()));
    assert!(prop.tracks.iter().all(|t| t.auto_apply_fields.contains(&"track_artist".to_string())));
}

#[test]
fn hard_safety_vetoes_block_unsafe_matches() {
    let base_local = LocalAlbum {
        release_id: "rel".into(),
        title: "Roja".into(),
        artist: "A. R. Rahman".into(),
        year: Some(1992),
        is_compilation: false,
        discs_total: 1,
        locked_release_fields: HashSet::new(),
        album_locked: false,
        tracks: vec![
            sample_local_track("t1", 1, "Chinna Chinna Aasai", "Minmini", 295.0),
            sample_local_track("t2", 2, "Pudhu Vellai Mazhai", "Sujatha", 315.0),
        ],
    };
    let base_cand = CandidateAlbum {
        provider: "musicbrainz".into(),
        external_release_id: "mb-1".into(),
        album: "Roja".into(),
        artist: "A. R. Rahman".into(),
        is_va: false,
        year: Some(1992),
        original_year: Some(1992),
        mediums: 1,
        composer: None,
        genre: None,
        artwork_url: None,
        tracks: vec![
            sample_cand_track(1, "Chinna Chinna Aasai", "Minmini", 295.0),
            sample_cand_track(2, "Pudhu Vellai Mazhai", "Sujatha", 315.0),
        ],
    };

    // 1. TrackCountMismatch
    let mut c_count = base_cand.clone();
    c_count.tracks.push(sample_cand_track(3, "Kaadhal Rojave", "S. P. Balasubrahmanyam", 300.0));
    let ev1 = evaluate_album_candidates(&base_local, &[c_count]);
    assert_eq!(ev1.outcome, MatchOutcome::NeedsReview);
    assert!(ev1.vetoes.iter().any(|v| v.code == VetoCode::TrackCountMismatch));

    // 2. DurationMismatch (>15s diff)
    let mut c_dur = base_cand.clone();
    c_dur.tracks[0].duration_secs = Some(330.0);
    let ev2 = evaluate_album_candidates(&base_local, &[c_dur]);
    assert!(ev2.vetoes.iter().any(|v| v.code == VetoCode::DurationMismatch));

    // 3. AmbiguousRunnerUp
    let mut c_ru = base_cand.clone();
    c_ru.external_release_id = "mb-2".into();
    c_ru.album = "Roja (Special Collectors Pressing)".into();
    let ev3 = evaluate_album_candidates(&base_local, &[base_cand.clone(), c_ru]);
    assert!(ev3.vetoes.iter().any(|v| v.code == VetoCode::AmbiguousRunnerUp));

    // 4. CompilationOrVaFlip
    let mut c_va = base_cand.clone();
    c_va.is_va = true;
    let ev4 = evaluate_album_candidates(&base_local, &[c_va]);
    assert!(ev4.vetoes.iter().any(|v| v.code == VetoCode::CompilationOrVaFlip));

    // 5. DestructiveOrEmptyReplacement
    let mut c_empty = base_cand.clone();
    c_empty.artist = "Unknown Artist".into();
    let ev5 = evaluate_album_candidates(&base_local, &[c_empty]);
    assert!(ev5.vetoes.iter().any(|v| v.code == VetoCode::DestructiveOrEmptyReplacement));

    // 6. SevereTextDivergence
    let mut c_div = base_cand.clone();
    c_div.album = "Completely Unrelated Symphony".into();
    c_div.artist = "Beethoven".into();
    let ev6 = evaluate_album_candidates(&base_local, &[c_div]);
    assert!(ev6.vetoes.iter().any(|v| v.code == VetoCode::SevereTextDivergence));

    // 7. UserHistoryLocked
    let mut l_locked = base_local;
    l_locked.album_locked = true;
    let ev7 = evaluate_album_candidates(&l_locked, &[base_cand]);
    assert!(ev7.vetoes.iter().any(|v| v.code == VetoCode::UserHistoryLocked));
}

#[test]
fn navidrome_circuit_breaker_and_image_store_guards() {
    let reg = GateRegistry::new();
    let t0 = Instant::now();
    for _ in 0..BREAKER_THRESHOLD {
        let (_, gen) = reg.try_acquire_at("musicbrainz", t0).unwrap();
        reg.record_at("musicbrainz", gen, GateOutcome::TransientError, t0);
    }
    // Circuit must now be open
    assert!(reg.try_acquire_at("musicbrainz", t0 + Duration::from_secs(5)).is_err());

    // After probe window, requires 3 consecutive recoveries in current generation
    let t_probe = t0 + BREAKER_PROBE_AFTER + Duration::from_secs(1);
    for i in 0..BREAKER_RECOVERIES {
        let t = t_probe + Duration::from_secs(i as u64 * 2);
        let (_, gen) = reg.try_acquire_at("musicbrainz", t).unwrap();
        assert!(gen > 0);
        reg.record_at("musicbrainz", gen, GateOutcome::Success, t);
        if i + 1 < BREAKER_RECOVERIES {
            // Still probing until 3 consecutive recoveries
            let snap = reg.snapshot();
            assert_ne!(snap.into_iter().find(|s| s.provider == "musicbrainz").unwrap().circuit, "closed");
        }
    }
    // Closed again
    let (_, gen_after) = reg
        .try_acquire_at("musicbrainz", t_probe + Duration::from_secs(20))
        .unwrap();
    assert_eq!(gen_after, 0);

    // ImageStore content-addressed write & invalid payload guard
    let dir = temp_dir("cadence-imgstore");
    let store = ImageStore::new(dir.join("artwork"));
    let png = make_png_bytes(640, 640, [10, 120, 220]);
    let meta = store.store_bytes(&png).unwrap();
    assert_eq!(meta.width, 640);
    assert_eq!(meta.height, 640);
    assert_eq!(store.open_bytes(&meta.hash, &meta.mime).unwrap(), png);
    assert!(store.store_bytes(b"not-an-image").is_err());
    assert!(store.path_for("../bad", "image/jpeg").is_err());
}

struct MockMetadataProvider {
    cands: Vec<CandidateAlbum>,
    calls: Arc<AtomicUsize>,
    delay: Duration,
}

impl MetadataProvider for MockMetadataProvider {
    fn name(&self) -> &'static str {
        "musicbrainz"
    }

    fn lookup_album<'a>(
        &'a self,
        _local: &'a LocalAlbum,
        cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<Vec<CandidateAlbum>, ProviderError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::select! {
                    biased;
                    _ = cancel.notified() => return Err(ProviderError::Cancelled),
                    _ = tokio::time::sleep(self.delay) => {}
                }
            }
            Ok(self.cands.clone())
        })
    }
}

struct MockArtworkProvider {
    bytes: Vec<u8>,
}

impl ExternalArtworkProvider for MockArtworkProvider {
    fn name(&self) -> &'static str {
        "coverartarchive"
    }

    fn fetch_album_cover<'a>(
        &'a self,
        _local: &'a LocalAlbum,
        _mb_release_id: Option<&'a str>,
        _hint: Option<&'a str>,
        _cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String), ProviderError>> {
        Box::pin(async move { Ok((self.bytes.clone(), "coverartarchive".to_string())) })
    }

    fn fetch_artist_portrait<'a>(
        &'a self,
        _artist_name: &'a str,
        _cancel: &'a Notify,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String), ProviderError>> {
        Box::pin(async move { Err(ProviderError::NotFound) })
    }
}

#[test]
fn live_overlay_curate_backlog_sync_user_history_and_watched_root_progress() {
    let dir = temp_dir("cadence-enrichment-e2e");
    let db_path = dir.join("cadence.db");
    let music_a = dir.join("MusicA");
    let music_b = dir.join("MusicB");
    let alb1_dir = music_a.join("Roja [CD Rip]");
    let alb2_dir = music_a.join("PendingAlbum");
    let alb3_dir = music_b.join("JazzAlbum");
    std::fs::create_dir_all(&alb1_dir).unwrap();
    std::fs::create_dir_all(&alb2_dir).unwrap();
    std::fs::create_dir_all(&alb3_dir).unwrap();

    // Seed low-res 200x200 folder cover in alb1_dir so Navidrome upgrades it to 1000x1000 external!
    std::fs::write(alb1_dir.join("cover.png"), make_png_bytes(200, 200, [255, 0, 0])).unwrap();

    let db = AppDb::new(db_path.clone()).unwrap();
    {
        let conn = db.conn.lock();
        ensure_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS engine_artwork (release_id TEXT PRIMARY KEY, etag TEXT NOT NULL, jpeg BLOB NOT NULL);",
        )
        .unwrap();

        conn.execute(
            "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m1','RootA',?1,'local','ntfs',CURRENT_TIMESTAMP)",
            params![music_a.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m2','RootB',?1,'local','ntfs',CURRENT_TIMESTAMP)",
            params![music_b.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO watched_folders(id,mount_id,folder_path,display_name,scan_mode) VALUES('wf_a','m1',?1,'Root A','manual')",
            params![music_a.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO watched_folders(id,mount_id,folder_path,display_name,scan_mode) VALUES('wf_b','m2',?1,'Root B','manual')",
            params![music_b.to_string_lossy()],
        ).unwrap();

        // Release 1: dirty title "Roja [CD Rip]", missing artist, no embedded art
        conn.execute(
            "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('rel_1','Roja [CD Rip]',?1,'Roja [CD Rip]','Unknown Artist',CURRENT_TIMESTAMP)",
            params![alb1_dir.to_string_lossy()],
        ).unwrap();
        for (idx, tid, title) in [(1, "t1", "Chinna Chinna Aasai"), (2, "t2", "Pudhu Vellai Mazhai"), (3, "t3", "Kaadhal Rojave")] {
            conn.execute(
                "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,has_embedded_art,created_at)
                 VALUES(?1,'rel_1','m1',?2,'Roja [CD Rip]',?3,'t.flac',1000,1,?4,'Unknown Artist','Roja [CD Rip]',?5,1,300.0,'FLAC',0,CURRENT_TIMESTAMP)",
                params![tid, alb1_dir.to_string_lossy(), alb1_dir.join(format!("{tid}.flac")).to_string_lossy(), title, idx],
            ).unwrap();
        }

        // Release 2 under Root A (stays pending)
        conn.execute(
            "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('rel_2','Pending',?1,'Pending','Artist2',CURRENT_TIMESTAMP)",
            params![alb2_dir.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,has_embedded_art,created_at)
             VALUES('t4','rel_2','m1',?1,'Pending',?2,'t4.flac',1000,1,'Song 4','Artist2','Pending',1,1,200.0,'FLAC',0,CURRENT_TIMESTAMP)",
            params![alb2_dir.to_string_lossy(), alb2_dir.join("t4.flac").to_string_lossy()],
        ).unwrap();

        // Release 3 under Root B (needs_review)
        conn.execute(
            "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('rel_3','Jazz',?1,'Jazz','Miles',CURRENT_TIMESTAMP)",
            params![alb3_dir.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,has_embedded_art,created_at)
             VALUES('t5','rel_3','m2',?1,'Jazz',?2,'t5.flac',1000,1,'So What','Miles','Jazz',1,1,540.0,'FLAC',0,CURRENT_TIMESTAMP)",
            params![alb3_dir.to_string_lossy(), alb3_dir.join("t5.flac").to_string_lossy()],
        ).unwrap();
        seed_pending_albums_and_artwork(&conn).unwrap();
        conn.execute("UPDATE enrichment_album_state SET status='needs_review' WHERE release_id='rel_3'", []).unwrap();
    }

    // Run text enrichment & artwork on rel_1
    let gates = Arc::new(GateRegistry::new());
    let idle_gate = Arc::new(EnrichmentIdleGate::new(gates));
    let provider_calls = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn MetadataProvider> = Arc::new(MockMetadataProvider {
        calls: Arc::clone(&provider_calls),
        delay: Duration::ZERO,
        cands: vec![CandidateAlbum {
            provider: "musicbrainz".into(),
            external_release_id: "mb-roja".into(),
            album: "Roja".into(),
            artist: "A. R. Rahman".into(),
            is_va: false,
            year: Some(1992),
            original_year: Some(1992),
            mediums: 1,
            composer: None,
            genre: Some("Soundtrack".into()),
            artwork_url: Some("https://coverartarchive.org/release/mb-roja/front-1200".into()),
            tracks: vec![
                sample_cand_track(1, "Chinna Chinna Aasai", "Minmini", 300.0),
                sample_cand_track(2, "Pudhu Vellai Mazhai", "Sujatha", 300.0),
                sample_cand_track(3, "Kaadhal Rojave", "S. P. Balasubrahmanyam", 300.0),
            ],
        }],
    });
    let ext_art: Arc<dyn ExternalArtworkProvider> = Arc::new(MockArtworkProvider {
        bytes: make_png_bytes(1000, 1000, [0, 200, 120]),
    });
    let store = ImageStore::new(dir.join("artwork"));

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let changed = {
        let mut conn = db.conn.lock();
        rt.block_on(process_text_enrichment_album(&mut conn, "rel_1", &[provider], &idle_gate))
    };
    assert!(changed, "rel_1 missing album artist + clean Roja title must apply");

    // Low-res local cover upgrades to 1000x1000 external cover and syncs engine_artwork
    let art_out = {
        let mut conn = db.conn.lock();
        let is_idle = || idle_gate.is_idle_now();
        rt.block_on(process_album_artwork_item(
            &mut conn,
            &store,
            Some(&ext_art),
            "rel_1",
            0,
            0,
            500,
            true,
            &is_idle,
            idle_gate.cancel_notify(),
        ))
    };
    assert_eq!(art_out, ArtworkProcessOutcome::Found);

    // Check raw DB rows are STILL untouched while overlay & engine_artwork are updated!
    {
        let conn = db.conn.lock();
        let (raw_alb, raw_art): (String, String) = conn
            .query_row("SELECT title, artist_credit FROM releases WHERE id='rel_1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(raw_alb, "Roja [CD Rip]");
        assert_eq!(raw_art, "Unknown Artist");

        let (art_w, art_src): (i64, String) = conn
            .query_row("SELECT width, source FROM artwork_items WHERE entity_kind='album' AND entity_id='rel_1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(art_w, 1000);
        assert_eq!(art_src, "external:coverartarchive");

        // Watched-root coverage % check
        let status = compute_enrichment_status(&conn, "active", None, None, None, vec![]).unwrap();
        assert_eq!(status.total_albums, 3);
        assert_eq!(status.covered_albums, 2); // rel_1 auto_applied, rel_3 needs_review
        assert_eq!(status.coverage_percent, 66);
        let root_a = status.roots.iter().find(|r| r.folder_id == "wf_a").unwrap();
        assert_eq!(root_a.total_albums, 2);
        assert_eq!(root_a.covered_albums, 1);
        assert_eq!(root_a.coverage_percent, 50);
        let root_b = status.roots.iter().find(|r| r.folder_id == "wf_b").unwrap();
        assert_eq!(root_b.total_albums, 1);
        assert_eq!(root_b.coverage_percent, 100);
    }

    // Check HeadlessCoreRuntime projection reflects overlay cleanly without dirty folder suffix edition!
    let runtime = HeadlessCoreRuntime::open(
        HeadlessConfig {
            db_path: db_path.clone(),
            engine_id: "eng_1".into(),
            library_id: "lib_1".into(),
            label: "Test".into(),
            output: None,
            headroom_bytes: 0,
        },
        DummyRenderer,
    )
    .unwrap();
    let req = json!({
        "protocolVersion": 1,
        "engineId": "eng_1",
        "libraryId": "lib_1",
        "operation": "catalog.page",
        "cursor": null,
        "limit": 50
    });
    let mut rt_mut = runtime;
    let page = rt_mut.request(req.to_string().as_bytes());
    let tracks_arr = page["data"]["tracks"].as_array().unwrap();
    let t1 = tracks_arr.iter().find(|t| t["id"] == "t1").unwrap();
    assert_eq!(t1["album"], "Roja");
    assert_eq!(t1["artist"], "Minmini");
    assert_eq!(t1["albumArtist"], "A. R. Rahman");
    assert!(t1["edition"].is_null(), "overlaid album must NOT re-inject dirty folder_name as edition");

    // User manual edit & revert history protection
    {
        let mut conn = db.conn.lock();
        let mut fields = Map::new();
        fields.insert("album".into(), json!("Roja (My Cut)"));
        apply_user_overlay(&mut conn, "rel_1", &fields, &[], "manual_edit", None).unwrap();
        revert_album_to_file_tags(&mut conn, "rel_1").unwrap();
        let state: String = conn
            .query_row("SELECT status FROM enrichment_album_state WHERE release_id='rel_1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, "user_locked");

        // Unlock & file commit reconciliation
        unlock_album_for_enrichment(&mut conn, "rel_1").unwrap();
        let state_after_unlock: String = conn
            .query_row("SELECT status FROM enrichment_album_state WHERE release_id='rel_1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state_after_unlock, "pending");
        record_file_commit_for_tracks(&mut conn, &[("t1".into(), "artist".into(), "Minmini".into())]).unwrap();
    }
}

#[test]
fn audiophile_idle_guard_blocks_during_playback_and_cancels_inflight_request() {
    let dir = temp_dir("cadence-audiophile-guard");
    let db_path = dir.join("cadence.db");
    let db = AppDb::new(db_path.clone()).unwrap();
    {
        let conn = db.conn.lock();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m1','Root',?1,'local','ntfs',CURRENT_TIMESTAMP)",
            params![dir.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('r_guard','Unknown Album',?1,'Unknown','Unknown Artist',CURRENT_TIMESTAMP)",
            params![dir.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,created_at)
             VALUES('tg1','r_guard','m1',?1,'Unknown',?2,'tg1.flac',100,1,'Song 1','Unknown Artist','Unknown Album',1,1,180.0,'FLAC',CURRENT_TIMESTAMP)",
            params![dir.to_string_lossy(), dir.join("tg1.flac").to_string_lossy()],
        ).unwrap();
        seed_pending_albums_and_artwork(&conn).unwrap();
    }

    let gates = Arc::new(GateRegistry::new());
    let idle_gate = Arc::new(EnrichmentIdleGate::new(gates));
    idle_gate.set_cooldown_ms(100);
    // Playback active right before worker starts
    idle_gate.set_transport_active(true);

    let calls = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn MetadataProvider> = Arc::new(MockMetadataProvider {
        calls: Arc::clone(&calls),
        delay: Duration::from_millis(500),
        cands: vec![],
    });
    let mut worker = EnrichmentWorker::start_with_providers(
        EnrichmentWorkerConfig {
            db_path: db_path.clone(),
            artwork_dir: dir.join("artwork"),
            enable_external: true,
        },
        Arc::clone(&idle_gate),
        vec![provider],
        None,
    );

    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(calls.load(Ordering::SeqCst), 0, "must perform ZERO provider calls while playback active");

    // Stop playback -> still blocked during cooldown until cooldown elapses
    idle_gate.set_transport_active(false);
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(calls.load(Ordering::SeqCst), 0, "must stay silent during post-playback cooldown");

    // Wait past 100ms test cooldown -> worker runs, then playback starts mid-request and aborts it!
    std::thread::sleep(Duration::from_millis(180));
    let started_calls = calls.load(Ordering::SeqCst);
    assert!(started_calls >= 1, "worker should engage once cooldown finishes");
    idle_gate.set_transport_active(true);

    worker.shutdown();
}

fn encode_base64_for_test(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = *chunk.get(1).unwrap_or(&0) as usize;
        let b2 = *chunk.get(2).unwrap_or(&0) as usize;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) & 63] as char);
        out.push(TABLE[(n >> 12) & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n & 63] as char } else { '=' });
    }
    out
}

#[test]
fn apply_user_overlay_diff_only_and_preserves_proposal() {
    let dir = temp_dir("cadence-overlay-diff");
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    let mut conn = db.conn.lock();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m1','Root',?1,'local','ntfs',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,release_year,composer_name,genre_tags,created_at)
         VALUES('rel_k','Kizhakku Vasal CD RIP',?1,'Kizhakku Vasal CD RIP','Ilaiyaraaja',1990,'Ilaiyaraaja','Tamil Film Soundtrack',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,album_artist,composer,genre,track_number,disc_number,duration_secs,format,created_at)
         VALUES('tk_1','rel_k','m1',?1,'Kizhakku Vasal CD RIP',?2,'01.wav',1000,1,'Song One','Ilaiyaraaja','Kizhakku Vasal CD RIP','Ilaiyaraaja','Ilaiyaraaja','Tamil Film Soundtrack',1,1,240.0,'WAV',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy(), dir.join("01.wav").to_string_lossy()],
    ).unwrap();
    let proposal_json = json!({
        "provider": "apple_music",
        "album": "Kizhakku Vasal (Original Motion Picture Soundtrack)",
        "albumArtist": "Ilaiyaraaja",
        "year": 1990
    }).to_string();
    conn.execute(
        "INSERT INTO enrichment_album_state(release_id,status,provider,external_release_id,distance,proposal_json)
         VALUES('rel_k','needs_review','apple_music','am-99',0.24,?1)",
        params![proposal_json],
    ).unwrap();

    let mut fields = Map::new();
    fields.insert("album".into(), json!("Kizhakku Vasal")); // differs from raw
    fields.insert("album_artist".into(), json!("Ilaiyaraaja")); // matches raw -> must NOT create overlay
    fields.insert("composer".into(), json!("Ilaiyaraaja")); // matches raw
    fields.insert("year".into(), json!("1990")); // matches raw
    apply_user_overlay(&mut conn, "rel_k", &fields, &[], "manual_edit", None).unwrap();

    let detail = get_enrichment_album_detail(&conn, "rel_k").unwrap().unwrap();
    assert_eq!(detail.raw_album_artist.as_deref(), Some("Ilaiyaraaja"));
    assert_eq!(detail.overlays.len(), 1);
    assert_eq!(detail.overlays[0].field_name, "album");
    assert_eq!(detail.overlays[0].value_text.as_deref(), Some("Kizhakku Vasal"));
    assert_eq!(detail.provider.as_deref(), Some("apple_music"));
    assert!(detail.proposal.is_some(), "apply_user_overlay must preserve Apple Music proposal evidence");
}

#[test]
fn apply_user_overlay_stages_cover_art_override_and_replaces_existing() {
    let dir = temp_dir("cadence-art-override");
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    let store = ImageStore::new(dir.join("artwork"));
    let gates = Arc::new(GateRegistry::new());
    let gate = Arc::new(EnrichmentIdleGate::new(gates));

    {
        let conn = db.conn.lock();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m1','Root',?1,'local','ntfs',CURRENT_TIMESTAMP)",
            params![dir.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('rel_art','Roja',?1,'Roja','A. R. Rahman',CURRENT_TIMESTAMP)",
            params![dir.to_string_lossy()],
        ).unwrap();
        conn.execute(
            "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,has_embedded_art,created_at)
             VALUES('t_art','rel_art','m1',?1,'Roja',?2,'t1.flac',100,1,'Song 1','Minmini','Roja',1,1,200.0,'FLAC',0,CURRENT_TIMESTAMP)",
            params![dir.to_string_lossy(), dir.join("t1.flac").to_string_lossy()],
        ).unwrap();
    }

    let png1 = make_png_bytes(600, 600, [10, 20, 200]);
    let data_url1 = format!("data:image/png;base64,{}", encode_base64_for_test(&png1));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

    {
        let mut conn = db.conn.lock();
        apply_user_overlay(&mut conn, "rel_art", &Map::new(), &[], "manual_edit", Some(&data_url1)).unwrap();
        let (prio, ov_url): (i64, String) = conn
            .query_row("SELECT priority, override_url FROM artwork_queue WHERE entity_id='rel_art'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(prio, 0);
        assert_eq!(ov_url, data_url1);

        let is_idle = || gate.is_idle_now();
        let outcome = rt.block_on(process_album_artwork_item(
            &mut conn, &store, None, "rel_art", 0, 0, 500, false, &is_idle, gate.cancel_notify(),
        ));
        assert_eq!(outcome, ArtworkProcessOutcome::Found);
    }

    let first_hash: String = {
        let conn = db.conn.lock();
        let (st, hash): (String, String) = conn
            .query_row("SELECT status, image_hash FROM artwork_items WHERE entity_kind='album' AND entity_id='rel_art'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(st, "user_override");
        let has_art: i64 = conn.query_row("SELECT has_embedded_art FROM tracks WHERE id='t_art'", [], |r| r.get(0)).unwrap();
        assert_eq!(has_art, 1);
        hash
    };

    // Second user override replaces existing user_override!
    let png2 = make_png_bytes(800, 800, [220, 40, 30]);
    let data_url2 = format!("data:image/png;base64,{}", encode_base64_for_test(&png2));
    {
        let mut conn = db.conn.lock();
        apply_user_overlay(&mut conn, "rel_art", &Map::new(), &[], "manual_edit", Some(&data_url2)).unwrap();
        let is_idle = || gate.is_idle_now();
        let outcome = rt.block_on(process_album_artwork_item(
            &mut conn, &store, None, "rel_art", 0, 0, 500, false, &is_idle, gate.cancel_notify(),
        ));
        assert_eq!(outcome, ArtworkProcessOutcome::Found);
        let second_hash: String = conn
            .query_row("SELECT image_hash FROM artwork_items WHERE entity_kind='album' AND entity_id='rel_art'", [], |r| r.get(0))
            .unwrap();
        assert_ne!(second_hash, first_hash);
    }
}

#[test]
fn record_file_commit_locks_album_and_preserves_proposal() {
    let dir = temp_dir("cadence-commit-lock");
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    let mut conn = db.conn.lock();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m1','Root',?1,'local','ntfs',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('rel_c','Old',?1,'Old','Artist',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,created_at)
         VALUES('tc_1','rel_c','m1',?1,'Old',?2,'tc_1.wav',100,1,'Song','Artist','New Album',1,1,120.0,'WAV',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy(), dir.join("tc_1.wav").to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO enrichment_album_state(release_id,status,provider,external_release_id,distance,proposal_json,raw_signature)
         VALUES('rel_c','needs_review','apple_music','am-1',0.21,'{\"provider\":\"apple_music\",\"album\":\"New Album\"}','old_sig')",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO metadata_overlays(entity_type,entity_id,field_name,value_text,origin,locked)
         VALUES('release','rel_c','album','New Album','user',1)",
        [],
    ).unwrap();

    record_file_commit_for_tracks(&mut conn, &[("tc_1".into(), "album".into(), "New Album".into())]).unwrap();

    // Commit deletes overlay, locks album against pending reset on seed, and retains Apple Music evidence!
    seed_pending_albums_and_artwork(&conn).unwrap();
    let detail = get_enrichment_album_detail(&conn, "rel_c").unwrap().unwrap();
    assert_eq!(detail.status, "user_locked");
    assert_eq!(detail.provider.as_deref(), Some("apple_music"));
    assert!(detail.proposal.is_some());
    assert!(detail.overlays.is_empty());
    assert_eq!(detail.raw_title, "New Album");
}

#[test]
fn derive_clean_edition_strips_cd_rip_and_preserves_distinct_editions() {
    assert_eq!(
        derive_clean_edition(Some("Kizhakku Vasal CD RIP"), "Kizhakku Vasal", false),
        None
    );
    assert_eq!(
        derive_clean_edition(Some("Roja [CD-RIP]"), "Roja", false),
        None
    );
    assert_eq!(
        derive_clean_edition(Some("Kizhakku Vasal FLAC RIP"), "Kizhakku Vasal", false),
        None
    );
    assert_eq!(
        derive_clean_edition(Some("Kizhakku Vasal [PGGB]"), "Kizhakku Vasal", false),
        Some("PGGB".into())
    );
    assert_eq!(
        derive_clean_edition(Some("Roja (Deluxe Edition)"), "Roja", false),
        Some("Deluxe Edition".into())
    );
    assert_eq!(
        derive_clean_edition(Some("1988"), "Symphony No. 5", false),
        Some("1988".into())
    );
    assert_eq!(
        derive_clean_edition(Some("Roja [PGGB]"), "Roja", true),
        None
    );
}

#[test]
fn build_override_candidate_urls_downscales_apple_3000px_with_fallbacks() {
    let apple_3000 = "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/ff/cd/fa/18UMGIM53753.rgb.jpg/3000x3000bb.jpg?w=1";
    assert_eq!(
        build_override_candidate_urls(apple_3000),
        vec![
            "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/ff/cd/fa/18UMGIM53753.rgb.jpg/1200x1200bb.jpg?w=1",
            "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/ff/cd/fa/18UMGIM53753.rgb.jpg/600x600bb.jpg?w=1",
            apple_3000,
        ]
    );

    let apple_1200 = "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/aa/bb/cc/cover.jpg/1200x1200bb.jpg";
    assert_eq!(
        build_override_candidate_urls(apple_1200),
        vec![
            apple_1200,
            "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/aa/bb/cc/cover.jpg/600x600bb.jpg",
        ]
    );

    let apple_600 = "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/aa/bb/cc/cover.jpg/600x600bb.jpg";
    assert_eq!(
        build_override_candidate_urls(apple_600),
        vec![apple_600]
    );

    let custom_url = "https://example.org/covers/3000x3000bb.jpg";
    assert_eq!(
        build_override_candidate_urls(custom_url),
        vec![custom_url]
    );
}

#[test]
fn enrichment_detail_exposes_pending_artwork_queue_and_last_error() {
    let dir = temp_dir("cadence-pending-art-detail");
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    let mut conn = db.conn.lock();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m1','Root',?1,'local','ntfs',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('rel_p','A Star Is Born',?1,'ASIB','Lady Gaga',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,created_at)
         VALUES('tp_1','rel_p','m1',?1,'ASIB',?2,'01.dsf',100,1,'Shallow','Lady Gaga','A Star Is Born',1,1,215.0,'DSD',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy(), dir.join("01.dsf").to_string_lossy()],
    ).unwrap();

    let url = "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/ff/cd/fa/18UMGIM53753.rgb.jpg/3000x3000bb.jpg";
    apply_user_overlay(&mut conn, "rel_p", &Map::new(), &[], "manual_edit", Some(url)).unwrap();

    let detail0 = get_enrichment_album_detail(&conn, "rel_p").unwrap().unwrap();
    assert_eq!(detail0.pending_artwork_url.as_deref(), Some(url));
    assert_eq!(detail0.pending_artwork_attempts, Some(0));
    assert_eq!(detail0.pending_artwork_error, None);

    let now = super::schema::epoch_secs();
    let outcome = handle_retry_budget(
        &conn,
        "album",
        "rel_p",
        now,
        0,
        5,
        Some("operation timed out"),
        &[],
    );
    assert_eq!(outcome, ArtworkProcessOutcome::RetryLater(5));

    let detail1 = get_enrichment_album_detail(&conn, "rel_p").unwrap().unwrap();
    assert_eq!(detail1.pending_artwork_url.as_deref(), Some(url));
    assert_eq!(detail1.pending_artwork_attempts, Some(1));
    assert_eq!(detail1.pending_artwork_error.as_deref(), Some("operation timed out"));
}

#[test]
fn paused_auto_enrichment_drains_user_override_only_when_transport_idle() {
    let dir = temp_dir("cadence-paused-override");
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    let conn = db.conn.lock();
    ensure_schema(&conn).unwrap();

    // Auto-enrichment item without override_url must NOT be picked up by next_user_override_artwork_item
    conn.execute(
        "INSERT INTO artwork_queue(entity_kind, entity_id, priority, attempts, next_retry_at, enqueued_at, override_url)
         VALUES('album', 'rel_auto', 5, 0, 0, 100, NULL)",
        [],
    ).unwrap();
    assert!(next_user_override_artwork_item(&conn).is_none());

    // User-staged override item MUST be picked up
    conn.execute(
        "INSERT INTO artwork_queue(entity_kind, entity_id, priority, attempts, next_retry_at, enqueued_at, override_url)
         VALUES('album', 'rel_user', 0, 0, 0, 101, 'https://example.org/cover.jpg')",
        [],
    ).unwrap();
    let item = next_user_override_artwork_item(&conn).unwrap();
    assert_eq!(item.0, "album");
    assert_eq!(item.1, "rel_user");

    let gate = EnrichmentIdleGate::new(Arc::new(GateRegistry::new()));
    gate.set_cooldown_ms(120);
    gate.sync_config(true, true);
    assert!(!gate.is_idle_now(), "auto-enrichment must report paused when user_paused=true");
    assert!(
        gate.is_transport_storage_idle(),
        "user-staged cover override may drain when user_paused=true and transport is strictly idle"
    );

    gate.set_transport_active(true);
    assert!(!gate.is_transport_storage_idle(), "must halt immediately when playback starts");

    gate.set_transport_active(false);
    assert!(!gate.is_transport_storage_idle(), "must halt during post-playback cooldown");
    std::thread::sleep(Duration::from_millis(150));
    assert!(gate.is_transport_storage_idle(), "may resume once cooldown has elapsed");
}

#[test]
fn empty_and_deep_subfolder_watched_roots_report_accurate_album_counts() {
    let dir = temp_dir("cadence-empty-deep-root-counts");
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    let conn = db.conn.lock();
    ensure_schema(&conn).unwrap();

    let empty_root = "//192.168.1.6/Mathan/Music Collection/Master/Tamil";
    let deep_root = "//192.168.1.6/Mathan/Music Collection/Master/Hindi";
    let deep_album_dir = "//192.168.1.6/Mathan/Music Collection/Master/Hindi/1990s/AR Rahman/Roja";
    let deep_track_file = format!("{deep_album_dir}/01.flac");

    conn.execute(
        "INSERT INTO storage_mounts(id, name, mount_path, mount_type, file_system, last_seen_timestamp)
         VALUES('m_smb', 'NAS', '//192.168.1.6/Mathan', 'network_smb', 'cifs', CURRENT_TIMESTAMP)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO watched_folders(id, mount_id, folder_path, display_name, scan_mode, is_enabled)
         VALUES('wf_empty', 'm_smb', ?1, 'Tamil', 'manual', 1),
               ('wf_deep', 'm_smb', ?2, 'Hindi', 'manual', 1)",
        params![empty_root, deep_root],
    )
    .unwrap();

    // Initially empty: both global and per-root coverage must be 0%, never 100%.
    let initial = compute_enrichment_status(&conn, "cooldown", Some(15), None, None, vec![]).unwrap();
    assert_eq!(initial.total_albums, 0);
    assert_eq!(initial.covered_albums, 0);
    assert_eq!(initial.coverage_percent, 0);
    assert_eq!(initial.artwork_coverage_percent, 0);
    let empty_progress = initial.roots.iter().find(|r| r.folder_id == "wf_empty").unwrap();
    assert_eq!(empty_progress.total_albums, 0);
    assert_eq!(empty_progress.covered_albums, 0);
    assert_eq!(empty_progress.coverage_percent, 0);
    assert_eq!(empty_progress.artwork_coverage_percent, 0);

    // Insert a release/track nested several subfolder levels below `wf_deep`.
    conn.execute(
        "INSERT INTO releases(id, title, folder_path, folder_name, artist_credit, created_at)
         VALUES('rel_deep', 'Roja', ?1, 'Roja', 'A. R. Rahman', CURRENT_TIMESTAMP)",
        params![deep_album_dir],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tracks(id, release_id, mount_id, folder_path, folder_name, file_path, file_name, file_size, mtime, title, artist_credit, album_title, track_number, disc_number, duration_secs, format, is_online, created_at)
         VALUES('trk_deep', 'rel_deep', 'm_smb', ?1, 'Roja', ?2, '01.flac', 100, 1, 'Chinna Chinna Aasai', 'A. R. Rahman', 'Roja', 1, 1, 240.0, 'FLAC', 1, CURRENT_TIMESTAMP)",
        params![deep_album_dir, deep_track_file],
    )
    .unwrap();

    let after = compute_enrichment_status(&conn, "cooldown", Some(15), None, None, vec![]).unwrap();
    assert_eq!(after.total_albums, 1);
    assert_eq!(after.coverage_percent, 0);

    let after_empty = after.roots.iter().find(|r| r.folder_id == "wf_empty").unwrap();
    assert_eq!(after_empty.total_albums, 0);
    assert_eq!(after_empty.coverage_percent, 0);
    assert_eq!(after_empty.artwork_coverage_percent, 0);

    let after_deep = after.roots.iter().find(|r| r.folder_id == "wf_deep").unwrap();
    assert_eq!(after_deep.total_albums, 1);
    assert_eq!(after_deep.pending_albums, 1);
    assert_eq!(after_deep.coverage_percent, 0);
}

#[test]
fn accept_proposal_enqueues_artwork_and_revert_to_file_restores_local_art() {
    let dir = temp_dir("cadence-accept-revert-art");
    let db = AppDb::new(dir.join("cadence.db")).unwrap();
    let mut conn = db.conn.lock();
    ensure_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m1','Root',?1,'local','ntfs',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,created_at) VALUES('rel_ar','Old',?1,'Old','Artist',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,track_number,disc_number,duration_secs,format,created_at)
         VALUES('tar_1','rel_ar','m1',?1,'Old',?2,'01.wav',100,1,'Song','Artist','Old',1,1,120.0,'WAV',CURRENT_TIMESTAMP)",
        params![dir.to_string_lossy(), dir.join("01.wav").to_string_lossy()],
    )
    .unwrap();
    let proposal_url = "https://is1-ssl.mzstatic.com/image/thumb/cover.jpg/1200x1200bb.jpg";
    conn.execute(
        "INSERT INTO enrichment_album_state(release_id,status,provider,external_release_id,distance,proposal_json,raw_signature)
         VALUES('rel_ar','needs_review','apple_music','am-1',0.12,?1,'sig')",
        params![serde_json::json!({"provider":"apple_music","album":"New","artworkUrl":proposal_url}).to_string()],
    )
    .unwrap();

    accept_album_proposal(&mut conn, "rel_ar").unwrap();
    let queued_override: Option<String> = conn
        .query_row(
            "SELECT override_url FROM artwork_queue WHERE entity_kind='album' AND entity_id='rel_ar'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(queued_override.as_deref(), Some(proposal_url));

    // Simulate downloaded user_override artwork, then verify revert_album_to_file_tags clears it and re-queues local art.
    conn.execute(
        "INSERT INTO artwork_items(entity_kind,entity_id,status,image_hash,mime,updated_at) VALUES('album','rel_ar','user_override','h1','image/jpeg',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO engine_artwork(release_id,etag,jpeg) VALUES('rel_ar','art_h1',X'FFD8FF')",
        [],
    )
    .unwrap();
    revert_album_to_file_tags(&mut conn, "rel_ar").unwrap();

    let item_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM artwork_items WHERE entity_kind='album' AND entity_id='rel_ar'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let art_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM engine_artwork WHERE release_id='rel_ar'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let (prio, reverted_override): (i64, Option<String>) = conn
        .query_row(
            "SELECT priority, override_url FROM artwork_queue WHERE entity_kind='album' AND entity_id='rel_ar'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(item_count, 0);
    assert_eq!(art_count, 0);
    assert_eq!(prio, 5);
    assert_eq!(reverted_override, None);
}
