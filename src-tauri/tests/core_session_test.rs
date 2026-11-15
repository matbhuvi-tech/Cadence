//! Phase 3 acceptance: real native owner, synthetic catalog and a renderer mailbox.
use cadence_core_lib::core_session::{
    CatalogTrack, Output, Renderer, RendererAction, RendererError, RendererEvent, RunToken,
    SessionConfig, SessionOwner, MAX_MESSAGE_BYTES, RECENT_COMMAND_LIMIT,
};
use serde_json::{json, Value};
use std::sync::{Arc, Barrier, Mutex};

#[derive(Default)]
struct FakeState {
    actions: Vec<RendererAction>,
    fail_next: bool,
}

struct FakeRenderer(Arc<Mutex<FakeState>>);

impl Renderer for FakeRenderer {
    fn apply(&mut self, action: &RendererAction) -> Result<(), RendererError> {
        let mut state = self.0.lock().unwrap();
        state.actions.push(action.clone());
        if std::mem::take(&mut state.fail_next) {
            Err(RendererError)
        } else {
            Ok(())
        }
    }
}

type Owner = SessionOwner<FakeRenderer>;

fn catalog() -> Vec<CatalogTrack> {
    ["song-a", "song-b", "song-c"]
        .into_iter()
        .map(|id| CatalogTrack {
            id: id.into(), title: id.into(), artist: "Artist".into(), album: "Album".into(),
            duration_seconds: 120.0,
        })
        .collect()
}

fn config() -> SessionConfig {
    SessionConfig {
        engine_id: "room-core".into(), library_id: "music-library".into(), label: "Room Core".into(),
        output: Some(Output { id: "rose-130".into(), label: "RS130".into(), transport: "upnp".into() }),
    }
}

fn fixture() -> (Arc<Owner>, Arc<Mutex<FakeState>>) {
    let fake = Arc::new(Mutex::new(FakeState::default()));
    let owner = SessionOwner::new(config(), catalog(), FakeRenderer(fake.clone())).unwrap();
    (Arc::new(owner), fake)
}

fn wire(mut operation: Value) -> Value {
    let object = operation.as_object_mut().unwrap();
    object.insert("protocolVersion".into(), json!(1));
    object.insert("engineId".into(), json!("room-core"));
    object.insert("libraryId".into(), json!("music-library"));
    operation
}

fn request(owner: &Owner, operation: Value) -> Value {
    owner.request(&serde_json::to_vec(&wire(operation)).unwrap())
}

fn snapshot(owner: &Owner) -> Value {
    let response = request(owner, json!({"operation":"session.snapshot"}));
    assert_eq!(response["ok"], true, "{response}");
    response["data"].clone()
}

fn mutate(owner: &Owner, id: &str, mut operation: Value) -> Value {
    let revision = snapshot(owner)["revision"].clone();
    operation["commandId"] = json!(id);
    operation["expectedRevision"] = revision;
    request(owner, operation)
}

fn entries() -> Value {
    json!([
        {"entryId":"a1","trackId":"song-a"},
        {"entryId":"a2","trackId":"song-a"},
        {"entryId":"b","trackId":"song-b"},
        {"entryId":"c","trackId":"song-c"}
    ])
}

fn queue(owner: &Owner) {
    assert_eq!(mutate(owner, "queue", json!({"operation":"queue.replace","entries":entries()}))["ok"], true);
}

fn token(fake: &Arc<Mutex<FakeState>>) -> RunToken {
    fake.lock().unwrap().actions.iter().rev().find_map(|a| a.token().cloned()).unwrap()
}

fn play(owner: &Owner, fake: &Arc<Mutex<FakeState>>) -> RunToken {
    assert_eq!(mutate(owner, "play", json!({"operation":"playback.control","action":"play","trackId":"song-a"}))["ok"], true);
    let token = token(fake);
    assert!(owner.on_renderer_event(RendererEvent::Started(token.clone())).unwrap());
    token
}

fn complete(owner: &Owner, fake: &Arc<Mutex<FakeState>>, old: RunToken) -> RunToken {
    assert!(owner.on_renderer_event(RendererEvent::Completed(old)).unwrap());
    let next = token(fake);
    assert!(owner.on_renderer_event(RendererEvent::Started(next.clone())).unwrap());
    next
}

