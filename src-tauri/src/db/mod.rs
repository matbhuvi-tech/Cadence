use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::Mutex;
use rusqlite::Connection;

pub mod operations;
pub mod schema;

pub use operations::*;

#[derive(Clone)]
pub struct AppDb {
    pub conn: Arc<Mutex<Connection>>,
}

impl AppDb {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open SQLite database at {:?}: {}", db_path, e))?;
        
        schema::initialize_schema(&conn)
            .map_err(|e| format!("Failed to initialize SQLite schema: {}", e))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}
