#[tauri::command]
pub(crate) async fn check_comfyui(comfy_url: String) -> Result<String, String> {
    crate::check_comfyui(comfy_url).await
}

#[tauri::command]
pub(crate) async fn start_comfyui(comfy_url: String, comfy_dir: String, python_bin: String) -> Result<String, String> {
    crate::impl_start_comfyui(comfy_url, comfy_dir, python_bin).await
}

#[tauri::command]
pub(crate) async fn stop_comfyui() -> Result<String, String> {
    crate::impl_stop_comfyui().await
}

#[tauri::command]
pub(crate) async fn restart_comfyui(comfy_url: String, comfy_dir: String, python_bin: String) -> Result<String, String> {
    crate::restart_comfyui(comfy_url, comfy_dir, python_bin).await
}

#[tauri::command]
pub(crate) async fn free_comfyui_memory(comfy_url: String) -> Result<String, String> {
    crate::free_comfyui_memory(comfy_url).await
}

#[tauri::command]
pub(crate) async fn auto_setup_comfyui() -> Result<crate::ComfyAutoSetupResult, String> {
    crate::auto_setup_comfyui().await
}

#[tauri::command]
pub(crate) async fn install_comfyui_portable(install_dir: String) -> Result<crate::ComfyInstallResult, String> {
    crate::install_comfyui_portable(install_dir).await
}

#[tauri::command]
pub(crate) async fn install_recommended_model(
    app: tauri::AppHandle,
    window: tauri::Window,
    model_id: String,
    comfy_dir: String,
) -> Result<String, String> {
    crate::install_recommended_model(app, window, model_id, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn get_gallery_files(outputDir: String) -> Result<Vec<crate::GalleryItem>, String> {
    crate::get_gallery_files(outputDir).await
}
