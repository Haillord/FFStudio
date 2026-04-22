#[tauri::command]
pub(crate) async fn check_fish_speech(app: tauri::AppHandle) -> Result<String, String> {
    crate::check_fish_speech(app).await
}

#[tauri::command]
pub(crate) async fn check_s2_runtime(app: tauri::AppHandle) -> Result<String, String> {
    crate::check_s2_runtime(app).await
}

#[tauri::command]
pub(crate) async fn download_fish_speech(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::download_fish_speech(app, window).await
}

#[tauri::command]
pub(crate) async fn download_s2_runtime(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::download_s2_runtime(app, window).await
}

#[tauri::command]
pub(crate) async fn fish_speech_tts(
    app: tauri::AppHandle,
    window: tauri::Window,
    text: String,
    reference_audio: String,
    output: String,
    speed: f64,
    temperature: f64,
    top_p: f64,
    device: String,
) -> Result<(), String> {
    crate::impl_fish_speech_tts(app, window, text, reference_audio, output, speed, temperature, top_p, device).await
}

#[tauri::command]
pub(crate) async fn voice_tts(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: crate::VoiceGenerateArgs,
) -> Result<(), String> {
    crate::voice_tts(app, window, args).await
}

#[tauri::command]
pub(crate) async fn cancel_fish_speech() -> Result<(), String> {
    crate::cancel_fish_speech().await
}

#[tauri::command]
pub(crate) async fn translate_ru_en(text: String) -> Result<String, String> {
    crate::translate_ru_en(text).await
}

#[tauri::command]
pub(crate) async fn check_vcclient(
    app: tauri::AppHandle,
    server_url: Option<String>,
) -> Result<crate::VcClientStatus, String> {
    crate::check_vcclient(app, server_url).await
}

#[tauri::command]
pub(crate) async fn install_vcclient(
    app: tauri::AppHandle,
    window: tauri::Window,
    flavor: String,
) -> Result<crate::VcClientStatus, String> {
    crate::install_vcclient(app, window, flavor).await
}

#[tauri::command]
pub(crate) async fn start_vcclient(
    app: tauri::AppHandle,
    window: tauri::Window,
    server_url: Option<String>,
) -> Result<crate::VcClientStatus, String> {
    crate::start_vcclient(app, window, server_url).await
}

#[tauri::command]
pub(crate) async fn stop_vcclient(
    app: tauri::AppHandle,
    window: tauri::Window,
    server_url: Option<String>,
) -> Result<crate::VcClientStatus, String> {
    crate::stop_vcclient(app, window, server_url).await
}

#[tauri::command]
pub(crate) async fn open_vcclient_ui(server_url: Option<String>) -> Result<(), String> {
    crate::open_vcclient_ui(server_url).await
}