#[test]
fn construction_and_observation_never_claim_or_play_a_renderer() {
    let (owner, fake) = fixture();
    let hello = request(&owner, json!({"operation":"core.hello"}));
    assert_eq!(hello["data"]["ready"], true);
    assert!(hello["data"]["capabilities"].as_array().unwrap().contains(&json!("queue.coordinate")));
    assert_eq!(snapshot(&owner)["playback"]["activity"], "idle");
    assert_eq!(request(&owner, json!({"operation":"catalog.page","cursor":null,"limit":2}))["data"]["tracks"].as_array().unwrap().len(), 2);
    assert!(fake.lock().unwrap().actions.is_empty());
}

#[test]
fn duplicate_tracks_advance_once_without_any_controller() {
    let (owner, fake) = fixture();
    queue(&owner);
    let first = play(&owner, &fake);
    let second = complete(&owner, &fake, first.clone());
    assert_ne!(first, second);
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "a2");
    let before = snapshot(&owner);
    assert!(!owner.on_renderer_event(RendererEvent::Completed(first)).unwrap());
    assert_eq!(snapshot(&owner), before);
    complete(&owner, &fake, second);
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "b");
}

#[test]
fn concurrent_duplicate_commands_have_one_renderer_effect() {
    let (owner, fake) = fixture(); queue(&owner);
    let command = wire(json!({"operation":"playback.control","action":"play","trackId":"song-a","commandId":"same-command","expectedRevision":1}));
    let barrier = Arc::new(Barrier::new(12));
    let workers: Vec<_> = (0..12).map(|_| {
        let owner = owner.clone(); let barrier = barrier.clone(); let command = command.clone();
        std::thread::spawn(move || { barrier.wait(); owner.request(&serde_json::to_vec(&command).unwrap()) })
    }).collect();
    for worker in workers { assert_eq!(worker.join().unwrap()["ok"], true); }
    assert_eq!(snapshot(&owner)["revision"], 2);
    assert_eq!(fake.lock().unwrap().actions.len(), 1);
}

#[test]
fn concurrent_distinct_commands_reject_the_stale_loser_with_a_fresh_snapshot() {
    let (owner, fake) = fixture(); queue(&owner);
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = ["song-a", "song-b"].into_iter().map(|track| {
        let owner = owner.clone(); let barrier = barrier.clone();
        std::thread::spawn(move || { barrier.wait(); request(&owner, json!({"operation":"playback.control","action":"play","trackId":track,"commandId":track,"expectedRevision":1})) })
    }).collect();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r["ok"] == true).count(), 1);
    let stale = results.iter().find(|r| r["ok"] == false).unwrap();
    assert_eq!(stale["error"]["code"], "stale_revision");
    assert_eq!(stale["error"]["snapshot"], snapshot(&owner));
    assert_eq!(fake.lock().unwrap().actions.len(), 1);
}

#[test]
fn concurrent_completion_notifications_only_advance_one_entry() {
    let (owner, fake) = fixture(); queue(&owner); let run = play(&owner, &fake);
    let workers: Vec<_> = (0..10).map(|_| {
        let owner = owner.clone(); let run = run.clone();
        std::thread::spawn(move || owner.on_renderer_event(RendererEvent::Completed(run)).unwrap())
    }).collect();
    assert_eq!(workers.into_iter().map(|w| w.join().unwrap()).filter(|advanced| *advanced).count(), 1);
    assert_eq!(fake.lock().unwrap().actions.len(), 2);
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "a2");
}

#[test]
fn command_id_reuse_with_changed_content_is_rejected_before_effects() {
    let (owner, fake) = fixture(); queue(&owner); play(&owner, &fake);
    let changed = request(&owner, json!({"operation":"playback.control","action":"stop","commandId":"play","expectedRevision":1}));
    assert_eq!(changed["error"]["code"], "invalid_payload");
    assert_eq!(fake.lock().unwrap().actions.len(), 1);
}

#[test]
fn deduplication_is_bounded_and_evicted_success_cannot_replay() {
    let (owner, fake) = fixture(); queue(&owner);
    let original = json!({"operation":"playback.control","action":"play","trackId":"song-a","commandId":"original","expectedRevision":1});
    assert_eq!(request(&owner, original.clone())["ok"], true);
    for i in 0..=RECENT_COMMAND_LIMIT {
        assert_eq!(mutate(&owner, &format!("mode-{i}"), json!({"operation":"queue.control","action":"modes","repeat":"off","shuffle":false}))["ok"], true);
    }
    assert_eq!(request(&owner, original)["error"]["code"], "stale_revision");
    assert_eq!(fake.lock().unwrap().actions.len(), 1);
}

