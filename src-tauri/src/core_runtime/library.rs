//! Headless library authority. Called only on the serialized control dispatcher.
//! Library filesystem operations require the runtime's idle permit; protected
//! browsing/artwork are served exclusively from bounded RAM caches.
use crate::db::AppDb;
use crate::scanner::{media, EngineProgressSink};
use lofty::tag::{Accessor, ItemKey};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

type Result<T> = std::result::Result<T, String>;
const MAX_LIST: usize = 4096;
const MAX_ART_BYTES: usize = 4 * 1024 * 1024;
const MAX_ART_CACHE_BYTES: usize = 32 * 1024 * 1024;

pub struct Library {
    db: AppDb,
    roots: Vec<PathBuf>,
    browse_cache: HashMap<PathBuf, Value>,
    art_cache: HashMap<String, (String, Vec<u8>)>,
    pending: VecDeque<(String, PathBuf)>,
    scan: Value,
    revision: u64,
    events: std::sync::Mutex<VecDeque<Value>>,
}

impl EngineProgressSink for std::sync::Mutex<VecDeque<Value>> {
    fn progress(&self, event: &str, payload: Value) {
        if let Ok(mut q) = self.lock() {
            if q.len() == 64 {
                q.pop_front();
            }
            q.push_back(json!({"event":event,"data":payload}));
        }
    }
}

