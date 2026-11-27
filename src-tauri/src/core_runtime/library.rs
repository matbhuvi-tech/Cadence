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
const MAX_ART_BYTES: usize = 24 * 1024 * 1024;
const MAX_COMPRESSED_ART_BYTES: usize = 1024 * 1024;
const MAX_ART_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SCAN_QUEUE: usize = 1_000_000;
const PROTECTED_ART_BURST: f64 = 24.0;
const PROTECTED_ART_REFILL_PER_SEC: f64 = 12.0;

pub struct Library {
    db: AppDb,
    roots: Vec<PathBuf>,
    browse_cache: HashMap<PathBuf, Value>,
    art_cache: HashMap<String, (String, Vec<u8>)>,
    art_lru: VecDeque<String>,
    art_source_hashes: HashMap<String, [u8; 32]>,
    art_throttle_tokens: f64,
    art_throttle_last_refill: std::time::Instant,
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
            .filter_map(|p| match p.canonicalize() {
                Ok(canon) => Some(normalize_root(canon)),
                Err(_) if p.is_absolute() => Some(normalize_root(p.clone())),
                Err(_) => None,
            })
            .collect();
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
            crate::core_runtime::enrichment::schema::ensure_schema(&conn)
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
            scan["errorCount"] = json!(0);
        }
        let mut library = Self {
            db,
            roots,
            browse_cache: HashMap::new(),
            art_cache: HashMap::new(),
            art_lru: VecDeque::new(),
            art_source_hashes: HashMap::new(),
            art_throttle_tokens: PROTECTED_ART_BURST,
            art_throttle_last_refill: std::time::Instant::now(),
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
                library.scan = json!({"status":"queued","folderId":jobs[0].0,"path":jobs[0].1,"roots":roots,"processed":0,"errorCount":0,"errors":[],"forceFull":false});
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

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn browse(&mut self, path: Option<&str>, idle: bool) -> Result<Value> {
        let Some(path) = path else {
            return Ok(
                json!({"entries":self.roots.iter().map(|p| {
                    let name = p.file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| p.to_string_lossy().into_owned());
                    json!({"name":name,"path":p,"isDir":true,"readable":true,"isWatched":false})
                }).collect::<Vec<_>>(),"cached":true}),
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
            status["deferred"] = json!(!idle && !self.pending.is_empty());
            return Ok(status);
        }
        if op == "folders.list" {
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
                let online = if idle {
                    self.open_path(Path::new(&path))
                        .and_then(|f| f.metadata().map_err(|e| e.to_string()))
                        .is_ok_and(|m| m.is_dir())
                } else {
                    true
                };
                folders.push(json!({"id":id,"path":path,"displayName":name,"scanMode":mode,"lastScannedAt":last,"trackCount":count,"online":online}));
            }
            return Ok(json!({"folders":folders}));
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
                for smb_root in crate::core_runtime::smb::remount_persisted_shares(&self.db) {
                    if !self.roots.contains(&smb_root) {
                        self.roots.push(smb_root);
                    }
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
                drop(stmt);
                drop(conn);

                if !self.pending.is_empty() {
                    if let Some(scan_roots) = self.scan["roots"].as_array_mut() {
                        for (rid, rpath) in roots {
                            let already = scan_roots
                                .iter()
                                .any(|r| r["id"].as_str() == Some(rid.as_str()));
                            if !already {
                                scan_roots.push(json!({"id": rid, "path": rpath}));
                                self.pending.push_back((rid, rpath));
                            }
                        }
                    }
                    self.persist()?;
                    return Ok(self.scan.clone());
                }

                // One durable job at a time; absent folderId queues all roots as jobs.
                let root_jobs = roots
                    .iter()
                    .map(|(id, path)| json!({"id":id,"path":path}))
                    .collect::<Vec<_>>();
                self.pending = roots.into();
                let (id, path) = self.pending.front().unwrap();
                self.scan = json!({"status":"queued","folderId":id,"path":path,"processed":0,"errorCount":0,"errors":[],"forceFull":req["forceFull"].as_bool().unwrap_or(false),"roots":root_jobs});
                self.db
                    .conn
                    .lock()
                    .execute("DELETE FROM engine_scan_seen", [])
                    .map_err(|e| e.to_string())?;
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
        self.scan["folderId"] = json!(&folder_id);
        let result = self.scan_path(&folder_id, &path);
        if let Err(error) = result {
            self.scan["errorCount"] = json!(self.scan["errorCount"].as_u64().unwrap_or(0) + 1);
            let errors = self.scan["errors"]
                .as_array_mut()
                .ok_or("Invalid scan state")?;
            if errors.len() < 100 {
                errors.push(json!({"path":path,"message":error}));
            }
        }
        self.scan["processed"] = json!(self.scan["processed"].as_u64().unwrap_or(0) + 1);
        if self.pending.is_empty() {
            let failed = self.scan["errorCount"].as_u64().unwrap_or(0) > 0
                || self.scan["errors"].as_array().is_some_and(|v| !v.is_empty());
            self.scan["status"] = json!(if failed { "failed" } else { "completed" });
            if let Some(roots) = self.scan["roots"].as_array() {
                for root in roots {
                    let Some(root_id) = root["id"].as_str() else {
                        continue;
                    };
                    let root_online = root["path"]
                        .as_str()
                        .is_some_and(|p| self.open_path(Path::new(p)).is_ok());
                    let conn = self.db.conn.lock();
                    if root_online {
                        conn.execute("UPDATE tracks SET is_online=0 WHERE mount_id=(SELECT mount_id FROM watched_folders WHERE id=?1) AND id NOT IN (SELECT track_id FROM engine_scan_seen WHERE folder_id=?1)",params![root_id]).map_err(|e|e.to_string())?;
                    }
                    conn.execute("UPDATE watched_folders SET last_scanned_timestamp=CURRENT_TIMESTAMP WHERE id=?1",params![root_id]).map_err(|e|e.to_string())?;
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
            if entries.len() > MAX_SCAN_QUEUE {
                return Err("Scan directory limit exceeded".into());
            }
            entries.sort_by_key(|e| e.file_name());
            // Push in reverse order to the front of the queue so `pop_front()` performs
            // a depth-first traversal in alphabetical order, keeping queue memory O(depth * width)
            // even on 100K+ track catalogues and scanning all tracks of an album contiguously.
            for entry in entries.into_iter().rev() {
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
                    if self.pending.len() >= MAX_SCAN_QUEUE {
                        return Err("Scan queue limit exceeded".into());
                    }
                    self.pending.push_front((folder_id.to_string(), child));
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
            let has_art: bool = self.db.conn.lock().query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_artwork WHERE release_id=?1)",
                params![existing.as_ref().unwrap().1], |r| r.get(0),
            ).map_err(|e| e.to_string())?;
            let folder_has_art = path
                .parent()
                .map(|dir| !self.find_folder_cover_candidates(dir).is_empty())
                .unwrap_or(false);
            if has_art && !folder_has_art {
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
        }
        let parsed = media::inspect(&handle_path(&file, path), &extension)?;
        if parsed.tag_parse_error.is_some() {
            if let Some((track_id, _, _, _)) = &existing {
                self.db
                    .conn
                    .lock()
                    .execute(
                        "INSERT OR IGNORE INTO engine_scan_seen VALUES(?1,?2)",
                        params![folder_id, track_id],
                    )
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
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
        let release_already_has_art: bool = self
            .db
            .conn
            .lock()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_artwork WHERE release_id=?1)",
                params![release],
                |r| r.get(0),
            )
            .unwrap_or(false);
        let art_outcome = self.resolve_and_compress_artwork(&release, tag, dir, release_already_has_art);
        let (new_jpeg, has_art_for_release) = match art_outcome {
            Some(Some(jpeg)) => (Some(jpeg), true),
            Some(None) => (None, true),
            None => (None, release_already_has_art),
        };
        let cover_sentinel = has_art_for_release.then(|| format!("cadence-art://{release}"));
        let mut conn = self.db.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mount: String = tx
            .query_row(
                "SELECT mount_id FROM watched_folders WHERE id=?1",
                params![folder_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO releases(id,title,folder_path,folder_name,artist_credit,composer_name,release_year,front_cover_url,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET title=excluded.title,composer_name=excluded.composer_name,release_year=excluded.release_year,front_cover_url=COALESCE(excluded.front_cover_url, releases.front_cover_url)",params![release,album,dir.to_string_lossy(),folder_name,parsed.artist,composer,year,cover_sentinel]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO tracks(id,release_id,mount_id,folder_path,folder_name,file_path,file_name,file_size,mtime,title,artist_credit,album_title,duration_secs,format,sample_rate,bit_depth,channels,composer,genre,album_artist,release_year,track_number,disc_number,has_embedded_art,language,lyrics,original_album,original_year,created_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,CURRENT_TIMESTAMP)
            ON CONFLICT(file_path) DO UPDATE SET mount_id=excluded.mount_id,title=excluded.title,artist_credit=excluded.artist_credit,album_title=excluded.album_title,duration_secs=excluded.duration_secs,sample_rate=excluded.sample_rate,bit_depth=excluded.bit_depth,channels=excluded.channels,composer=excluded.composer,genre=excluded.genre,album_artist=excluded.album_artist,release_year=excluded.release_year,track_number=excluded.track_number,disc_number=excluded.disc_number,has_embedded_art=excluded.has_embedded_art,language=excluded.language,lyrics=excluded.lyrics,original_album=excluded.original_album,original_year=excluded.original_year,file_size=excluded.file_size,mtime=excluded.mtime,is_online=1",
            params![id,release,mount,dir.to_string_lossy(),folder_name,path.to_string_lossy(),path.file_name().unwrap_or_default().to_string_lossy(),metadata.len() as i64,metadata.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs() as i64).unwrap_or(0),title,parsed.artist,album,parsed.duration,extension.to_uppercase(),parsed.sample_rate,parsed.bit_depth,parsed.channels,composer,genre,album_artist,year,number,disc,has_art_for_release,language,lyrics,original_album,original_year]).map_err(|e|e.to_string())?;
        let mut updated_art: Option<(String, Vec<u8>)> = None;
        if let Some(jpeg) = new_jpeg {
            let etag = token("art", &format!("{:x}", Sha256::digest(&jpeg)));
            tx.execute("INSERT INTO engine_artwork VALUES(?1,?2,?3) ON CONFLICT(release_id) DO UPDATE SET etag=excluded.etag,jpeg=excluded.jpeg",params![release,etag,jpeg]).map_err(|e|e.to_string())?;
            tx.execute("UPDATE tracks SET has_embedded_art=1 WHERE release_id=?1", params![release]).map_err(|e|e.to_string())?;
            updated_art = Some((etag, jpeg));
        }
        tx.execute(
            "INSERT OR IGNORE INTO engine_scan_seen VALUES(?1,?2)",
            params![folder_id, id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        if let Some(art_entry) = updated_art {
            self.insert_art_cache(release, art_entry);
        }
        Ok(())
    }

    fn read_authorized_image_bytes(&self, path: &Path) -> Option<Vec<u8>> {
        let f = self.open_path(path).ok()?;
        let mut data = Vec::new();
        f.take((MAX_ART_BYTES + 1) as u64)
            .read_to_end(&mut data)
            .ok()?;
        if !data.is_empty() && data.len() <= MAX_ART_BYTES {
            Some(data)
        } else {
            None
        }
    }

    /// Discovers ranked cover image files in a single directory (case-insensitive across Windows/Linux).
    fn find_ranked_images_in_single_dir(&self, target_dir: &Path) -> Vec<PathBuf> {
        let Ok(dir_file) = self.open_path(target_dir) else {
            return Vec::new();
        };
        let Ok(read_dir) = std::fs::read_dir(handle_path(&dir_file, target_dir)) else {
            return Vec::new();
        };
        let mut image_files: Vec<(String, PathBuf)> = Vec::new();
        for entry in read_dir.flatten() {
            let Ok(ty) = entry.file_type() else {
                continue;
            };
            if !ty.is_file() || ty.is_symlink() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let ext = Path::new(&file_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            if media::is_cover_image_extension(ext) {
                image_files.push((file_name.clone(), target_dir.join(file_name)));
            }
        }
        let allow_single = image_files.len() == 1;
        let mut ranked: Vec<((u8, u8), String, PathBuf)> = image_files
            .into_iter()
            .filter_map(|(name, p)| {
                let rank = media::rank_cover_filename(&name, allow_single)?;
                Some((rank, name.to_ascii_lowercase(), p))
            })
            .collect();
        ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        ranked.into_iter().map(|(_, _, p)| p).collect()
    }

    /// Discovers folder cover art candidates in priority order:
    /// 1. `cadence-album.sidecar.json` local path (if authorized)
    /// 2. Ranked cover images directly in `dir` (`cover.*`, `folder.*`, `front.*`, `album.*`, `artwork.*`, or single-image fallback)
    /// 3. Artwork subdirectories (`Artwork/`, `Covers/`, `Scans/`, `Art/`) inside `dir`
    /// 4. Multi-disc parent directory (`..` and its artwork subdirectories) when `dir` is `CD1`, `Disc 1`, etc.
    fn find_folder_cover_candidates(&self, dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();

        // 1. Check cadence-album.sidecar.json
        if let Some(sidecar_bytes) = self.read_authorized_image_bytes(&dir.join("cadence-album.sidecar.json")) {
            if let Ok(v) = serde_json::from_slice::<Value>(&sidecar_bytes) {
                if let Some(raw_cover) = v
                    .get("coverArtUrl")
                    .or_else(|| v.get("artworkUrl"))
                    .and_then(|s| s.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && !s.starts_with("http://") && !s.starts_with("https://") && !s.starts_with("cadence-art://"))
                {
                    let clean = raw_cover
                        .strip_prefix("file:///")
                        .or_else(|| raw_cover.strip_prefix("file://"))
                        .unwrap_or(raw_cover);
                    let candidate = Path::new(clean);
                    let resolved = if candidate.is_absolute() {
                        candidate.to_path_buf()
                    } else {
                        dir.join(candidate)
                    };
                    if self.open_path(&resolved).is_ok() {
                        out.push(resolved);
                    }
                }
            }
        }

        // 2. Direct images in `dir`
        out.extend(self.find_ranked_images_in_single_dir(dir));

        // 3. Artwork subdirectories inside `dir`
        if let Ok(dir_file) = self.open_path(dir) {
            if let Ok(read_dir) = std::fs::read_dir(handle_path(&dir_file, dir)) {
                let mut subdirs: Vec<PathBuf> = Vec::new();
                for entry in read_dir.flatten() {
                    if entry.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if media::is_artwork_subdir_name(&name) {
                            subdirs.push(dir.join(name));
                        }
                    }
                }
                subdirs.sort();
                for sub in subdirs {
                    out.extend(self.find_ranked_images_in_single_dir(&sub));
                }
            }
        }

        // 4. Multi-disc parent directory fallback (`CD1`, `Disc 1`, etc.)
        if out.is_empty() {
            let folder_name = dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if media::is_multidisc_subfolder_name(&folder_name) {
                if let Some(parent) = dir.parent() {
                    if self.authorized(parent).is_ok() {
                        out.extend(self.find_ranked_images_in_single_dir(parent));
                    }
                }
            }
        }

        out
    }

    /// Resolves and compresses artwork for a release, deduplicating work when the raw source bytes
    /// match what was already compressed for this `release_id`.
    /// Returns:
    /// - `Some(Some(jpeg))` if newly compressed JPEG bytes should be written to `engine_artwork`
    /// - `Some(None)` if the identical source bytes were already compressed and stored in `engine_artwork`
    /// - `None` if no valid embedded or folder cover was found on this track
    fn resolve_and_compress_artwork(
        &mut self,
        release: &str,
        tag: Option<&lofty::tag::Tag>,
        dir: &Path,
        release_already_has_art: bool,
    ) -> Option<Option<Vec<u8>>> {
        // 1. Try best embedded picture (prioritizing CoverFront)
        if let Some(pic) = tag.and_then(media::select_best_picture) {
            let raw = pic.data();
            if !raw.is_empty() && raw.len() <= MAX_ART_BYTES {
                let raw_hash: [u8; 32] = Sha256::digest(raw).into();
                if release_already_has_art && self.art_source_hashes.get(release) == Some(&raw_hash) {
                    return Some(None);
                }
                if let Ok(jpeg) = compress_art(raw) {
                    self.art_source_hashes.insert(release.to_string(), raw_hash);
                    return Some(Some(jpeg));
                }
            }
        }

        // 2. Try ranked folder / sidecar / multi-disc cover candidates
        for candidate in self.find_folder_cover_candidates(dir) {
            let Some(raw) = self.read_authorized_image_bytes(&candidate) else {
                continue;
            };
            let raw_hash: [u8; 32] = Sha256::digest(&raw).into();
            if release_already_has_art && self.art_source_hashes.get(release) == Some(&raw_hash) {
                return Some(None);
            }
            if let Ok(jpeg) = compress_art(&raw) {
                self.art_source_hashes.insert(release.to_string(), raw_hash);
                return Some(Some(jpeg));
            }
        }

        None
    }

    fn touch_art_lru(&mut self, key: &str) {
        if let Some(pos) = self.art_lru.iter().position(|k| k == key) {
            self.art_lru.remove(pos);
        }
        self.art_lru.push_back(key.to_string());
    }

    fn insert_art_cache(&mut self, key: String, art: (String, Vec<u8>)) {
        let entry_len = art.1.len();
        if entry_len > MAX_ART_CACHE_BYTES {
            return;
        }
        if self.art_cache.contains_key(&key) {
            self.art_cache.remove(&key);
        }
        let mut current_bytes: usize = self.art_cache.values().map(|(_, b)| b.len()).sum();
        while current_bytes + entry_len > MAX_ART_CACHE_BYTES {
            let Some(oldest_key) = self.art_lru.pop_front() else {
                self.art_cache.clear();
                break;
            };
            if let Some((_, evicted_bytes)) = self.art_cache.remove(&oldest_key) {
                current_bytes = current_bytes.saturating_sub(evicted_bytes.len());
            }
        }
        self.touch_art_lru(&key);
        self.art_cache.insert(key, art);
    }

    fn try_consume_protected_art_token(&mut self) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.saturating_duration_since(self.art_throttle_last_refill).as_secs_f64();
        if elapsed > 0.0 {
            self.art_throttle_tokens = (self.art_throttle_tokens + elapsed * PROTECTED_ART_REFILL_PER_SEC)
                .min(PROTECTED_ART_BURST);
            self.art_throttle_last_refill = now;
        }
        if self.art_throttle_tokens >= 1.0 {
            self.art_throttle_tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub fn artwork(&mut self, id: &str, idle: bool) -> Result<(String, Vec<u8>)> {
        if let Some(art) = self.art_cache.get(id).cloned() {
            self.touch_art_lru(id);
            return Ok(art);
        }

        if !idle {
            // During active playback or 30s post-playback cooldown:
            // - Music library drives are NEVER touched (zero filesystem I/O).
            // - Read-only primary-key lookup against `engine_artwork` (on OS AppData SQLite) is allowed
            //   under a token-bucket rate limiter (24 burst, 12/sec refill) with non-blocking `try_lock()`
            //   so users can browse albums/genres/composers smoothly while blocking chaos-test floods.
            if !self.try_consume_protected_art_token() {
                return Err("deferred_until_idle".into());
            }
            let Some(conn) = self.db.conn.try_lock() else {
                return Err("deferred_until_idle".into());
            };
            let art: Option<(String, String, Vec<u8>)> = conn
                .query_row(
                    "SELECT release_id, etag, jpeg FROM engine_artwork WHERE release_id=?1
                     UNION ALL
                     SELECT a.release_id, a.etag, a.jpeg FROM engine_artwork a
                     JOIN tracks t ON t.release_id = a.release_id
                     WHERE t.id=?1
                     LIMIT 1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            drop(conn);
            if let Some((resolved_rel_id, etag, bytes)) = art {
                let entry = (etag, bytes);
                self.insert_art_cache(resolved_rel_id.clone(), entry.clone());
                if resolved_rel_id != id {
                    self.insert_art_cache(id.to_string(), entry.clone());
                }
                return Ok(entry);
            }
            return Err("deferred_until_idle".into());
        }

        // Audio transport is idle:
        // 1. Check `engine_artwork` by `release_id` or `track_id`
        let art: Option<(String, String, Vec<u8>)> = self
            .db
            .conn
            .lock()
            .query_row(
                "SELECT release_id, etag, jpeg FROM engine_artwork WHERE release_id=?1
                 UNION ALL
                 SELECT a.release_id, a.etag, a.jpeg FROM engine_artwork a
                 JOIN tracks t ON t.release_id = a.release_id
                 WHERE t.id=?1
                 LIMIT 1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some((resolved_rel_id, etag, bytes)) = art {
            let entry = (etag, bytes);
            self.insert_art_cache(resolved_rel_id.clone(), entry.clone());
            if resolved_rel_id != id {
                self.insert_art_cache(id.to_string(), entry.clone());
            }
            return Ok(entry);
        }

        // 2. Self-healing lazy extraction when idle (e.g. migrated V1 releases not yet in `engine_artwork`):
        let candidate_track: Option<(String, String, String)> = self
            .db
            .conn
            .lock()
            .query_row(
                "SELECT release_id, folder_path, file_path FROM tracks WHERE release_id=?1 OR id=?1 ORDER BY has_embedded_art DESC, track_number ASC LIMIT 1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some((resolved_rel_id, folder_path_str, file_path_str)) = candidate_track {
            let file_path = Path::new(&file_path_str);
            let dir_path = Path::new(&folder_path_str);
            let ext = file_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let parsed_tag = self
                .open_path(file_path)
                .ok()
                .and_then(|f| media::inspect(&handle_path(&f, file_path), &ext).ok())
                .and_then(|m| m.tag);
            if let Some(Some(jpeg)) = self.resolve_and_compress_artwork(
                &resolved_rel_id,
                parsed_tag.as_ref(),
                dir_path,
                false,
            ) {
                let etag = token("art", &format!("{:x}", Sha256::digest(&jpeg)));
                {
                    let conn = self.db.conn.lock();
                    let _ = conn.execute(
                        "INSERT INTO engine_artwork VALUES(?1,?2,?3) ON CONFLICT(release_id) DO UPDATE SET etag=excluded.etag,jpeg=excluded.jpeg",
                        params![resolved_rel_id, etag, jpeg],
                    );
                    let _ = conn.execute(
                        "UPDATE tracks SET has_embedded_art=1 WHERE release_id=?1",
                        params![resolved_rel_id],
                    );
                    let _ = conn.execute(
                        "UPDATE releases SET front_cover_url=?2 WHERE id=?1 AND front_cover_url IS NULL",
                        params![resolved_rel_id, format!("cadence-art://{resolved_rel_id}")],
                    );
                }
                let entry = (etag, jpeg);
                self.insert_art_cache(resolved_rel_id.clone(), entry.clone());
                if resolved_rel_id != id {
                    self.insert_art_cache(id.to_string(), entry.clone());
                }
                return Ok(entry);
            }
        }

        Err("Artwork not found".into())
    }

    pub fn enriched_tracks(&self) -> Result<HashMap<String, Value>> {
        let conn = self.db.conn.lock();
        let mut shares: Vec<(String, String)> = conn
            .prepare("SELECT mount_path, server, share FROM engine_network_shares")
            .and_then(|mut s| {
                s.query_map([], |r| {
                    let mp: String = r.get(0)?;
                    let srv: String = r.get(1)?;
                    let sh: String = r.get(2)?;
                    Ok((
                        mp.trim_end_matches(['/', '\\']).to_string(),
                        format!("//{}/{}", srv.trim(), sh.trim_start_matches('/')),
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()
            })
            .unwrap_or_default();
        shares.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

        let mut stmt = conn
            .prepare(
                "SELECT t.id,
                        COALESCE(NULLIF(TRIM(ov_comp.value_text), ''), t.composer),
                        COALESCE(NULLIF(TRIM(ov_genre.value_text), ''), t.genre),
                        t.folder_name,
                        t.language,
                        t.dr_score,
                        (t.has_embedded_art != 0
                            OR EXISTS(SELECT 1 FROM engine_artwork a WHERE a.release_id = t.release_id)
                            OR EXISTS(SELECT 1 FROM artwork_items ai WHERE ai.entity_kind='album' AND ai.entity_id = t.release_id AND ai.status IN ('found','found_stale','user_override'))),
                        t.lyrics,
                        t.format,
                        t.acoustid_fingerprint,
                        t.original_album,
                        t.folder_path,
                        t.file_name
                 FROM tracks t
                 LEFT JOIN metadata_overlays ov_comp
                     ON ov_comp.entity_type = 'release' AND ov_comp.entity_id = t.release_id AND ov_comp.field_name = 'composer'
                 LEFT JOIN metadata_overlays ov_genre
                     ON ov_genre.entity_type = 'release' AND ov_genre.entity_id = t.release_id AND ov_genre.field_name = 'genre'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let format = r.get::<_, String>(8)?;
                let fingerprint = r.get::<_, Option<String>>(9)?;
                let raw_folder_path = r.get::<_, Option<String>>(11)?;
                let display_folder_path = raw_folder_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| format_display_folder_path(s, &shares));
                let display_file_name = r
                    .get::<_, Option<String>>(12)?
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                Ok((
                    r.get::<_, String>(0)?,
                    json!({
                        "composerName": r.get::<_, Option<String>>(1)?,
                        "genreTags": r.get::<_, Option<String>>(2)?.map(|s| vec![s]).unwrap_or_default(),
                        "folderName": r.get::<_, String>(3)?,
                        "folderPath": display_folder_path,
                        "fileName": display_file_name,
                        "language": r.get::<_, Option<String>>(4)?,
                        "dynamicRange": r.get::<_, Option<i64>>(5)?,
                        "hasCoverArt": r.get::<_, bool>(6)?,
                        "lyrics": r.get::<_, Option<String>>(7)?,
                        "fingerprintStatus": if matches!(format.as_str(), "DSF" | "DFF" | "DSDIFF") { "UNSUPPORTED_DSD" } else if fingerprint.is_some() { "INDEXED" } else { "PENDING" },
                        "provenanceStatus": if r.get::<_, Option<String>>(10)?.is_some() { "INDEXED" } else { "PENDING" }
                    }),
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())
    }
}

fn format_display_folder_path(raw: &str, shares: &[(String, String)]) -> String {
    for (mount, prefix) in shares {
        if mount.is_empty() {
            continue;
        }
        if raw == mount {
            return prefix.clone();
        }
        if let Some(suffix) = raw.strip_prefix(mount) {
            if suffix.starts_with('/') || suffix.starts_with('\\') {
                return format!("{}{}", prefix.trim_end_matches('/'), suffix.replace('\\', "/"));
            }
        }
    }
    raw.to_string()
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
    if out.len() > MAX_COMPRESSED_ART_BYTES {
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

/// Enumerates browseable Windows drive roots (`C:\`, `E:\`, etc.) and any
/// persisted UNC/storage mount roots from `cadence.db`.
#[cfg(windows)]
pub fn windows_default_browse_roots(db: &AppDb) -> Vec<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;

    let mut roots = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for i in 0..26u8 {
        if (mask & (1u32 << i)) == 0 {
            continue;
        }
        let letter = (b'A' + i) as char;
        let root_str = format!("{}:\\", letter);
        let wide: Vec<u16> = root_str.encode_utf16().chain(std::iter::once(0)).collect();
        let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
        if matches!(drive_type, DRIVE_FIXED | DRIVE_REMOTE | DRIVE_REMOVABLE) {
            let p = PathBuf::from(&root_str);
            if p.exists() {
                roots.push(p);
            }
        }
    }

    if let Some(conn) = db.conn.try_lock() {
        if let Ok(mut stmt) = conn.prepare("SELECT folder_path FROM watched_folders") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for path_str in rows.flatten() {
                    let p = PathBuf::from(path_str);
                    if !roots.iter().any(|r| p.starts_with(r)) {
                        roots.push(p);
                    }
                }
            }
        }
    }
    roots
}

#[cfg(not(windows))]
pub fn windows_default_browse_roots(_db: &AppDb) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod artwork_regression_tests {
    use super::*;

    fn fixture() -> (PathBuf, Library, PathBuf) {
        let raw_root = std::env::temp_dir().join(format!("cadence-art-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&raw_root).unwrap();
        // Canonicalize + normalize_root so Windows 8.3 short TEMP paths (e.g. RUNNER~1) and \\?\ prefixes
        // match Library::open's authorized roots.
        let root = normalize_root(std::fs::canonicalize(&raw_root).unwrap_or(raw_root));
        let wav = root.join("track.wav");
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&40u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&44100u32.to_le_bytes());
        bytes.extend_from_slice(&88200u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        std::fs::write(&wav, bytes).unwrap();
        let db = AppDb::new(root.join("catalog.db")).unwrap();
        {
            let conn = db.conn.lock();
            conn.execute("INSERT INTO storage_mounts(id,name,mount_path,mount_type,file_system,last_seen_timestamp) VALUES('m','test',?1,'local_disk','ntfs',CURRENT_TIMESTAMP)", params![root.to_string_lossy()]).unwrap();
            conn.execute("INSERT INTO watched_folders(id,mount_id,folder_path,display_name,scan_mode) VALUES('w','m',?1,'test','manual')", params![root.to_string_lossy()]).unwrap();
        }
        let lib = Library::open(db, vec![root.clone()]).unwrap();
        (root, lib, wav)
    }

    fn cover(path: &Path, color: [u8; 3]) {
        image::RgbImage::from_pixel(3, 3, image::Rgb(color)).save(path).unwrap();
    }

    #[test]
    fn quick_scan_discovers_added_folder_cover_for_unchanged_track() {
        let (root, mut lib, wav) = fixture();
        lib.scan_path("w", &wav).unwrap();
        cover(&root.join("cover.png"), [255, 0, 0]);
        lib.scan_path("w", &wav).unwrap();
        let conn = lib.db.conn.lock();
        let count: i64 = conn.query_row("SELECT count(*) FROM engine_artwork", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "quick scan must rebuild missing artwork");
    }

    #[test]
    fn invalid_first_folder_image_falls_back_to_valid_image() {
        let (root, mut lib, wav) = fixture();
        std::fs::write(root.join("cover.jpg"), b"invalid").unwrap();
        cover(&root.join("folder.png"), [0, 255, 0]);
        lib.scan_path("w", &wav).unwrap();
        let conn = lib.db.conn.lock();
        let count: i64 = conn.query_row("SELECT count(*) FROM engine_artwork", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "invalid candidate must not hide a valid folder image");
    }

    #[test]
    fn quick_scan_updates_changed_folder_cover() {
        let (root, mut lib, wav) = fixture();
        let image = root.join("cover.png");
        cover(&image, [255, 0, 0]);
        lib.scan_path("w", &wav).unwrap();
        let old: String = lib.db.conn.lock().query_row("SELECT etag FROM engine_artwork", [], |r| r.get(0)).unwrap();
        cover(&image, [0, 0, 255]);
        lib.scan_path("w", &wav).unwrap();
        let new: String = lib.db.conn.lock().query_row("SELECT etag FROM engine_artwork", [], |r| r.get(0)).unwrap();
        assert_ne!(old, new, "updated artwork should replace the cached cover");
    }

    #[test]
    fn malformed_wav_info_keeps_existing_metadata_and_counts_track_as_seen() {
        let (_root, mut lib, wav) = fixture();
        lib.scan_path("w", &wav).unwrap();
        let original_title: String = lib
            .db
            .conn
            .lock()
            .query_row("SELECT title FROM tracks", [], |row| row.get(0))
            .unwrap();

        let mut bytes = std::fs::read(&wav).unwrap();
        let mut bad_info = b"LIST".to_vec();
        bad_info.extend_from_slice(&14u32.to_le_bytes());
        bad_info.extend_from_slice(b"INFOINAM");
        bad_info.extend_from_slice(&2u32.to_le_bytes());
        bad_info.extend_from_slice(&[0xFF, 0xFE]);
        bytes.extend_from_slice(&bad_info);
        let riff_size = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        std::fs::write(&wav, bytes).unwrap();

        lib.scan_path("w", &wav).unwrap();

        let conn = lib.db.conn.lock();
        let current_title: String = conn
            .query_row("SELECT title FROM tracks", [], |row| row.get(0))
            .unwrap();
        let seen_count: i64 = conn
            .query_row("SELECT count(*) FROM engine_scan_seen", [], |row| row.get(0))
            .unwrap();
        assert_eq!(current_title, original_title);
        assert_eq!(seen_count, 1);
    }

    #[test]
    fn discovers_multidisc_parent_and_artwork_subdir_and_single_image_fallback() {
        let (root, mut lib, wav) = fixture();
        // 1. Single non-standard image filename in folder falls back cleanly
        cover(&root.join("Dark Side of the Moon.jpg"), [120, 40, 200]);
        lib.scan_path("w", &wav).unwrap();
        let release_id: String = lib
            .db
            .conn
            .lock()
            .query_row("SELECT release_id FROM tracks LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert!(lib.artwork(&release_id, true).is_ok(), "single image fallback should resolve");

        // 2. Multi-disc subfolder `CD1/track2.wav` inherits cover from parent album folder
        let cd1 = root.join("CD1");
        std::fs::create_dir_all(&cd1).unwrap();
        let wav_cd1 = cd1.join("track2.wav");
        std::fs::copy(&wav, &wav_cd1).unwrap();
        lib.scan_path("w", &wav_cd1).unwrap();
        let cd1_rel_id: String = lib
            .db
            .conn
            .lock()
            .query_row(
                "SELECT release_id FROM tracks WHERE file_path=?1",
                params![wav_cd1.to_string_lossy()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            lib.artwork(&cd1_rel_id, true).is_ok(),
            "multi-disc CD1 subfolder must inherit parent folder cover art"
        );
    }

    #[test]
    fn playback_active_allows_throttled_sqlite_artwork_browsing_and_blocks_chaos_flood() {
        let (root, mut lib, wav) = fixture();
        cover(&root.join("Folder.JPG"), [10, 200, 50]);
        lib.scan_path("w", &wav).unwrap();

        let (release_id, track_id): (String, String) = lib
            .db
            .conn
            .lock()
            .query_row("SELECT release_id, id FROM tracks LIMIT 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();

        // Insert 30 synthetic pre-indexed album covers into SQLite `engine_artwork`
        // and clear the in-memory RAM cache to simulate cold browsing while audio is playing.
        {
            let conn = lib.db.conn.lock();
            for i in 0..30 {
                conn.execute(
                    "INSERT INTO engine_artwork(release_id, etag, jpeg) VALUES(?1, ?2, ?3)",
                    params![format!("rel_chaos_{i}"), format!("etag_{i}"), vec![1u8, 2, 3]],
                )
                .unwrap();
            }
        }
        lib.art_cache.clear();
        lib.art_lru.clear();

        // 1. Track-ID lookup resolves parent release artwork even during playback (`idle = false`)
        assert!(
            lib.artwork(&track_id, false).is_ok(),
            "track_id should resolve parent release artwork from SQLite during playback"
        );
        // 2. Cached RAM hit does not consume token bucket
        assert!(lib.artwork(&release_id, false).is_ok());

        // 3. Drain remaining burst tokens (23 left out of 24 burst)
        let mut allowed_during_playback = 1;
        let mut throttled_count = 0;
        for i in 0..30 {
            match lib.artwork(&format!("rel_chaos_{i}"), false) {
                Ok(_) => allowed_during_playback += 1,
                Err(e) if e == "deferred_until_idle" => throttled_count += 1,
                Err(other) => panic!("unexpected error: {other}"),
            }
        }
        assert_eq!(
            allowed_during_playback,
            PROTECTED_ART_BURST as usize,
            "must allow human browse burst of 24 uncached SQLite covers during playback"
        );
        assert!(
            throttled_count > 0,
            "chaos flood exceeding token bucket during playback must be throttled with deferred_until_idle"
        );
    }

    #[test]
    fn folders_list_succeeds_while_not_idle_and_scan_appends_and_updates_timestamp_despite_errors() {
        let (root, mut lib, _wav) = fixture();

        // 1. folders.list must still return saved roots during playback/cooldown (idle = false)
        let listed = lib.request("folders.list", &json!({}), false).unwrap();
        let folders = listed["folders"].as_array().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0]["id"], "w");

        // 2. Historical/idle scan status must not report deferred = true when no scan is pending
        let idle_status = lib.request("folders.scan.status", &json!({}), false).unwrap();
        assert_eq!(idle_status["deferred"], false);

        // 3. Add a second watched folder containing a corrupt WAV file
        let sub_dir = root.join("Tamil");
        std::fs::create_dir_all(&sub_dir).unwrap();
        std::fs::write(sub_dir.join("broken.wav"), b"RIFF\x10\x00\x00\x00WAVEnot-a-valid-wav").unwrap();
        {
            let conn = lib.db.conn.lock();
            conn.execute(
                "INSERT INTO watched_folders(id, mount_id, folder_path, display_name, scan_mode) VALUES('w2', 'm', ?1, 'Tamil', 'manual')",
                params![sub_dir.to_string_lossy()],
            )
            .unwrap();
        }

        // Start scan on `w`
        let first = lib
            .request("folders.scan", &json!({ "folderId": "w" }), true)
            .unwrap();
        assert_eq!(first["status"], "queued");

        // While `w` is still pending, scanning `w2` appends instead of failing with "Scan already queued"
        let appended = lib
            .request("folders.scan", &json!({ "folderId": "w2" }), true)
            .unwrap();
        let roots_arr = appended["roots"].as_array().unwrap();
        assert_eq!(roots_arr.len(), 2);

        // Active pending scan reports deferred = true when idle = false
        let active_deferred = lib.request("folders.scan.status", &json!({}), false).unwrap();
        assert_eq!(active_deferred["deferred"], true);

        // Drain the scan queue
        while lib.step().is_ok_and(|completed| !completed) {}

        // Even though `broken.wav` caused a file error, `last_scanned_timestamp` is updated on `w2`
        let ts: Option<String> = lib
            .db
            .conn
            .lock()
            .query_row(
                "SELECT last_scanned_timestamp FROM watched_folders WHERE id = 'w2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            ts.is_some(),
            "last_scanned_timestamp must be updated even when individual files error"
        );
    }
}
