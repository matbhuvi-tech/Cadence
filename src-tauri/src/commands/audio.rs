use tauri::State;
use crate::audio::{
    AudioEndpoint, AudioEndpointInfo, AudioEngine, AudioStreamInfo, PlaybackStatus,
    StreamBufferInfo, UpnpDevice, UpnpPacingSnapshot, WasapiExclusiveTelemetrySnapshot,
};

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
    engine.set_audio_device_with_source(&device_name, "tauri_legacy_device")
}

#[tauri::command]
pub fn set_audio_endpoint(
    engine: State<'_, AudioEngine>,
    endpoint: AudioEndpoint,
) -> Result<(), String> {
    engine.set_audio_endpoint_with_source(endpoint, "desktop_ui")
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
pub fn list_audio_endpoints(engine: State<'_, AudioEngine>) -> Vec<AudioEndpointInfo> {
    engine.list_audio_endpoints()
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
pub fn get_upnp_pacing_stats(engine: State<'_, AudioEngine>) -> UpnpPacingSnapshot {
    engine.get_upnp_manager().get_pacing_stats()
}

async fn sync_windows_engine_upnp_pacer(enabled: Option<bool>) -> Option<bool> {
    #[cfg(windows)]
    {
        use crate::commands::remote::{
            core_control_request, probe_localhost_windows_engine, CoreEndpointBridgeTarget,
        };
        let pairing = probe_localhost_windows_engine().await?;
        let target = CoreEndpointBridgeTarget {
            base_url: pairing.base_url,
            pairing_token: pairing.pairing_token,
            cert_fingerprint: pairing.cert_fingerprint,
            trust_insecure: Some(false),
        };
        let mut payload = serde_json::json!({
            "protocolVersion": 2,
            "engineId": pairing.engine_id,
            "libraryId": pairing.library_id,
            "operation": "player.upnp_pacer",
        });
        if let Some(flag) = enabled {
            payload["enabled"] = serde_json::Value::Bool(flag);
        }
        let resp = core_control_request(target, payload).await.ok()?;
        resp.get("data")
            .and_then(|d| d.get("pacerEnabled"))
            .and_then(|v| v.as_bool())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        None
    }
}

#[tauri::command]
pub async fn get_upnp_pacer_enabled() -> bool {
    if let Some(remote_val) = sync_windows_engine_upnp_pacer(None).await {
        crate::audio::upnp::UPNP_PACER_ENABLED
            .store(remote_val, std::sync::atomic::Ordering::Relaxed);
        return remote_val;
    }
    crate::audio::upnp::UPNP_PACER_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
pub async fn set_upnp_pacer_enabled(enabled: bool) -> bool {
    crate::audio::upnp::UPNP_PACER_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    let _ = sync_windows_engine_upnp_pacer(Some(enabled)).await;
    enabled
}

#[tauri::command]
pub fn set_stream_buffer_limit(engine: State<'_, AudioEngine>, limit_mb: u64) -> StreamBufferInfo {
    engine.get_upnp_manager().set_buffer_limit_mb(limit_mb)
}

#[tauri::command]
pub fn prepare_next_track(
    engine: State<'_, AudioEngine>,
    file_path: String,
) -> Result<bool, String> {
    engine.prepare_next_track(&file_path)
}

#[tauri::command]
pub fn invalidate_next_track(engine: State<'_, AudioEngine>) -> Result<(), String> {
    engine.invalidate_next_track()
}

#[tauri::command]
pub fn set_settling_delay_ms(
    engine: State<'_, AudioEngine>,
    delay_ms: u64,
) -> Result<(), String> {
    engine.set_settling_delay_ms(delay_ms)
}

#[tauri::command]
pub fn get_wasapi_exclusive_telemetry(
    engine: State<'_, AudioEngine>,
) -> WasapiExclusiveTelemetrySnapshot {
    engine.get_wasapi_exclusive_telemetry()
}

#[tauri::command]
pub fn set_wasapi_virtual_lock(
    engine: State<'_, AudioEngine>,
    enabled: bool,
) -> Result<bool, String> {
    engine.set_wasapi_virtual_lock(enabled)
}

#[tauri::command]
pub fn set_wasapi_max_preload_bytes(
    engine: State<'_, AudioEngine>,
    max_bytes: usize,
) -> Result<usize, String> {
    engine.set_wasapi_max_preload_bytes(max_bytes)
}

