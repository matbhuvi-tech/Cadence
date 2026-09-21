use tauri::State;
use crate::audio::{AudioEngine, AudioStreamInfo, PlaybackStatus};

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
pub fn list_audio_devices() -> Vec<String> {
    AudioEngine::list_output_devices()
}
