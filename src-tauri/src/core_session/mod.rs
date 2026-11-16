//! Optional Core control-plane authority. Not instantiated by desktop startup.
//!
//! Call from an authenticated owner/control dispatcher, never from the audio/pacer
//! thread. No filesystem, DB, sockets, timers, workers or controller subscriptions.
//! The mutex serializes commands and renderer events. Renderer implementations must
//! provide a bounded, non-reentrant control mailbox, not perform media I/O here.
mod protocol;
pub use protocol::{CatalogTrack, ErrorCode, Output, QueueEntry, MAX_MESSAGE_BYTES};
use protocol::{ensure, seconds, text, token, Action, Mutation, Operation, Repeat, MAX_PAGE_TRACKS, MAX_QUEUE_ENTRIES, MAX_REVISION};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

pub const RECENT_COMMAND_LIMIT: usize = 256;
type Result<T> = std::result::Result<T, ErrorCode>;

pub struct SessionConfig {
    pub engine_id: String,
    pub library_id: String,
    pub label: String,
    pub output: Option<Output>,
}

/// Owner-private run identity, freshly generated on play, repeat, seek and resume.
/// A later renderer binding must correlate this with the exact media session, not
/// infer completion from HTTP EOF, bytes sent or an unqualified STOPPED event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunToken(uuid::Uuid);

#[derive(Clone, Debug)]
pub enum RendererAction {
    Play { entry: QueueEntry, token: RunToken },
    Pause,
    Resume { token: RunToken },
    Seek { position_seconds: f64, token: RunToken },
    Stop,
}

