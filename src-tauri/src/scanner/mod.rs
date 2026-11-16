pub mod dsd;
#[cfg(feature = "desktop")]
pub mod engine;
pub mod media;

#[cfg(feature = "desktop")]
pub use engine::{ScanCompletePayload, ScanProgressPayload, ScannerController};

/// Engine events have no UI dependency. Hosts supply a bounded event consumer.
pub trait EngineProgressSink: Send + Sync + 'static {
    fn progress(&self, event: &str, payload: serde_json::Value);

    fn emit<T: serde::Serialize>(&self, event: &str, payload: T) -> Result<(), serde_json::Error> {
        self.progress(event, serde_json::to_value(payload)?);
        Ok(())
    }
}

#[cfg(feature = "desktop")]
impl EngineProgressSink for tauri::AppHandle {
    fn progress(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = Emitter::emit(self, event, payload);
    }
}