#[test]
fn retry_after_lost_ack_returns_current_state_without_replaying() {
    let (owner, fake) = fixture(); queue(&owner);
    let original = json!({"operation":"playback.control","action":"play","trackId":"song-a","commandId":"original","expectedRevision":1});
    request(&owner, original.clone());
    let run = token(&fake); owner.on_renderer_event(RendererEvent::Started(run.clone())).unwrap();
    complete(&owner, &fake, run);
    let result = request(&owner, original);
    assert_eq!(result["data"], snapshot(&owner));
    assert_eq!(result["data"]["queue"]["currentEntryId"], "a2");
    assert_eq!(fake.lock().unwrap().actions.len(), 2);
}

#[test]
fn repeat_one_restarts_same_entry_with_a_new_token_but_next_skips_it() {
    let (owner, fake) = fixture(); queue(&owner); let first = play(&owner, &fake);
    mutate(&owner, "repeat", json!({"operation":"queue.control","action":"modes","repeat":"one","shuffle":false}));
    let second = complete(&owner, &fake, first.clone());
    assert_ne!(first, second);
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "a1");
    mutate(&owner, "next", json!({"operation":"queue.control","action":"next"}));
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "a2");
}

#[test]
fn repeat_off_stops_at_end_and_repeat_all_wraps() {
    for repeat in ["off", "all"] {
        let (owner, fake) = fixture(); queue(&owner);
        mutate(&owner, "modes", json!({"operation":"queue.control","action":"modes","repeat":repeat,"shuffle":false}));
        mutate(&owner, "last", json!({"operation":"queue.control","action":"jump","entryId":"c"}));
        let run = token(&fake); owner.on_renderer_event(RendererEvent::Started(run.clone())).unwrap();
        owner.on_renderer_event(RendererEvent::Completed(run)).unwrap();
        let state = snapshot(&owner);
        assert_eq!(state["playback"]["activity"], if repeat == "off" { "idle" } else { "loading" });
        assert_eq!(state["queue"]["currentEntryId"], if repeat == "off" { "c" } else { "a1" });
    }
}

#[test]
fn shuffle_visits_each_entry_once_and_preserves_current_and_display_order() {
    let (owner, fake) = fixture(); queue(&owner); let mut run = play(&owner, &fake);
    mutate(&owner, "shuffle", json!({"operation":"queue.control","action":"modes","repeat":"off","shuffle":true}));
    let mut seen = vec![snapshot(&owner)["queue"]["currentEntryId"].clone()];
    for _ in 0..3 {
        run = complete(&owner, &fake, run);
        seen.push(snapshot(&owner)["queue"]["currentEntryId"].clone());
    }
    seen.sort_by_key(|v| v.as_str().unwrap().to_owned()); seen.dedup();
    assert_eq!(seen.len(), 4);
    assert_eq!(snapshot(&owner)["queue"]["entries"], entries());
    owner.on_renderer_event(RendererEvent::Completed(run)).unwrap();
    assert_eq!(snapshot(&owner)["playback"]["activity"], "idle");
}

#[test]
fn jump_targets_duplicate_entry_and_previous_uses_owner_play_order() {
    let (owner, _) = fixture(); queue(&owner);
    mutate(&owner, "jump", json!({"operation":"queue.control","action":"jump","entryId":"a2"}));
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "a2");
    mutate(&owner, "previous", json!({"operation":"queue.control","action":"previous"}));
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "a1");
}

#[test]
fn late_completion_is_ignored_after_stop_pause_seek_and_resume() {
    for action in ["stop", "pause", "seek"] {
        let (owner, fake) = fixture(); queue(&owner); let old = play(&owner, &fake);
        let mut operation = json!({"operation":"playback.control","action":action});
        if action == "seek" { operation["positionSeconds"] = json!(20); }
        assert_eq!(mutate(&owner, action, operation)["ok"], true);
        assert!(!owner.on_renderer_event(RendererEvent::Completed(old.clone())).unwrap());
        if action == "pause" {
            mutate(&owner, "resume", json!({"operation":"playback.control","action":"resume"}));
            assert_ne!(token(&fake), old);
            assert!(!owner.on_renderer_event(RendererEvent::Completed(old)).unwrap());
        }
    }
}

