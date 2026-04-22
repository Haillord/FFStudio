#[tauri::command]
pub(crate) async fn scan_stable_diffusion_models(
    app: tauri::AppHandle,
    comfy_dir: Option<String>,
) -> Result<Vec<crate::SdModel>, String> {
    crate::scan_stable_diffusion_models(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn open_sd_models_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    crate::open_sd_models_folder(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn open_flux_models_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    crate::open_flux_models_folder(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn scan_flux_text_encoders(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<Vec<crate::SdModel>, String> {
    crate::scan_flux_text_encoders(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn open_flux_text_encoders_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    crate::open_flux_text_encoders_folder(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn scan_vae_models(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<Vec<crate::SdModel>, String> {
    crate::scan_vae_models(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn open_vae_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    crate::open_vae_folder(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn scan_lora_models(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<Vec<crate::SdModel>, String> {
    crate::scan_lora_models(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn scan_animatediff_motion_modules(comfy_dir: Option<String>) -> Result<Vec<crate::SdModel>, String> {
    crate::scan_animatediff_motion_modules(comfy_dir).await
}

#[tauri::command]
pub(crate) async fn open_animatediff_motion_folder(comfy_dir: Option<String>) -> Result<(), String> {
    crate::open_animatediff_motion_folder(comfy_dir).await
}

#[tauri::command]
pub(crate) async fn open_lora_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    crate::open_lora_folder(app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn stable_diffusion_generate(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: crate::StableDiffusionGenerateArgs,
) -> Result<serde_json::Value, String> {
    crate::stable_diffusion_generate(app, window, args).await
}

#[tauri::command]
pub(crate) async fn stable_diffusion_refine(
    app: tauri::AppHandle,
    window: tauri::Window,
    args: crate::StableDiffusionRefineArgs,
) -> Result<serde_json::Value, String> {
    crate::stable_diffusion_refine(app, window, args).await
}

#[tauri::command]
pub(crate) async fn cancel_stable_diffusion() -> Result<(), String> {
    crate::cancel_stable_diffusion().await
}

#[tauri::command]
pub(crate) async fn install_animatediff_nodes(_app: tauri::AppHandle, comfy_dir: String) -> Result<String, String> {
    crate::install_animatediff_nodes(_app, comfy_dir).await
}

#[tauri::command]
pub(crate) async fn list_recommended_models() -> Result<Vec<crate::RecommendedModel>, String> {
    crate::list_recommended_models().await
}

#[tauri::command]
pub(crate) async fn upscale_image(
    app: tauri::AppHandle,
    args: crate::ImageUpscaleArgs,
) -> Result<serde_json::Value, String> {
    crate::upscale_image(app, args).await
}

#[tauri::command]
pub(crate) async fn free_comfy_vram(comfy_url: Option<String>) -> Result<(), String> {
    crate::free_comfy_vram(comfy_url.as_deref()).await
}
