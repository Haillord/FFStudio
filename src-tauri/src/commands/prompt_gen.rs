use crate::prompt_gen::{PromptGenStatus, PromptGenProgressEvent};

#[tauri::command]
pub(crate) async fn get_prompt_gen_status(
    app: tauri::AppHandle,
) -> Result<PromptGenStatus, String> {
    crate::prompt_gen::get_prompt_gen_status(app).await
}

#[tauri::command]
pub(crate) async fn install_prompt_gen(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<PromptGenStatus, String> {
    crate::prompt_gen::install_prompt_gen(app, window).await
}

#[tauri::command]
pub(crate) async fn generate_sd_prompt(
    app: tauri::AppHandle,
    description: String,
    style: String,
    model_type: String,
) -> Result<String, String> {
    crate::prompt_gen::generate_sd_prompt(app, description, style, model_type).await
}