#[test]
fn queue_replacement_preserves_matching_current_or_stops_removed_current() {
    let (owner, fake) = fixture(); queue(&owner); let run = play(&owner, &fake);
    let reordered = json!([{"entryId":"b","trackId":"song-b"},{"entryId":"a1","trackId":"song-a"}]);
    mutate(&owner, "reorder", json!({"operation":"queue.replace","entries":reordered}));
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], "a1");
    assert_eq!(fake.lock().unwrap().actions.len(), 1);
    mutate(&owner, "clear", json!({"operation":"queue.replace","entries":[]}));
    assert_eq!(snapshot(&owner)["queue"]["currentEntryId"], Value::Null);
    assert_eq!(snapshot(&owner)["playback"]["activity"], "idle");
    assert!(matches!(fake.lock().unwrap().actions.last(), Some(RendererAction::Stop)));
    assert!(!owner.on_renderer_event(RendererEvent::Completed(run)).unwrap());
}

#[test]
fn unknown_tracks_entries_reused_entry_mapping_and_duplicate_ids_are_atomic_rejections() {
    let (owner, fake) = fixture(); queue(&owner); play(&owner, &fake);
    for (i, operation) in [
        json!({"operation":"queue.replace","entries":[{"entryId":"bad","trackId":"unknown"}]}),
        json!({"operation":"queue.replace","entries":[{"entryId":"a1","trackId":"song-b"}]}),
        json!({"operation":"queue.replace","entries":[{"entryId":"x","trackId":"song-a"},{"entryId":"x","trackId":"song-b"}]}),
        json!({"operation":"queue.control","action":"jump","entryId":"missing"}),
        json!({"operation":"playback.control","action":"play","trackId":"missing"}),
        json!({"operation":"playback.control","action":"seek","positionSeconds":121}),
    ].into_iter().enumerate() {
        let before = snapshot(&owner);
        assert_eq!(mutate(&owner, &format!("bad-{i}"), operation)["error"]["code"], "invalid_payload");
        assert_eq!(snapshot(&owner), before);
    }
    assert_eq!(fake.lock().unwrap().actions.len(), 1);
}

