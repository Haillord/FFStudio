#[tauri::command]
pub(crate) async fn check_audiocraft(app: tauri::AppHandle) -> Result<String, String> {
    crate::check_audiocraft(app).await
}

#[tauri::command]
pub(crate) async fn install_audiocraft(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::install_audiocraft(app, window).await
}

#[tauri::command]
pub(crate) async fn run_audiocraft(
    app: tauri::AppHandle, window: tauri::Window,
    prompt: String, model: String, duration: f64, reference_audio: String, job_id: String,
) -> Result<crate::AudioCraftResult, String> {
    crate::run_audiocraft(app, window, prompt, model, duration, reference_audio, job_id).await
}
