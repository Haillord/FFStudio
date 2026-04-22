use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerateResult {
    pub output_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimateDiffVideoArgs {
    pub model: String,
    pub mode: Option<String>,
    pub input_image: Option<String>,
    pub denoise: Option<f64>,
    pub prompt: String,
    pub negative_prompt: String,
    pub checkpoint: String,
    pub motion_module: String,
    pub frames: u32,
    pub fps: u32,
    pub steps: u32,
    pub cfg_scale: f64,
    pub seed: i64,
    pub width: u32,
    pub height: u32,
    pub output_format: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ComfyUploadResponse {
    pub name: String,
    pub subfolder: Option<String>,
    #[serde(rename = "type")]
    pub file_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FishProgressEvent {
    pub percent: f64,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VcClientProgressEvent {
    pub percent: f64,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VcClientStatus {
    pub installed: bool,
    pub running: bool,
    pub status: String,
    pub message: String,
    pub install_dir: String,
    pub log_path: String,
    pub log_tail: String,
    pub ui_url: String,
    pub pid: Option<u32>,
    pub last_message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceGenerateArgs {
    pub model: String,
    pub text: String,
    pub reference_audio: String,
    pub output: String,
    pub speed: f64,
    pub temperature: f64,
    pub top_p: f64,
    pub device: String,
}