#[test]
fn direct_catalog_play_creates_an_opaque_queue_entry_without_exposing_paths() {
    let (owner, fake) = fixture(); play(&owner, &fake);
    let state = snapshot(&owner);
    assert_eq!(state["queue"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(state["queue"]["entries"][0]["trackId"], "song-a");
    assert_eq!(state["queue"]["currentEntryId"], state["queue"]["entries"][0]["entryId"]);
}

#[test]
fn renderer_failure_is_quarantined_and_retry_never_replays_an_uncertain_effect() {
    let (owner, fake) = fixture(); queue(&owner);
    fake.lock().unwrap().fail_next = true;
    let command = json!({"operation":"playback.control","action":"play","trackId":"song-a","commandId":"failed-play","expectedRevision":1});
    assert_eq!(request(&owner, command.clone())["error"]["code"], "unavailable");
    assert_eq!(request(&owner, command)["error"]["code"], "unavailable");
    assert_eq!(request(&owner, json!({"operation":"core.hello"}))["data"]["ready"], false);
    assert_eq!(mutate(&owner, "blocked", json!({"operation":"playback.control","action":"play","trackId":"song-b"}))["error"]["code"], "not_ready");
    assert_eq!(fake.lock().unwrap().actions.len(), 1);
    assert_eq!(mutate(&owner, "stop", json!({"operation":"playback.control","action":"stop"}))["ok"], true);
    assert_eq!(request(&owner, json!({"operation":"core.hello"}))["data"]["ready"], true);
    assert_eq!(fake.lock().unwrap().actions.len(), 2);
}

#[test]
fn renderer_loss_or_external_takeover_never_triggers_play_retries() {
    for takeover in [false, true] {
        let (owner, fake) = fixture(); queue(&owner); let run = play(&owner, &fake);
        let event = if takeover { RendererEvent::ExternalTakeover(run.clone()) } else { RendererEvent::Failed(run.clone()) };
        assert!(owner.on_renderer_event(event).unwrap());
        assert!(!owner.on_renderer_event(RendererEvent::Completed(run)).unwrap());
        assert_eq!(fake.lock().unwrap().actions.len(), 1);
        assert_eq!(request(&owner, json!({"operation":"core.hello"}))["data"]["ready"], false);
    }
}

#[test]
fn paused_renderer_loss_and_takeover_remain_correlated_including_after_seek() {
    for seek in [false, true] {
        for takeover in [false, true] {
            let (owner, fake) = fixture(); queue(&owner); let old = play(&owner, &fake);
            mutate(&owner, "pause", json!({"operation":"playback.control","action":"pause"}));
            let active = if seek {
                mutate(&owner, "seek", json!({"operation":"playback.control","action":"seek","positionSeconds":30}));
                token(&fake)
            } else { old.clone() };
            assert!(!owner.on_renderer_event(RendererEvent::Completed(active.clone())).unwrap());
            let event = if takeover { RendererEvent::ExternalTakeover(active) } else { RendererEvent::Failed(active) };
            assert!(owner.on_renderer_event(event).unwrap());
            assert_eq!(request(&owner, json!({"operation":"core.hello"}))["data"]["ready"], false);
            assert_eq!(mutate(&owner, "resume", json!({"operation":"playback.control","action":"resume"}))["error"]["code"], "not_ready");
        }
    }
}

#[test]
fn boundary_rejects_protocol_identity_paths_unknown_fields_and_oversized_bytes() {
    let (owner, fake) = fixture();
    for (value, code) in [
        (json!({"operation":"session.snapshot","protocolVersion":2,"engineId":"room-core","libraryId":"music-library"}), "incompatible_protocol"),
        (json!({"operation":"session.snapshot","protocolVersion":1,"engineId":"other","libraryId":"music-library"}), "identity_mismatch"),
        (wire(json!({"operation":"session.snapshot","sql":"select *"})), "invalid_payload"),
        (wire(json!({"operation":"playback.control","action":"play","trackId":"../music.flac","commandId":"a","expectedRevision":0})), "invalid_payload"),
        (wire(json!({"operation":"queue.control","action":"modes","repeat":"forever","shuffle":false,"commandId":"a","expectedRevision":0})), "invalid_payload"),
        (wire(json!({"operation":"playback.control","action":"stop","commandId":"a","expectedRevision":9_007_199_254_740_992u64})), "invalid_payload"),
    ] {
        assert_eq!(owner.request(&serde_json::to_vec(&value).unwrap())["error"]["code"], code);
    }
    assert_eq!(owner.request(&vec![b' '; MAX_MESSAGE_BYTES + 1])["error"]["code"], "invalid_payload");
    assert_eq!(owner.request(b"not json")["error"]["code"], "invalid_payload");
    assert!(fake.lock().unwrap().actions.is_empty());
}

#[test]
fn pagination_is_bounded_and_rejects_unknown_cursors() {
    let (owner, _) = fixture();
    let first = request(&owner, json!({"operation":"catalog.page","cursor":null,"limit":2}));
    let second = request(&owner, json!({"operation":"catalog.page","cursor":first["data"]["nextCursor"],"limit":2}));
    assert_eq!(second["data"]["tracks"][0]["id"], "song-c");
    assert_eq!(second["data"]["nextCursor"], Value::Null);
    for cursor in ["../music", "page_999", "page_01", "other_2"] {
        assert_eq!(request(&owner, json!({"operation":"catalog.page","cursor":cursor,"limit":2}))["error"]["code"], "invalid_payload");
    }
}

#[test]
fn maximum_queue_count_and_combined_snapshot_bytes_are_bounded() {
    let (owner, fake) = fixture();
    let many: Vec<_> = (0..4096).map(|i| json!({"entryId":format!("entry-{i}"),"trackId":"song-a"})).collect();
    assert_eq!(mutate(&owner, "max", json!({"operation":"queue.replace","entries":many}))["ok"], true);
    assert!(serde_json::to_vec(&snapshot(&owner)).unwrap().len() < MAX_MESSAGE_BYTES);
    let too_many: Vec<_> = (0..4097).map(|i| json!({"entryId":format!("entry-{i}"),"trackId":"song-a"})).collect();
    assert_eq!(mutate(&owner, "over", json!({"operation":"queue.replace","entries":too_many}))["error"]["code"], "invalid_payload");
    assert!(fake.lock().unwrap().actions.is_empty());
}

#[test]
fn invalid_owner_configuration_is_rejected_without_renderer_effects() {
    for invalid in ["../engine", "", "local"] {
        let fake = Arc::new(Mutex::new(FakeState::default()));
        let mut config = config(); config.engine_id = invalid.into();
        assert!(SessionOwner::new(config, catalog(), FakeRenderer(fake.clone())).is_err());
        assert!(fake.lock().unwrap().actions.is_empty());
    }
    let fake = Arc::new(Mutex::new(FakeState::default()));
    let mut duplicate = catalog(); duplicate.push(duplicate[0].clone());
    assert!(SessionOwner::new(config(), duplicate, FakeRenderer(fake)).is_err());
}