pub fn token(prefix: &str, raw: &str) -> String {
    let hash = Sha256::digest(raw.as_bytes());
    format!(
        "{prefix}_{}",
        hash.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

impl Library {
    pub fn open(db: AppDb, roots: Vec<PathBuf>) -> Result<Self> {
        let roots: Vec<PathBuf> = roots
            .iter()
            .map(|p| {
                p.canonicalize()
                    .map(normalize_root)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<_>>()?;
        if roots.is_empty() {
            return Err("No authorized browse roots".into());
        }
        {
            let mut conn = db.conn.lock();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS engine_authorized_roots(path TEXT PRIMARY KEY); DELETE FROM engine_authorized_roots;").map_err(|e|e.to_string())?;
            for root in &roots {
                tx.execute(
                    "INSERT INTO engine_authorized_roots VALUES(?1)",
                    params![root.to_string_lossy()],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        let (revision, scan) = {
            let conn = db.conn.lock();
            for column in ["language", "lyrics"] {
                let mut stmt = conn
                    .prepare("PRAGMA table_info(tracks)")
                    .map_err(|e| e.to_string())?;
                let names = stmt
                    .query_map([], |r| r.get::<_, String>(1))
                    .map_err(|e| e.to_string())?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                if !names.iter().any(|n| n == column) {
                    conn.execute(&format!("ALTER TABLE tracks ADD COLUMN {column} TEXT"), [])
                        .map_err(|e| e.to_string())?;
                }
            }
            conn.execute_batch("CREATE TABLE IF NOT EXISTS engine_library_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, scan_json TEXT NOT NULL);
                INSERT OR IGNORE INTO engine_library_state VALUES(1,0,'{\"status\":\"idle\"}');
                CREATE TABLE IF NOT EXISTS engine_transport_guard(id INTEGER PRIMARY KEY,active INTEGER NOT NULL,stopped_ms INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS engine_scan_seen (folder_id TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY(folder_id,track_id));
                CREATE TABLE IF NOT EXISTS engine_artwork (release_id TEXT PRIMARY KEY, etag TEXT NOT NULL, jpeg BLOB NOT NULL);")
                .map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT revision, scan_json FROM engine_library_state WHERE id=1",
                [],
                |r| Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(|e| e.to_string())?
        };
        let mut scan: Value = serde_json::from_str(&scan).map_err(|e| e.to_string())?;
        let mut pending = VecDeque::new();
        if matches!(scan["status"].as_str(), Some("running" | "queued")) {
            // Restart the walk; stable path IDs and per-file upserts make replay safe.
            if let Some(roots) = scan["roots"].as_array() {
                for root in roots {
                    if let (Some(id), Some(path)) = (root["id"].as_str(), root["path"].as_str()) {
                        pending.push_back((id.to_string(), PathBuf::from(path)));
                    }
                }
            } else if let (Some(id), Some(path)) =
                (scan["folderId"].as_str(), scan["path"].as_str())
            {
                pending.push_back((id.to_string(), PathBuf::from(path)));
            }
            scan["status"] = json!("queued");
            scan["processed"] = json!(0);
            scan["errors"] = json!([]);
        }
        let mut library = Self {
            db,
            roots,
            browse_cache: HashMap::new(),
            art_cache: HashMap::new(),
            pending,
            scan,
            revision,
            events: std::sync::Mutex::new(VecDeque::new()),
        };
        if library.pending.is_empty() {
            let jobs = {
                let conn = library.db.conn.lock();
                let mut stmt=conn.prepare("SELECT id,folder_path FROM watched_folders WHERE scan_mode='startup' AND is_enabled=1 ORDER BY id").map_err(|e|e.to_string())?;
                let values = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            PathBuf::from(r.get::<_, String>(1)?),
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                values
            };
            if !jobs.is_empty() {
                let roots = jobs
                    .iter()
                    .map(|(id, path)| json!({"id":id,"path":path}))
                    .collect::<Vec<_>>();
                library.scan = json!({"status":"queued","folderId":jobs[0].0,"path":jobs[0].1,"roots":roots,"processed":0,"errors":[],"forceFull":false});
                library.pending = jobs.into();
                library
                    .db
                    .conn
                    .lock()
                    .execute("DELETE FROM engine_scan_seen", [])
                    .map_err(|e| e.to_string())?;
                library.persist()?;
            }
        }
        Ok(library)
    }

    pub fn recovery_cooldown(&self) -> Result<std::time::Duration> {
        let state: Option<(bool, u64)> = self
            .db
            .conn
            .lock()
            .query_row(
                "SELECT active,stopped_ms FROM engine_transport_guard WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let remaining = state
            .map(|(active, stopped)| {
                if active {
                    30_000
                } else {
                    30_000u64.saturating_sub(epoch_ms().saturating_sub(stopped))
                }
            })
            .unwrap_or(0);
        Ok(std::time::Duration::from_millis(remaining))
    }

    pub fn record_activity(&self, active: bool) -> Result<()> {
        self.db.conn.lock().execute("INSERT INTO engine_transport_guard VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET active=excluded.active,stopped_ms=excluded.stopped_ms",params![active,epoch_ms()]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn take_events(&mut self) -> Vec<Value> {
        self.events
            .lock()
            .map(|mut q| q.drain(..).collect())
            .unwrap_or_default()
    }

    pub fn metadata_changed(&mut self) -> Result<()> {
        self.changed()
    }

    fn persist(&self) -> Result<()> {
        self.db
            .conn
            .lock()
            .execute(
                "UPDATE engine_library_state SET revision=?1, scan_json=?2 WHERE id=1",
                params![self.revision, self.scan.to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn changed(&mut self) -> Result<()> {
        self.revision += 1;
        self.art_cache.clear();
        self.persist()?;
        self.events
            .progress("catalog.changed", json!({"revision":self.revision}));
        Ok(())
    }

    /// Lexical authorization is safe during protected playback (no stat/canonicalize).
    fn authorized(&self, path: &Path) -> Result<()> {
        authorize(&self.roots, path)
    }

    /// Linux openat2 resolves *all* components beneath the authorized root with
    /// NO_SYMLINKS, atomically closing traversal and symlink-swap races. Fail closed
    /// on kernels without openat2 rather than falling back to canonicalize/open.
    pub fn open_path(&self, path: &Path) -> Result<File> {
        open_authorized(&self.roots, path)
    }

    pub fn browse(&mut self, path: Option<&str>, idle: bool) -> Result<Value> {
        let Some(path) = path else {
            return Ok(
                json!({"entries":self.roots.iter().map(|p| json!({"name":p.file_name().unwrap_or_default().to_string_lossy(),"path":p,"isDir":true,"readable":true,"isWatched":false})).collect::<Vec<_>>(),"cached":true}),
            );
        };
        let path = PathBuf::from(path);
        self.authorized(&path)?;
        if !idle {
            return self
                .browse_cache
                .get(&path)
                .cloned()
                .map(|mut v| {
                    v["cached"] = json!(true);
                    v
                })
                .ok_or("deferred_until_idle".into());
        }
        let dir = self.open_path(&path)?;
        if !dir.metadata().map_err(|e| e.to_string())?.is_dir() {
            return Err("Not a directory".into());
        }
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(handle_path(&dir, &path)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entries.len() >= MAX_LIST {
                return Err("Directory entry limit exceeded".into());
            }
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            if !ty.is_dir() || ty.is_symlink() {
                continue;
            }
            let child = path.join(entry.file_name());
            let watched: bool = self
                .db
                .conn
                .lock()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM watched_folders WHERE folder_path=?1)",
                    params![child.to_string_lossy()],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":child,"isDir":true,"readable":true,"isWatched":watched}));
        }
        entries.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_string());
        let value = json!({"entries":entries,"cached":false});
        if self.browse_cache.len() >= 128 {
            self.browse_cache.clear();
        }
        self.browse_cache.insert(path, value.clone());
        Ok(value)
    }

    pub fn request(&mut self, op: &str, req: &Value, idle: bool) -> Result<Value> {
        if op == "fs.browse" {
            return self.browse(req.get("path").and_then(Value::as_str), idle);
        }
        if op == "folders.scan.status" {
            let mut status = self.scan.clone();
            status["deferred"] = json!(!idle);
            return Ok(status);
        }
        if op == "engine.events" {
            return Ok(json!({"events":self.take_events()}));
        }
        if op == "shares.status" {
            return Ok(crate::core_runtime::smb::status_json());
        }
        if op == "shares.list" {
            let shares = crate::core_runtime::smb::list_shares(&self.db)?;
            return Ok(json!({"shares": shares}));
        }
        if !idle {
            return Err("deferred_until_idle".into());
        }
        match op {
            "folders.add" => {
                let path = PathBuf::from(required(req, "path")?);
                let file = self.open_path(&path)?;
                if !file.metadata().map_err(|e| e.to_string())?.is_dir() {
                    return Err("Not a directory".into());
                }
                let mode = req
                    .get("scanMode")
                    .and_then(Value::as_str)
                    .unwrap_or("manual");
                if !matches!(mode, "manual" | "startup") {
                    return Err("Supported headless scan modes: manual or startup".into());
                }
                let id = token("folder", &path.to_string_lossy());
                let mount = token("mount", &path.to_string_lossy());
                let title = req
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| {
                        path.file_name().and_then(|s| s.to_str()).unwrap_or("Music")
                    });
                let mut conn = self.db.conn.lock();
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                tx.execute("INSERT OR IGNORE INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES(?1,?2,?3,'local_disk','native',CURRENT_TIMESTAMP)",params![mount,title,path.to_string_lossy()]).map_err(|e| e.to_string())?;
                tx.execute("INSERT INTO watched_folders(id,mount_id,folder_path,display_name,scan_mode) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(folder_path) DO UPDATE SET display_name=excluded.display_name, scan_mode=excluded.scan_mode",params![id,mount,path.to_string_lossy(),title,mode]).map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                self.browse_cache.clear();
                Ok(json!({"id":id}))
            }
            "folders.list" => {
                let conn = self.db.conn.lock();
                let mut stmt = conn.prepare("SELECT id, folder_path, display_name, scan_mode, last_scanned_timestamp, (SELECT count(*) FROM tracks t WHERE t.mount_id=w.mount_id) FROM watched_folders w ORDER BY folder_path").map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, i64>(5)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;
                let mut folders = Vec::new();
                for row in rows {
                    let (id, path, name, mode, last, count) = row.map_err(|e| e.to_string())?;
                    let online = self
                        .open_path(Path::new(&path))
                        .and_then(|f| f.metadata().map_err(|e| e.to_string()))
                        .is_ok_and(|m| m.is_dir());
                    folders.push(json!({"id":id,"path":path,"displayName":name,"scanMode":mode,"lastScannedAt":last,"trackCount":count,"online":online}));
                }
                Ok(json!({"folders":folders}))
            }
            "folders.remove" => {
                let id = required(req, "folderId")?;
                if self.scan["folderId"].as_str() == Some(id) && !self.pending.is_empty() {
                    return Err("Scan in progress".into());
                }
                // Removing a watcher preserves catalog identities and playlists.
                self.db
                    .conn
                    .lock()
                    .execute("DELETE FROM watched_folders WHERE id=?1", params![id])
                    .map_err(|e| e.to_string())?;
                self.browse_cache.clear();
                Ok(json!({"removed":true}))
            }
            "folders.scan" => {
                if !self.pending.is_empty() {
                    return Err("Scan already queued".into());
                }
                let conn = self.db.conn.lock();
                let id = req.get("folderId").and_then(Value::as_str);
                let mut stmt=conn.prepare("SELECT id,folder_path FROM watched_folders WHERE is_enabled=1 AND (?1 IS NULL OR id=?1) ORDER BY id").map_err(|e|e.to_string())?;
                let roots = stmt
                    .query_map(params![id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            PathBuf::from(r.get::<_, String>(1)?),
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                if roots.is_empty() {
                    return Err("Folder not found".into());
                }
                // One durable job at a time; absent folderId queues all roots as jobs.
                let root_jobs = roots
                    .iter()
                    .map(|(id, path)| json!({"id":id,"path":path}))
                    .collect::<Vec<_>>();
                self.pending = roots.into();
                let (id, path) = self.pending.front().unwrap();
                self.scan = json!({"status":"queued","folderId":id,"path":path,"processed":0,"errors":[],"forceFull":req["forceFull"].as_bool().unwrap_or(false),"roots":root_jobs});
                conn.execute("DELETE FROM engine_scan_seen", [])
                    .map_err(|e| e.to_string())?;
                drop(stmt);
                drop(conn);
                self.persist()?;
                Ok(self.scan.clone())
            }
            "playlists.list" => {
                let conn = self.db.conn.lock();
                let mut stmt = conn
                    .prepare(
                        "SELECT id,title,description FROM playlists ORDER BY title,id LIMIT 4096",
                    )
                    .map_err(|e| e.to_string())?;
                let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"description":r.get::<_,Option<String>>(2)?}))).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
                Ok(json!({"playlists":rows}))
            }
            "playlists.create" => {
                let title = required(req, "title")?;
                let id = format!("playlist_{}", uuid::Uuid::new_v4().simple());
                self.db.conn.lock().execute("INSERT INTO playlists(id,title,description,created_at,updated_at) VALUES(?1,?2,?3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",params![id,title,req.get("description").and_then(Value::as_str)]).map_err(|e|e.to_string())?;
                Ok(json!({"id":id,"title":title,"trackIds":[]}))
            }
            "playlists.get" | "playlists.update" | "playlists.delete" | "playlists.setTracks" => {
                self.playlist(op, req)
            }
            "releases.split.list" => {
                let conn = self.db.conn.lock();
                let mut stmt = conn
                    .prepare("SELECT release_id FROM user_split_releases ORDER BY release_id")
                    .map_err(|e| e.to_string())?;
                let ids = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                Ok(json!({"releaseIds":ids}))
            }
            "releases.split.toggle" => {
                let id = required(req, "releaseId")?;
                let conn = self.db.conn.lock();
                let exists: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM releases WHERE id=?1)",
                        params![id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !exists {
                    return Err("Release not found".into());
                }
                let n = conn
                    .execute(
                        "DELETE FROM user_split_releases WHERE release_id=?1",
                        params![id],
                    )
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    conn.execute(
                        "INSERT INTO user_split_releases VALUES(?1,?2)",
                        params![id, chrono::Utc::now().timestamp()],
                    )
                    .map_err(|e| e.to_string())?;
                }
                Ok(json!({"split":n==0}))
            }
            "curate.draft.list" => {
                let conn = self.db.conn.lock();
                let mut stmt=conn.prepare("SELECT draft_id,track_id,revision,status,changes_json FROM remote_curate_drafts ORDER BY updated_at DESC LIMIT 4096").map_err(|e|e.to_string())?;
                let records=stmt.query_map([],|r|Ok(json!({"draftId":r.get::<_,String>(0)?,"trackId":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"status":r.get::<_,String>(3)?,"changes":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(Value::Null)}))).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
                Ok(json!({"drafts":records}))
            }
            "shares.add" => {
                let server = required(req, "server")?.to_string();
                let share = required(req, "share")?.to_string();
                let username = req.get("username").and_then(Value::as_str).map(str::to_string);
                let password = req.get("password").and_then(Value::as_str).map(str::to_string);
                let smb_version = req.get("smbVersion").and_then(Value::as_str).map(str::to_string);
                let read_only = req.get("readOnly").and_then(Value::as_bool).unwrap_or(true);
                let display_name = req.get("displayName").and_then(Value::as_str).map(str::to_string);
                let record = crate::core_runtime::smb::add_and_mount_share(
                    &self.db,
                    crate::core_runtime::smb::AddShareInput {
                        server,
                        share,
                        username,
                        password,
                        smb_version,
                        read_only,
                        display_name,
                    },
                )?;
                let mount_pb = PathBuf::from(&record.mount_path);
                if !self.roots.contains(&mount_pb) {
                    self.roots.push(mount_pb.clone());
                    let _ = self.db.conn.lock().execute(
                        "INSERT OR IGNORE INTO engine_authorized_roots VALUES(?1)",
                        params![mount_pb.to_string_lossy()],
                    );
                }
                self.browse_cache.clear();
                self.events.lock().unwrap().push_back(json!({"event": "catalog.changed"}));
                Ok(json!({"share": record}))
            }
            "shares.remove" => {
                let share_id = required(req, "shareId")?;
                let removed_mount = crate::core_runtime::smb::remove_and_unmount_share(&self.db, share_id)?;
                if let Some(ref mount_str) = removed_mount {
                    let mount_pb = PathBuf::from(mount_str);
                    self.roots.retain(|r| r != &mount_pb);
                    let _ = self.db.conn.lock().execute(
                        "DELETE FROM engine_authorized_roots WHERE path=?1",
                        params![mount_str],
                    );
                    self.browse_cache.clear();
                    self.events.lock().unwrap().push_back(json!({"event": "catalog.changed"}));
                }
                Ok(json!({"removed": removed_mount.is_some()}))
            }
            _ => Err("unsupported_capability".into()),
        }
    }

    fn playlist(&self, op: &str, req: &Value) -> Result<Value> {
        let id = required(req, "playlistId")?;
        let mut conn = self.db.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let (mut title, mut description): (String, Option<String>) = tx
            .query_row(
                "SELECT title,description FROM playlists WHERE id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("Playlist not found")?;
        match op {
            "playlists.update" => {
                title = required(req, "title")?.to_string();
                description = req
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                tx.execute("UPDATE playlists SET title=?2,description=?3,updated_at=CURRENT_TIMESTAMP WHERE id=?1",params![id,title,description]).map_err(|e|e.to_string())?;
            }
            "playlists.delete" => {
                tx.execute("DELETE FROM playlists WHERE id=?1", params![id])
                    .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(json!({"deleted":true}));
            }
            "playlists.setTracks" => {
                let ids = req["trackIds"]
                    .as_array()
                    .filter(|v| v.len() <= MAX_LIST)
                    .ok_or("Invalid trackIds")?;
                tx.execute(
                    "DELETE FROM playlist_tracks WHERE playlist_id=?1",
                    params![id],
                )
                .map_err(|e| e.to_string())?;
                for (i, track) in ids.iter().enumerate() {
                    let track = track.as_str().ok_or("Invalid track ID")?;
                    let exists: bool = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM tracks WHERE id=?1 AND is_online=1)",
                            params![track],
                            |r| r.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    if !exists {
                        return Err("Track not found".into());
                    }
                    tx.execute("INSERT INTO playlist_tracks(playlist_id,track_id,position,added_at) VALUES(?1,?2,?3,CURRENT_TIMESTAMP)",params![id,track,i as i64]).map_err(|e|e.to_string())?;
                }
                tx.execute(
                    "UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                )
                .map_err(|e| e.to_string())?;
            }
            _ => {}
        }
        let ids = {
            let mut stmt = tx
                .prepare(
                    "SELECT track_id FROM playlist_tracks WHERE playlist_id=?1 ORDER BY position",
                )
                .map_err(|e| e.to_string())?;
            let values = stmt
                .query_map(params![id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            values
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(json!({"id":id,"title":title,"description":description,"trackIds":ids}))
    }

    /// Exactly one directory/file per dispatcher turn; the runtime mutex is also
    /// the playback-start barrier. Never called without an idle/cooldown permit.
    pub fn step(&mut self) -> Result<bool> {
        let Some((folder_id, path)) = self.pending.pop_front() else {
            return Ok(false);
        };
        self.scan["status"] = json!("running");
        let result = self.scan_path(&folder_id, &path);
        if let Err(error) = result {
            let errors = self.scan["errors"]
                .as_array_mut()
                .ok_or("Invalid scan state")?;
            if errors.len() < 100 {
                errors.push(json!({"path":path,"message":error}));
            }
        }
        self.scan["processed"] = json!(self.scan["processed"].as_u64().unwrap_or(0) + 1);
        if self.pending.is_empty() {
            let failed = self.scan["errors"]
                .as_array()
                .is_some_and(|v| !v.is_empty());
            self.scan["status"] = json!(if failed { "failed" } else { "completed" });
            if !failed {
                if let Some(roots) = self.scan["roots"].as_array() {
                    for root in roots {
                        let conn = self.db.conn.lock();
                        conn.execute("UPDATE tracks SET is_online=0 WHERE mount_id=(SELECT mount_id FROM watched_folders WHERE id=?1) AND id NOT IN (SELECT track_id FROM engine_scan_seen WHERE folder_id=?1)",params![root["id"].as_str()]).map_err(|e|e.to_string())?;
                        conn.execute("UPDATE watched_folders SET last_scanned_timestamp=CURRENT_TIMESTAMP WHERE id=?1",params![root["id"].as_str()]).map_err(|e|e.to_string())?;
                    }
                }
            }
            self.browse_cache.clear();
        }
        let completed = self.pending.is_empty();
        if completed {
            self.changed()?;
        } else {
            self.persist()?;
        }
        self.events.progress("scan.progress", self.scan.clone());
        Ok(completed)
    }

    fn scan_path(&mut self, folder_id: &str, path: &Path) -> Result<()> {
        let file = self.open_path(path)?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if metadata.is_dir() {
            let mut entries = std::fs::read_dir(handle_path(&file, path))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            if entries.len() > 100_000 {
                return Err("Scan directory limit exceeded".into());
            }
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let ty = entry.file_type().map_err(|e| e.to_string())?;
                if ty.is_symlink() {
                    continue;
                }
                let child = path.join(entry.file_name());
                let ext = child
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if ty.is_dir()
                    || (ty.is_file()
                        && matches!(
                            ext.as_str(),
                            "wav"
                                | "flac"
                                | "mp3"
                                | "m4a"
                                | "aif"
                                | "aiff"
                                | "ogg"
                                | "aac"
                                | "dsf"
                                | "dff"
                                | "dsdiff"
                        ))
                {
                    if self.pending.len() >= 100_000 {
                        return Err("Scan queue limit exceeded".into());
                    }
                    self.pending.push_back((folder_id.to_string(), child));
                }
            }
            return Ok(());
        }
        if !metadata.is_file() {
            return Err("Not a regular file".into());
        }
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let existing: Option<(String, String, i64, i64)> = self
            .db
            .conn
            .lock()
            .query_row(
                "SELECT id,release_id,mtime,file_size FROM tracks WHERE file_path=?1",
                params![path.to_string_lossy()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if !self.scan["forceFull"].as_bool().unwrap_or(false)
            && existing
                .as_ref()
                .is_some_and(|(_, _, m, size)| *m == mtime && *size == metadata.len() as i64)
        {
            self.db
                .conn
                .lock()
                .execute(
                    "INSERT OR IGNORE INTO engine_scan_seen VALUES(?1,?2)",
                    params![folder_id, existing.as_ref().unwrap().0],
                )
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        let parsed = media::inspect(&handle_path(&file, path), &extension)?;
        let dir = path.parent().ok_or("Missing parent")?;
        let folder_name = dir.file_name().unwrap_or_default().to_string_lossy();
        let title = if parsed.title.is_empty() {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        } else {
            parsed.title.clone()
        };
        let album = if parsed.album.is_empty() {
            folder_name.to_string()
        } else {
            parsed.album.clone()
        };
        let release = existing
            .as_ref()
            .map(|(_, r, _, _)| r.clone())
            .unwrap_or_else(|| token("release", &format!("{}\0{album}", dir.to_string_lossy())));
        let id = existing
            .as_ref()
            .map(|(id, _, _, _)| id.clone())
            .unwrap_or_else(|| token("track", &path.to_string_lossy()));
        let tag = parsed.tag.as_ref();
        let composer = media::text(tag, ItemKey::Composer);
        let genre = tag.and_then(|t| t.genre().map(|v| v.to_string()));
        let album_artist = media::text(tag, ItemKey::AlbumArtist);
        let language = media::text(tag, ItemKey::Language);
        let lyrics = media::text(tag, ItemKey::Lyrics);
        let year = tag.and_then(|t| t.year());
        let number = tag.and_then(|t| t.track());
        let disc = tag.and_then(|t| t.disk());
        let original_album = tag.and_then(crate::scanner::dsd::extract_original_album);
        let original_year = tag.and_then(crate::scanner::dsd::extract_original_year);
        let art = tag
            .and_then(|t| t.pictures().first())
            .map(|p| p.data().to_vec())
            .or_else(|| {
                [
                    "cover.jpg",
                    "cover.png",
                    "folder.jpg",
                    "folder.png",
                    "front.jpg",
                ]
                .iter()
                .find_map(|name| {
                    let f = self.open_path(&dir.join(name)).ok()?;
                    let mut data = Vec::new();
                    f.take((MAX_ART_BYTES + 1) as u64)
                        .read_to_end(&mut data)
                        .ok()?;
                    (data.len() <= MAX_ART_BYTES).then_some(data)
                })
            });
        let jpeg = art.and_then(|b| compress_art(&b).ok());
        let mut conn = self.db.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mount: String = tx
            .query_row(
                "SELECT mount_id FROM watched_folders WHERE id=?1",
                params![folder_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,composer_name,release_year,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET title=excluded.title,composer_name=excluded.composer_name,release_year=excluded.release_year",params![release,album,dir.to_string_lossy(),folder_name,parsed.artist,composer,year]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,duration_secs,format,sample_rate,bit_depth,channels,composer,genre,album_artist,release_year,track_number,disc_number,has_embedded_art,language,lyrics,original_album,original_year,created_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,CURRENT_TIMESTAMP)
            ON CONFLICT(file_path) DO UPDATE SET mount_id=excluded.mount_id,title=excluded.title,artist_credit=excluded.artist_credit,album_title=excluded.album_title,duration_secs=excluded.duration_secs,sample_rate=excluded.sample_rate,bit_depth=excluded.bit_depth,channels=excluded.channels,composer=excluded.composer,genre=excluded.genre,album_artist=excluded.album_artist,release_year=excluded.release_year,track_number=excluded.track_number,disc_number=excluded.disc_number,has_embedded_art=excluded.has_embedded_art,language=excluded.language,lyrics=excluded.lyrics,original_album=excluded.original_album,original_year=excluded.original_year,file_size=excluded.file_size,mtime=excluded.mtime,is_online=1",
            params![id,release,mount,dir.to_string_lossy(),folder_name,path.to_string_lossy(),path.file_name().unwrap_or_default().to_string_lossy(),metadata.len() as i64,metadata.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs() as i64).unwrap_or(0),title,parsed.artist,album,parsed.duration,extension.to_uppercase(),parsed.sample_rate,parsed.bit_depth,parsed.channels,composer,genre,album_artist,year,number,disc,jpeg.is_some(),language,lyrics,original_album,original_year]).map_err(|e|e.to_string())?;
        if let Some(jpeg) = jpeg {
            let etag = token("art", &format!("{:x}", Sha256::digest(&jpeg)));
            tx.execute("INSERT INTO engine_artwork VALUES(?1,?2,?3) ON CONFLICT(release_id) DO UPDATE SET etag=excluded.etag,jpeg=excluded.jpeg",params![release,etag,jpeg]).map_err(|e|e.to_string())?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO engine_scan_seen VALUES(?1,?2)",
            params![folder_id, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn artwork(&mut self, id: &str, idle: bool) -> Result<(String, Vec<u8>)> {
        if let Some(art) = self.art_cache.get(id) {
            return Ok(art.clone());
        }
        if !idle {
            return Err("deferred_until_idle".into());
        }
        let art: Option<(String, Vec<u8>)> = self
            .db
            .conn
            .lock()
            .query_row(
                "SELECT etag,jpeg FROM engine_artwork WHERE release_id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let art = art.ok_or("Artwork not found")?;
        if self.art_cache.values().map(|(_, b)| b.len()).sum::<usize>() + art.1.len()
            > MAX_ART_CACHE_BYTES
        {
            self.art_cache.clear();
        }
        self.art_cache.insert(id.to_string(), art.clone());
        Ok(art)
    }

    pub fn enriched_tracks(&self) -> Result<HashMap<String, Value>> {
        let conn = self.db.conn.lock();
        let mut stmt=conn.prepare("SELECT id,composer,genre,folder_name,language,dr_score,has_embedded_art,lyrics,format,acoustid_fingerprint,original_album FROM tracks").map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|{let format=r.get::<_,String>(8)?;let fingerprint=r.get::<_,Option<String>>(9)?;Ok((r.get::<_,String>(0)?,json!({"composerName":r.get::<_,Option<String>>(1)?,"genreTags":r.get::<_,Option<String>>(2)?.map(|s|vec![s]).unwrap_or_default(),"folderName":r.get::<_,String>(3)?,"language":r.get::<_,Option<String>>(4)?,"dynamicRange":r.get::<_,Option<i64>>(5)?,"hasCoverArt":r.get::<_,bool>(6)?,"lyrics":r.get::<_,Option<String>>(7)?,"fingerprintStatus":if matches!(format.as_str(),"DSF"|"DFF"|"DSDIFF"){"UNSUPPORTED_DSD"}else if fingerprint.is_some(){"INDEXED"}else{"PENDING"},"provenanceStatus":if r.get::<_,Option<String>>(10)?.is_some(){"INDEXED"}else{"PENDING"}})))}).map_err(|e|e.to_string())?;
        rows.collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())
    }
}

fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(|c| c.is_control()))
        .ok_or_else(|| format!("Invalid {key}"))
}

pub fn handle_path(file: &File, fallback: &Path) -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let _ = fallback;
        PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = file;
        fallback.to_path_buf()
    }
}

fn compress_art(bytes: &[u8]) -> Result<Vec<u8>> {
    use image::ImageReader;
    let mut reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| e.to_string())?
        .thumbnail(800, 800)
        .to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    if out.len() > MAX_ART_BYTES {
        return Err("Artwork too large".into());
    }
    Ok(out)
}

fn normalize_root(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

pub fn open_authorized(roots: &[PathBuf], path: &Path) -> Result<File> {
    authorize(roots, path)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        let root = roots
            .iter()
            .filter(|r| path.starts_with(r))
            .max_by_key(|r| r.components().count())
            .ok_or("Unauthorized root")?;
        let base = File::open(root).map_err(|e| e.to_string())?;
        let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
        let relative = if relative.as_os_str().is_empty() {
            Path::new(".")
        } else {
            relative
        };
        let name =
            std::ffi::CString::new(relative.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        #[repr(C)]
        struct OpenHow {
            flags: u64,
            mode: u64,
            resolve: u64,
        }
        let how = OpenHow {
            flags: (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK) as u64,
            mode: 0,
            resolve: 0x08 | 0x04,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                base.as_raw_fd(),
                name.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(unsafe { File::from_raw_fd(fd as i32) })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let root = roots
            .iter()
            .filter(|r| path.starts_with(r))
            .max_by_key(|r| r.components().count())
            .ok_or("Unauthorized root")?;
        let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
        let mut current = root.to_path_buf();
        if std::fs::symlink_metadata(&current)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Symlinks are not authorized".into());
        }
        for part in relative.components() {
            current.push(part.as_os_str());
            if std::fs::symlink_metadata(&current)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("Symlinks are not authorized".into());
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(&current)
                .map_err(|e| e.to_string())
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            File::open(&current).map_err(|e| e.to_string())
        }
    }
}

fn authorize(roots: &[PathBuf], path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || !roots.iter().any(|root| path.starts_with(root))
    {
        return Err("Path outside authorized roots".into());
    }
    Ok(())
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
