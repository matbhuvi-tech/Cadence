use tauri::State;
use crate::audio::{AudioEngine, AudioStreamInfo, PlaybackStatus, StreamBufferInfo, UpnpDevice};

#[tauri::command]
pub fn play_track(
    engine: State<'_, AudioEngine>,
    file_path: String,
) -> Result<AudioStreamInfo, String> {
    engine.play_track(&file_path)
}

#[tauri::command]
pub fn pause_audio(engine: State<'_, AudioEngine>) -> Result<(), String> {
    engine.pause()
}

#[tauri::command]
pub fn resume_audio(engine: State<'_, AudioEngine>) -> Result<(), String> {
    engine.resume()
}

#[tauri::command]
pub fn stop_audio(engine: State<'_, AudioEngine>) -> Result<(), String> {
    engine.stop()
}

#[tauri::command]
pub fn seek_audio(
    engine: State<'_, AudioEngine>,
    position_secs: f64,
) -> Result<(), String> {
    engine.seek(position_secs)
}

#[tauri::command]
pub fn set_audio_volume(
    engine: State<'_, AudioEngine>,
    volume: f32,
) -> Result<(), String> {
    engine.set_volume(volume)
}

#[tauri::command]
pub fn set_audio_device(
    engine: State<'_, AudioEngine>,
    device_name: String,
) -> Result<(), String> {
    engine.set_audio_device(&device_name)
}

#[tauri::command]
pub fn get_playback_status(engine: State<'_, AudioEngine>) -> PlaybackStatus {
    engine.get_status()
}

#[tauri::command]
pub fn list_audio_devices(engine: State<'_, AudioEngine>) -> Vec<String> {
    engine.list_output_devices()
}

#[tauri::command]
pub fn set_purity_mode(
    engine: State<'_, AudioEngine>,
    enabled: bool,
) -> Result<bool, String> {
    engine.set_purity_mode(enabled)
}

#[tauri::command]
pub fn get_purity_mode(engine: State<'_, AudioEngine>) -> bool {
    engine.get_purity_mode()
}

#[tauri::command]
pub async fn discover_upnp_devices(engine: State<'_, AudioEngine>) -> Result<Vec<UpnpDevice>, String> {
    let upnp = engine.get_upnp_manager();
    Ok(upnp.discover_devices().await)
}

#[tauri::command]
pub fn get_stream_buffer_info(engine: State<'_, AudioEngine>) -> StreamBufferInfo {
    engine.get_upnp_manager().get_buffer_info()
}

#[tauri::command]
pub fn set_stream_buffer_limit(engine: State<'_, AudioEngine>, limit_mb: u64) -> StreamBufferInfo {
    engine.get_upnp_manager().set_buffer_limit_mb(limit_mb)
}

