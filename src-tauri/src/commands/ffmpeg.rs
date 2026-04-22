#[tauri::command]
pub(crate) async fn check_ffmpeg(app: tauri::AppHandle, ffmpeg_path: String) -> Result<crate::FfmpegVersion, String> {
    crate::check_ffmpeg(app, ffmpeg_path).await
}

#[tauri::command]
pub(crate) async fn get_media_info(app: tauri::AppHandle, input: String, ffprobe_path: String) -> Result<crate::MediaInfo, String> {
    crate::get_media_info(app, input, ffprobe_path).await
}

#[tauri::command]
pub(crate) async fn convert(
    app: tauri::AppHandle,
    args: crate::ConvertArgs,
    window: tauri::Window,
) -> Result<(), String> {
    crate::convert(app, args, window).await
}

#[tauri::command]
pub(crate) async fn convert_concat(
    app: tauri::AppHandle,
    list_path: String,
    output: String,
    args: Vec<String>,
    job_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::convert_concat(app, list_path, output, args, job_id, window).await
}

#[tauri::command]
pub(crate) async fn convert_two_pass(
    app: tauri::AppHandle,
    input: String,
    output: String,
    pass1_args: Vec<String>,
    pass2_args: Vec<String>,
    job_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::convert_two_pass(app, input, output, pass1_args, pass2_args, job_id, window).await
}

#[tauri::command]
pub(crate) async fn cancel_job(job_id: String) -> Result<(), String> {
    crate::cancel_job(job_id).await
}

#[tauri::command]
pub(crate) async fn preview_frame(app: tauri::AppHandle, input: String, time: f64, vf_args: String) -> Result<String, String> {
    crate::preview_frame(app, input, time, vf_args).await
}

#[tauri::command]
pub(crate) async fn prepare_audio_preview(app: tauri::AppHandle, input: String) -> Result<String, String> {
    crate::prepare_audio_preview(app, input).await
}

#[tauri::command]
pub(crate) async fn run_ytdlp(url: String, format: String, output_dir: Option<String>) -> Result<String, String> {
    crate::run_ytdlp(url, format, output_dir).await
}

#[tauri::command]
pub(crate) async fn set_parallel_limit(limit: u32) -> Result<u32, String> {
    crate::set_parallel_limit(limit).await
}