impl RendererAction {
    pub fn token(&self) -> Option<&RunToken> {
        match self {
            Self::Play { token, .. } | Self::Resume { token } | Self::Seek { token, .. } => Some(token),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct RendererError;

pub trait Renderer: Send {
    /// Exactly one bounded control submission; errors may mean an uncertain effect.
    /// Do not call back into the owner inline or share its lock with media delivery.
    /// Started/Completed events are delivered separately on the control dispatcher.
    fn apply(&mut self, action: &RendererAction) -> std::result::Result<(), RendererError>;
}

pub enum RendererEvent {
    Started(RunToken),
    Completed(RunToken),
    Failed(RunToken),
    ExternalTakeover(RunToken),
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Activity { Idle, Loading, Playing, Paused }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackOwner {
    None,
    Core,
    External,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPlaybackInfo {
    pub active: bool,
    pub transport_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_seconds: Option<f64>,
}

#[derive(Clone)]
struct State {
    revision: u64,
    entries: Vec<QueueEntry>,
    current: Option<String>,
    repeat: Repeat,
    shuffle: bool,
    order: Vec<usize>,
    activity: Activity,
    position: f64,
    run: Option<RunToken>,
    ready: bool,
    external_playback: Option<ExternalPlaybackInfo>,
}

impl State {
    fn current_index(&self) -> Option<usize> {
        self.current.as_ref().and_then(|id| self.entries.iter().position(|entry| &entry.entry_id == id))
    }

    fn rebuild_order(&mut self) {
        self.order = (0..self.entries.len()).collect();
        if !self.shuffle { return; }
        // Keep the current entry first; visit every other queue entry once per cycle.
        let start = if let Some(current) = self.current_index() {
            self.order.swap(0, current); 1
        } else { 0 };
        for i in (start + 1..self.order.len()).rev() {
            let random = uuid::Uuid::new_v4().as_u128();
            let j = start + (random % (i - start + 1) as u128) as usize;
            self.order.swap(i, j);
        }
    }

    fn start(&mut self, index: usize) -> RendererAction {
        let entry = self.entries[index].clone();
        self.current = Some(entry.entry_id.clone());
        self.activity = Activity::Loading;
        self.position = 0.0;
        let token = RunToken(uuid::Uuid::new_v4());
        self.run = Some(token.clone());
        RendererAction::Play { entry, token }
    }

    fn stop(&mut self) {
        self.activity = Activity::Idle;
        self.position = 0.0;
        self.run = None;
    }

    fn next(&mut self, automatic: bool) -> Option<RendererAction> {
        let current = self.current_index();
        if automatic && self.repeat == Repeat::One {
            if let Some(index) = current { return Some(self.start(index)); }
        }
        let position = current.and_then(|i| self.order.iter().position(|&v| v == i));
        let next = position.map_or(0, |p| p + 1);
        if next < self.order.len() { return Some(self.start(self.order[next])); }
        if self.repeat == Repeat::All && !self.order.is_empty() {
            if self.shuffle {
                self.rebuild_order();
                // Current was placed first. Begin a new cycle on a different entry.
                if self.order.len() > 1 { self.order.rotate_left(1); }
            }
            return Some(self.start(self.order[0]));
        }
        self.stop();
        if automatic { None } else { Some(RendererAction::Stop) }
    }
}

struct Receipt { id: String, fingerprint: [u8; 32], outcome: Result<()> }
struct Session<R> { state: State, renderer: R, recent: VecDeque<Receipt> }

pub struct SessionOwner<R> {
    config: SessionConfig,
    catalog: Vec<CatalogTrack>,
    durations: HashMap<String, f64>,
    session: Mutex<Session<R>>,
}

impl<R: Renderer> SessionOwner<R> {
    /// Catalog is an immutable, already prepared in-memory projection. Loading it
    /// and admitting/locking media remain the future platform owner's responsibility.
    pub fn new(config: SessionConfig, catalog: Vec<CatalogTrack>, renderer: R) -> Result<Self> {
        token(&config.engine_id)?; token(&config.library_id)?; text(&config.label)?;
        ensure(!config.label.trim().is_empty())?;
        ensure((config.engine_id == "local") == (config.library_id == "local"))?;
        if let Some(output) = &config.output {
            token(&output.id)?; text(&output.label)?;
            ensure(matches!(output.transport.as_str(), "upnp" | "wasapi" | "system_default"))?;
        }
        let mut durations = HashMap::new();
        for track in &catalog {
            token(&track.id)?; text(&track.title)?; text(&track.artist)?; text(&track.album)?; seconds(track.duration_seconds)?;
            if let Some(ref rid) = track.release_id { token(rid)?; }
            if let Some(ref aa) = track.album_artist { text(aa)?; }
            if let Some(ref ed) = track.edition { text(ed)?; }
            ensure(durations.insert(track.id.clone(), track.duration_seconds).is_none())?;
        }
        Ok(Self {
            config, catalog, durations,
            session: Mutex::new(Session {
                state: State { revision: 0, entries: vec![], current: None, repeat: Repeat::Off,
                    shuffle: false, order: vec![], activity: Activity::Idle, position: 0.0, run: None, ready: true,
                    external_playback: None },
                renderer, recent: VecDeque::with_capacity(RECENT_COMMAND_LIMIT),
            }),
        })
    }

    /// In-process authorized port, not a network endpoint or authentication check.
    /// A future transport must authenticate the peer and cap bytes BEFORE buffering.
    pub fn request(&self, input: &[u8]) -> Value {
        let result = (|| {
            let operation = protocol::parse(input, &self.config.engine_id, &self.config.library_id).map_err(|code| (code, None))?;
            let mut session = self.session.lock().map_err(|_| (ErrorCode::Unavailable, None))?;
            match operation {
                Operation::Hello => Ok(json!({"protocolVersion":1,"engineId":self.config.engine_id,
                    "libraryId":self.config.library_id,"label":self.config.label,
                    "capabilities":["catalog.read","session.read","playback.control","queue.write","queue.coordinate"],
                    "ready":session.state.ready})),
                Operation::Snapshot => Ok(self.snapshot(&session.state)),
                Operation::Page { cursor, limit } => self.page(cursor, limit),
                Operation::Mutate(command) => self.execute(&mut session, command),
            }.map_err(|code| (code, if code == ErrorCode::StaleRevision { Some(self.snapshot(&session.state)) } else { None }))
        })();
        let response = match result {
            Ok(data) => json!({"ok":true,"data":data}),
            Err((code, snapshot)) => {
                let mut error = json!({"code":code});
                if let Some(snapshot) = snapshot { error["snapshot"] = snapshot; }
                json!({"ok":false,"error":error})
            }
        };
        if serde_json::to_vec(&response).map_or(true, |bytes| bytes.len() > MAX_MESSAGE_BYTES) {
            json!({"ok":false,"error":{"code":"invalid_payload"}})
        } else { response }
    }

    fn page_value(&self, start: usize, limit: usize, budget: usize) -> Value {
        let mut tracks = Vec::new();
        let mut used = 0;
        for track in self.catalog.iter().skip(start).take(limit) {
            let size = serde_json::to_vec(track).expect("validated finite catalog").len() + 1;
            if used + size > budget { break; }
            used += size; tracks.push(track);
        }
        let end = start + tracks.len();
        json!({"revision":0,"tracks":tracks,"nextCursor":if end < self.catalog.len() { Some(format!("page_{end}")) } else { None }})
    }

    fn page(&self, cursor: Option<String>, limit: usize) -> Result<Value> {
        let start = if let Some(cursor) = cursor {
            let index = cursor.strip_prefix("page_").and_then(|v| v.parse::<usize>().ok()).ok_or(ErrorCode::InvalidPayload)?;
            ensure(index > 0 && index < self.catalog.len() && cursor == format!("page_{index}"))?;
            index
        } else { 0 };
        Ok(self.page_value(start, limit, MAX_MESSAGE_BYTES - 1024))
    }

    fn base_snapshot(&self, state: &State) -> Value {
        let external_active = state.external_playback.as_ref().is_some_and(|ext| ext.active);
        let owner = if state.activity != Activity::Idle {
            PlaybackOwner::Core
        } else if external_active {
            PlaybackOwner::External
        } else {
            PlaybackOwner::None
        };
        let takeover_required = matches!(owner, PlaybackOwner::External);
        let mut playback = json!({
            "activity": state.activity,
            "positionSeconds": state.position,
            "owner": owner,
            "takeoverRequired": takeover_required,
        });
        if let Some(ref ext) = state.external_playback {
            playback["externalPlayback"] = json!(ext);
        }
        json!({"engineId":self.config.engine_id,"libraryId":self.config.library_id,
            "revision":state.revision,"catalog":{"revision":0,"tracks":[],"nextCursor":null},
            "queue":{"entries":state.entries,"currentEntryId":state.current,"repeat":state.repeat,"shuffle":state.shuffle},
            "playback":playback,"output":self.config.output})
    }

    fn snapshot(&self, state: &State) -> Value {
        let mut snapshot = self.base_snapshot(state);
        let used = serde_json::to_vec(&snapshot).expect("validated state").len();
        snapshot["catalog"] = self.page_value(0, MAX_PAGE_TRACKS, MAX_MESSAGE_BYTES.saturating_sub(used + 1024));
        snapshot
    }

    fn execute(&self, session: &mut Session<R>, command: Mutation) -> Result<Value> {
        if let Some(receipt) = session.recent.iter().find(|r| r.id == command.id) {
            ensure(receipt.fingerprint == command.fingerprint)?;
            receipt.outcome?;
            return Ok(self.snapshot(&session.state));
        }
        let outcome = self.apply_command(session, &command);
        if session.recent.len() == RECENT_COMMAND_LIMIT { session.recent.pop_front(); }
        session.recent.push_back(Receipt { id: command.id, fingerprint: command.fingerprint, outcome });
        outcome?;
        Ok(self.snapshot(&session.state))
    }

    fn apply_command(&self, session: &mut Session<R>, command: &Mutation) -> Result<()> {
        if command.revision != session.state.revision { return Err(ErrorCode::StaleRevision); }
        let external_active = session.state.external_playback.as_ref().is_some_and(|e| e.active);
        let confirmed_takeover = matches!(command.action, Action::Play { force_takeover: true, .. });
        if !session.state.ready && !matches!(command.action, Action::Stop) && !(confirmed_takeover && external_active) {
            return Err(ErrorCode::NotReady);
        }
        if matches!(command.action, Action::Play { force_takeover: false, .. }) && external_active {
            return Err(ErrorCode::TakeoverRequired);
        }
        ensure(session.state.revision < MAX_REVISION)?;
        let mut next = session.state.clone();
        let effect = self.plan(&mut next, &command.action)?;
        // Reserve space for one maximal track in a stale snapshot too (larger envelope).
        ensure(serde_json::to_vec(&self.base_snapshot(&next)).map_or(false, |v| v.len() < MAX_MESSAGE_BYTES - 16_384))?;
        next.revision += 1; // Even accepted no-ops consume a revision: evicted retries stay stale.
        self.commit(session, next, effect)
    }

    fn plan(&self, next: &mut State, action: &Action) -> Result<Option<RendererAction>> {
        match action {
            Action::Replace(entries) => {
                for entry in entries {
                    ensure(self.durations.contains_key(&entry.track_id))?;
                    if let Some(old) = next.entries.iter().find(|old| old.entry_id == entry.entry_id) {
                        ensure(old.track_id == entry.track_id)?;
                    }
                }
                let current = next.current.clone();
                next.entries = entries.clone();
                let removed = current.is_some() && next.current_index().is_none();
                let must_stop = removed && next.activity != Activity::Idle;
                if removed { next.current = None; next.stop(); }
                next.rebuild_order();
                Ok(if must_stop { Some(RendererAction::Stop) } else { None })
            }
            Action::Modes { repeat, shuffle } => {
                next.repeat = *repeat;
                if next.shuffle != *shuffle { next.shuffle = *shuffle; next.rebuild_order(); }
                Ok(None)
            }
            Action::Stop => {
                next.stop(); next.ready = true; next.external_playback = None;
                Ok(Some(RendererAction::Stop))
            }
            Action::Pause => {
                if next.activity == Activity::Paused { return Ok(None); }
                ensure(next.activity == Activity::Playing)?;
                next.activity = Activity::Paused;
                Ok(Some(RendererAction::Pause))
            }
            Action::Resume => {
                if next.activity == Activity::Playing { return Ok(None); }
                ensure(next.activity == Activity::Paused)?;
                let token = RunToken(uuid::Uuid::new_v4()); next.run = Some(token.clone()); next.activity = Activity::Loading;
                Ok(Some(RendererAction::Resume { token }))
            }
            Action::Seek(position) => {
                ensure(matches!(next.activity, Activity::Playing | Activity::Paused))?;
                let index = next.current_index().ok_or(ErrorCode::InvalidPayload)?;
                ensure(*position <= self.durations[&next.entries[index].track_id])?;
                next.position = *position;
                let token = RunToken(uuid::Uuid::new_v4());
                next.run = Some(token.clone());
                if next.activity == Activity::Playing { next.activity = Activity::Loading; }
                Ok(Some(RendererAction::Seek { position_seconds: *position, token }))
            }
            Action::Play { track_id: track, force_takeover } => {
                self.require_output()?;
                ensure(self.durations.contains_key(track))?;
                if *force_takeover {
                    next.external_playback = None;
                    next.ready = true;
                }
                let index = next.current_index().filter(|&i| next.entries[i].track_id == *track)
                    .or_else(|| next.entries.iter().position(|entry| entry.track_id == *track));
                let index = match index {
                    Some(index) => index,
                    None => {
                        ensure(next.entries.len() < MAX_QUEUE_ENTRIES)?;
                        next.entries.push(QueueEntry { entry_id: uuid::Uuid::new_v4().to_string(), track_id: track.clone() });
                        next.rebuild_order(); next.entries.len() - 1
                    }
                };
                Ok(Some(next.start(index)))
            }
            Action::Jump(id) => {
                self.require_output()?;
                let index = next.entries.iter().position(|entry| entry.entry_id == *id).ok_or(ErrorCode::InvalidPayload)?;
                Ok(Some(next.start(index)))
            }
            Action::Next => { self.require_output()?; Ok(next.next(false)) }
            Action::Previous => {
                self.require_output()?;
                ensure(!next.order.is_empty())?;
                let position = next.current_index().and_then(|i| next.order.iter().position(|&v| v == i)).unwrap_or(0);
                let previous = if position == 0 && next.repeat == Repeat::All { next.order.len() - 1 } else { position.saturating_sub(1) };
                Ok(Some(next.start(next.order[previous])))
            }
        }
    }

    fn require_output(&self) -> Result<()> {
        if self.config.output.is_some() { Ok(()) } else { Err(ErrorCode::NotReady) }
    }

    fn commit(&self, session: &mut Session<R>, mut next: State, effect: Option<RendererAction>) -> Result<()> {
        if let Some(effect) = effect {
            if session.renderer.apply(&effect).is_err() {
                // Never replay an uncertain effect. Keep the attempted projection,
                // quarantine authority and invalidate events until explicit Stop ACK.
                next.ready = false; next.run = None; session.state = next;
                return Err(ErrorCode::Unavailable);
            }
        }
        session.state = next;
        Ok(())
    }

    /// Dispatch qualified renderer events independently of controller connections.
    /// Returns false for duplicate/late events, with no revision or renderer effect.
    pub fn on_renderer_event(&self, event: RendererEvent) -> Result<bool> {
        let mut session = self.session.lock().map_err(|_| ErrorCode::Unavailable)?;
        let token = match &event {
            RendererEvent::Started(t) | RendererEvent::Completed(t) | RendererEvent::Failed(t) | RendererEvent::ExternalTakeover(t) => t,
        };
        if !session.state.ready || session.state.run.as_ref() != Some(token) { return Ok(false); }
        let mut next = session.state.clone();
        let effect = match event {
            RendererEvent::Started(_) => {
                if next.activity != Activity::Loading { return Ok(false); }
                next.activity = Activity::Playing; None
            }
            RendererEvent::Completed(_) => {
                if next.activity != Activity::Playing { return Ok(false); }
                next.next(true)
            }
            RendererEvent::Failed(_) => {
                next.ready = false;
                next.stop();
                None
            }
            RendererEvent::ExternalTakeover(_) => {
                next.ready = false;
                next.stop();
                next.external_playback = Some(ExternalPlaybackInfo {
                    active: true,
                    transport_state: "PLAYING".into(),
                    current_uri: None,
                    position_seconds: None,
                });
                None
            }
        };
        ensure(next.revision < MAX_REVISION)?; next.revision += 1;
        self.commit(&mut session, next, effect)?;
        Ok(true)
    }

    pub fn sync_external_renderer(&self, info: Option<ExternalPlaybackInfo>) -> Result<bool> {
        let mut session = self.session.lock().map_err(|_| ErrorCode::Unavailable)?;
        if session.state.run.is_some() || session.state.activity != Activity::Idle {
            return Ok(false);
        }
        if session.state.external_playback == info {
            return Ok(false);
        }
        session.state.external_playback = info;
        if session.state.revision < MAX_REVISION {
            session.state.revision += 1;
        }
        Ok(true)
    }

    pub fn on_renderer_external_takeover(
        &self,
        token: RunToken,
        transport_state: String,
        current_uri: Option<String>,
        position_seconds: Option<f64>,
    ) -> Result<bool> {
        let mut session = self.session.lock().map_err(|_| ErrorCode::Unavailable)?;
        if !session.state.ready || session.state.run.as_ref() != Some(&token) {
            return Ok(false);
        }
        let mut next = session.state.clone();
        next.ready = false;
        next.stop();
        next.external_playback = Some(ExternalPlaybackInfo {
            active: true,
            transport_state,
            current_uri,
            position_seconds,
        });
        ensure(next.revision < MAX_REVISION)?;
        next.revision += 1;
        self.commit(&mut session, next, None)?;
        Ok(true)
    }

    pub fn sync_active_playback(
        &self,
        token: &RunToken,
        transport_state: &str,
        position_seconds: Option<f64>,
    ) -> Result<bool> {
        let mut session = self.session.lock().map_err(|_| ErrorCode::Unavailable)?;
        if !session.state.ready || session.state.run.as_ref() != Some(token) {
            return Ok(false);
        }
        let max_duration = session
            .state
            .current_index()
            .and_then(|idx| self.durations.get(&session.state.entries[idx].track_id).copied())
            .unwrap_or(MAX_REVISION as f64);
        let clamp_pos = position_seconds
            .filter(|p| p.is_finite() && *p >= 0.0)
            .map(|p| p.min(max_duration));

        match transport_state {
            "PAUSED_PLAYBACK" => {
                let mut changed = false;
                if session.state.activity != Activity::Paused {
                    session.state.activity = Activity::Paused;
                    if let Some(pos) = clamp_pos {
                        session.state.position = pos;
                    }
                    ensure(session.state.revision < MAX_REVISION)?;
                    session.state.revision += 1;
                    changed = true;
                } else if let Some(pos) = clamp_pos {
                    if (session.state.position - pos).abs() > 0.25 {
                        session.state.position = pos;
                    }
                }
                Ok(changed)
            }
            "PLAYING" => {
                let mut changed = false;
                if matches!(session.state.activity, Activity::Loading | Activity::Paused) {
                    session.state.activity = Activity::Playing;
                    if let Some(pos) = clamp_pos {
                        session.state.position = pos;
                    }
                    ensure(session.state.revision < MAX_REVISION)?;
                    session.state.revision += 1;
                    changed = true;
                } else if let Some(pos) = clamp_pos {
                    session.state.position = pos;
                }
                Ok(changed)
            }
            _ => Ok(false),
        }
    }

    pub(crate) fn is_external_playback_blocking_play(&self, force_takeover: bool) -> bool {
        if force_takeover {
            return false;
        }
        self.session
            .lock()
            .map(|s| s.state.external_playback.as_ref().is_some_and(|e| e.active))
            .unwrap_or(false)
    }

    pub(crate) fn current_track_id(&self) -> Option<String> {
        let session = self.session.lock().ok()?;
        session
            .state
            .current_index()
            .and_then(|idx| session.state.entries.get(idx))
            .map(|entry| entry.track_id.clone())
    }

    pub(crate) fn resolve_queue_transition_targets(
        &self,
        action: &str,
        entry_id: Option<&str>,
    ) -> Vec<String> {
        let Ok(session) = self.session.lock() else {
            return Vec::new();
        };
        let state = &session.state;
        if state.entries.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut push_entry_idx = |entry_idx: usize| {
            if let Some(entry) = state.entries.get(entry_idx) {
                if !out.contains(&entry.track_id) {
                    out.push(entry.track_id.clone());
                }
            }
        };

        match action {
            "jump" => {
                if let Some(target_eid) = entry_id {
                    if let Some(entry_idx) =
                        state.entries.iter().position(|e| e.entry_id == target_eid)
                    {
                        push_entry_idx(entry_idx);
                        if let Some(ord_pos) = state.order.iter().position(|&v| v == entry_idx) {
                            if let Some(&next_idx) = state.order.get(ord_pos + 1) {
                                push_entry_idx(next_idx);
                            } else if state.repeat == Repeat::All && !state.order.is_empty() {
                                push_entry_idx(state.order[0]);
                            }
                        }
                    }
                }
            }
            "next" => {
                let cur_idx = state.current_index();
                let ord_pos = cur_idx.and_then(|i| state.order.iter().position(|&v| v == i));
                let next_ord_pos = ord_pos.map_or(0, |p| p + 1);
                if let Some(&target_idx) = state.order.get(next_ord_pos) {
                    push_entry_idx(target_idx);
                    if let Some(&lookahead_idx) = state.order.get(next_ord_pos + 1) {
                        push_entry_idx(lookahead_idx);
                    }
                } else if state.repeat == Repeat::All && !state.order.is_empty() {
                    let target_pos = if state.shuffle && state.order.len() > 1 {
                        1
                    } else {
                        0
                    };
                    push_entry_idx(state.order[target_pos]);
                    if state.order.len() > target_pos + 1 {
                        push_entry_idx(state.order[target_pos + 1]);
                    }
                }
            }
            "previous" => {
                if state.order.is_empty() {
                    return out;
                }
                let position = state
                    .current_index()
                    .and_then(|i| state.order.iter().position(|&v| v == i))
                    .unwrap_or(0);
                let prev_pos = if position == 0 && state.repeat == Repeat::All {
                    state.order.len() - 1
                } else {
                    position.saturating_sub(1)
                };
                if let Some(&target_idx) = state.order.get(prev_pos) {
                    push_entry_idx(target_idx);
                    if let Some(&next_idx) = state.order.get(prev_pos + 1) {
                        push_entry_idx(next_idx);
                    }
                }
            }
            _ => {}
        }
        out
    }
}
