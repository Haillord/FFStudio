#[tauri::command]
pub(crate) async fn check_whisper(app: tauri::AppHandle) -> Result<String, String> {
    crate::check_whisper(app).await
}

#[tauri::command]
pub(crate) async fn install_whisper(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::install_whisper(app, window).await
}

#[tauri::command]
pub(crate) async fn run_whisper(
    app: tauri::AppHandle, window: tauri::Window,
    input: String, model: String, language: String, job_id: String, output_path: Option<String>,
) -> Result<crate::WhisperResult, String> {
    crate::run_whisper(app, window, input, model, language, job_id, output_path).await
}

#[tauri::command]
pub(crate) async fn burn_subtitles(
    app: tauri::AppHandle, window: tauri::Window,
    input: String, srt_path: String, output: String, hard: bool, job_id: String,
) -> Result<(), String> {
    crate::burn_subtitles(app, window, input, srt_path, output, hard, job_id).await
}