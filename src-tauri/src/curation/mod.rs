pub mod models;
pub mod storage;
pub mod tag_writer;

pub use models::*;
pub use storage::*;

/// A host supplies playback protection without coupling curation storage to Tauri.
pub trait PlaybackProtection {
    fn protects_storage(&self) -> bool;
}

#[cfg(feature = "desktop")]
impl PlaybackProtection for crate::audio::AudioEngine {
    fn protects_storage(&self) -> bool {
        self.is_playing() || self.is_paused()
    }
}

#[cfg(feature = "desktop")]
impl PlaybackProtection for tauri::State<'_, crate::audio::AudioEngine> {
    fn protects_storage(&self) -> bool {
        self.inner().protects_storage()
    }
}
