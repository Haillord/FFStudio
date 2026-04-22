use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConvertArgs {
    pub input: String,
    pub output: String,
    pub args: Vec<String>,
    pub job_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProgressEvent {
    pub job_id: String,
    pub percent: f64,
    pub fps: f64,
    pub speed: f64,
    pub time: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MediaInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub video_codec: String,
    pub audio_codec: String,
    pub fps: f64,
    pub bitrate: u64,
    pub size: u64,
    pub format: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FfmpegVersion {
    pub version: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageUpscaleArgs {
    pub input_image: String,
    pub scale: Option<f64>,
    pub method: Option<String>,
    pub output_dir: Option<String>,
    pub comfy_dir: Option<String>,
}
