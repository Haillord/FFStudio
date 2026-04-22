#[tauri::command]
pub(crate) async fn video_generate(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: serde_json::Value,
    comfy_api_url: Option<String>,
) -> Result<crate::VideoGenerateResult, String> {
    crate::video_generate(app, window, args, comfy_api_url).await
}
