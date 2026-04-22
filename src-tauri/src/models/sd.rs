use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SdModel {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LoraEntry {
    pub path: String,
    pub weight: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StableDiffusionGenerateArgs {
    pub prompt: String,
    pub negative_prompt: String,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg_scale: f64,
    pub seed: i64,
    pub sampler: String,
    pub model_path: String,
    pub vae_path: Option<String>,
    pub loras: Vec<LoraEntry>,
    pub comfy_api_url: Option<String>,
    pub comfy_dir: Option<String>,
    pub output_dir: Option<String>,
    pub keep_comfy_copy: Option<bool>,
    pub model_type: Option<String>,
    pub hires_fix: Option<bool>,
    pub hires_scale: Option<f64>,
    pub hires_denoise: Option<f64>,
    pub hires_steps: Option<u32>,
    pub hires_upscale_method: Option<String>,
    pub flux_text_encoder_1: Option<String>,
    pub flux_text_encoder_2: Option<String>,
    pub flux_vae_path: Option<String>,
    pub flux_weight_dtype: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StableDiffusionRefineArgs {
    pub input_image: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub cfg_scale: f64,
    pub sampler: String,
    pub model_path: String,
    pub vae_path: Option<String>,
    pub comfy_api_url: Option<String>,
    pub comfy_dir: Option<String>,
    pub output_dir: Option<String>,
    pub keep_comfy_copy: Option<bool>,
    pub hires_scale: Option<f64>,
    pub hires_denoise: Option<f64>,
    pub hires_steps: Option<u32>,
    pub hires_upscale_method: Option<String>,
    pub seed: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyAutoSetupResult {
    pub comfy_api_url: String,
    pub comfy_dir: String,
    pub comfy_python: String,
    pub started: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyInstallResult {
    pub comfy_api_url: String,
    pub comfy_dir: String,
    pub comfy_python: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedModel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
    pub url: String,
    pub filename: String,
    pub target_subdir: String,
    pub note: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgressEvent {
    pub model_id: String,
    pub percent: f64,
    pub downloaded: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
    pub message: String,
}
