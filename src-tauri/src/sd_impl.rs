use std::path::PathBuf;
use tauri::Emitter;
use tokio::time::{sleep, Duration};

use crate::comfy_impl::{comfy_base_url, detect_comfy_paths, resolve_comfy_dir_or_detect, recommended_models};
use crate::files_impl::next_available_path_sync;
use crate::models::{
    ImageUpscaleArgs, RecommendedModel, SdModel, StableDiffusionGenerateArgs, StableDiffusionRefineArgs,
};
use crate::utils::encoding::{base64_encode, decode_base64_image_data};
use crate::utils::fs_paths::normalize_fs_input;
use crate::utils::process::new_cmd;
use crate::video_impl::{comfy_join_subfolder, comfy_upload_image};
use crate::{register_temp_file, SD_ACTIVE_COMFY_URL, SD_ACTIVE_PROMPT_ID};

// ─── Внутренние хелперы ───────────────────────────────────────────────────────

pub(crate) fn comfy_checkpoint_name(path: &str) -> Result<String, String> {
    std::path::Path::new(path).file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| "Некорректный путь к модели".to_string())
}

fn comfy_lora_name(path: &str) -> Result<String, String> {
    std::path::Path::new(path).file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| "Некорректный путь к LoRA".to_string())
}

fn comfy_vae_name(path: &str) -> Result<String, String> {
    std::path::Path::new(path).file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| "Некорректный путь к VAE".to_string())
}

fn comfy_text_encoder_name(path: &str) -> Result<String, String> {
    std::path::Path::new(path)
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| "Некорректный путь к text encoder".to_string())
}

pub(crate) fn resolve_sampler_and_scheduler(raw_sampler: &str) -> (&'static str, &'static str) {
    match raw_sampler {
        "euler" => ("euler", "normal"),
        "dpmpp_2m" | "dpmpp_2m_karras" => ("dpmpp_2m", "karras"),
        "dpmpp_2m_normal" => ("dpmpp_2m", "normal"),
        "dpmpp_sde" | "dpmpp_sde_karras" => ("dpmpp_sde", "karras"),
        "dpmpp_sde_normal" => ("dpmpp_sde", "normal"),
        "dpm2" => ("dpm_2", "normal"),
        _ => ("euler_ancestral", "normal"),
    }
}

fn resolve_hires_upscale_method(raw: Option<&str>) -> &'static str {
    match raw.unwrap_or("bicubic") {
        "nearest-exact" => "nearest-exact",
        "bilinear" => "bilinear",
        "area" => "area",
        "bicubic" => "bicubic",
        "bislerp" => "bislerp",
        _ => "bicubic",
    }
}

async fn comfy_object_info(client: &reqwest::Client, comfy_url: &str) -> Result<serde_json::Value, String> {
    let resp = client
        .get(format!("{}/object_info", comfy_url))
        .send()
        .await
        .map_err(|e| format!("ComfyUI недоступен (object_info): {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ComfyUI object_info: HTTP {} {}", status, body));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

fn require_flux_nodes(object_info: &serde_json::Value) -> Result<(), String> {
    let mut missing = Vec::new();
    for node in [
        "UNETLoader",
        "DualCLIPLoader",
        "VAELoader",
        "FluxGuidance",
        "BasicGuider",
        "BasicScheduler",
        "KSamplerSelect",
        "SamplerCustomAdvanced",
        "EmptySD3LatentImage",
    ] {
        if object_info.get(node).is_none() {
            missing.push(node);
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("MISSING_COMFY_NODES: {}", missing.join(", ")))
    }
}

fn require_flux_gguf_nodes(object_info: &serde_json::Value) -> Result<(), String> {
    let mut missing = Vec::new();
    for node in [
        "UnetLoaderGGUF",
        "DualCLIPLoaderGGUF",
        "CLIPTextEncodeFlux",
        "ConditioningZeroOut",
        "KSampler",
        "VAELoader",
        "EmptySD3LatentImage",
    ] {
        if object_info.get(node).is_none() {
            missing.push(node);
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("MISSING_COMFY_NODES: {} (нужен ComfyUI-GGUF)", missing.join(", ")))
    }
}

fn comfy_node_combo_values(
    object_info: &serde_json::Value,
    node_name: &str,
    input_name: &str,
) -> Vec<String> {
    let mut out = Vec::new();
    let required = object_info
        .get(node_name)
        .and_then(|v| v.get("input"))
        .and_then(|v| v.get("required"))
        .and_then(|v| v.get(input_name))
        .and_then(|v| v.as_array());
    let Some(required) = required else { return out };
    for entry in required {
        if let Some(arr) = entry.as_array() {
            for item in arr {
                if let Some(s) = item.as_str() {
                    out.push(s.to_string());
                }
            }
        } else if let Some(s) = entry.as_str() {
            out.push(s.to_string());
        }
    }
    out.sort();
    out.dedup();
    out
}

fn validate_flux_gguf_encoders(
    object_info: &serde_json::Value,
    te1_path: &str,
    te2_path: &str,
) -> Result<(), String> {
    let te1_name = comfy_text_encoder_name(te1_path)?;
    let te2_name = comfy_text_encoder_name(te2_path)?;
    let clip1_opts = comfy_node_combo_values(object_info, "DualCLIPLoaderGGUF", "clip_name1");
    let clip2_opts = comfy_node_combo_values(object_info, "DualCLIPLoaderGGUF", "clip_name2");

    if !clip1_opts.is_empty() && !clip1_opts.iter().any(|v| v == &te1_name) {
        return Err(format!(
            "Text Encoder 1 '{}' не найден в DualCLIPLoaderGGUF.clip_name1. Доступно: {}",
            te1_name,
            clip1_opts.join(", ")
        ));
    }
    if !clip2_opts.is_empty() && !clip2_opts.iter().any(|v| v == &te2_name) {
        return Err(format!(
            "Text Encoder 2 '{}' не найден в DualCLIPLoaderGGUF.clip_name2. Доступно: {}",
            te2_name,
            clip2_opts.join(", ")
        ));
    }
    Ok(())
}

fn resolve_sd_output_dir(
    _app: &tauri::AppHandle, output_dir: Option<&str>, comfy_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let preferred = output_dir.map(normalize_fs_input).unwrap_or_default();
    if !preferred.is_empty() {
        let path = PathBuf::from(preferred);
        std::fs::create_dir_all(&path).map_err(|e| format!("Не удалось создать outputDir: {}", e))?;
        return Ok(path);
    }
    let comfy_normalized = comfy_dir.map(normalize_fs_input).unwrap_or_default();
    let comfy_root = if !comfy_normalized.is_empty() {
        PathBuf::from(comfy_normalized)
    } else if let Some((detected, _)) = detect_comfy_paths() {
        PathBuf::from(detected)
    } else {
        return Err("Не удалось определить папку ComfyUI для сохранения результата".to_string());
    };
    let out = comfy_root.join("output");
    std::fs::create_dir_all(&out).map_err(|e| format!("Не удалось создать ComfyUI/output: {}", e))?;
    Ok(out)
}

pub(crate) fn save_sd_result_bytes(
    app: &tauri::AppHandle, bytes: &[u8], output_dir: Option<&str>, comfy_dir: Option<&str>,
) -> Result<String, String> {
    let out_dir = resolve_sd_output_dir(app, output_dir, comfy_dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let preferred = out_dir.join(format!("ffstudio_{}.png", stamp));
    let final_path = next_available_path_sync(&preferred)?;
    std::fs::write(&final_path, bytes).map_err(|e| format!("Не удалось сохранить результат: {}", e))?;
    Ok(final_path.to_string_lossy().to_string())
}

fn cleanup_comfy_image_if_needed(comfy_dir: Option<&str>, subfolder: &str, filename: &str, keep_copy: bool) {
    // Отключено удаление картинок
}

fn resolve_models_base_dir(_app: &tauri::AppHandle, comfy_dir: Option<&str>) -> Result<PathBuf, String> {
    let normalized = comfy_dir.map(normalize_fs_input).unwrap_or_default();
    if !normalized.is_empty() {
        let direct = PathBuf::from(&normalized);
        if direct.join("main.py").exists() || direct.join("models").exists() {
            return Ok(direct);
        }
        let nested = direct.join("ComfyUI");
        if nested.join("main.py").exists() || nested.join("models").exists() {
            return Ok(nested);
        }
    }
    if let Some((detected_dir, _)) = detect_comfy_paths() {
        let detected = PathBuf::from(detected_dir);
        if detected.join("main.py").exists() || detected.join("models").exists() {
            return Ok(detected);
        }
        let nested = detected.join("ComfyUI");
        if nested.join("main.py").exists() || nested.join("models").exists() {
            return Ok(nested);
        }
    }
    Err("Укажите папку ComfyUI в настройках".to_string())
}

// ─── Сканирование моделей ─────────────────────────────────────────────────────

pub(crate) async fn scan_stable_diffusion_models(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<Vec<SdModel>, String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    let mut models = Vec::new();

    let mut collect_from = |dir: &PathBuf| {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let lower = name.to_lowercase();
                    if lower.ends_with(".safetensors") || lower.ends_with(".ckpt") || lower.ends_with(".gguf") {
                        models.push(SdModel { name, path: entry.path().to_string_lossy().to_string() });
                    }
                }
            }
        }
    };

    collect_from(&base_dir.join("models").join("checkpoints"));
    collect_from(&base_dir.join("models").join("unet"));
    collect_from(&base_dir.join("models").join("diffusion_models"));

    Ok(models)
}

pub(crate) async fn open_sd_models_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(base_dir.join("models").join("checkpoints")).spawn().ok();
    Ok(())
}

pub(crate) async fn open_flux_models_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    let unet_dir = base_dir.join("models").join("unet");
    std::fs::create_dir_all(&unet_dir).ok();
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(unet_dir).spawn().ok();
    Ok(())
}

pub(crate) async fn scan_flux_text_encoders(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<Vec<SdModel>, String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    let mut models = Vec::new();
    let mut collect_from = |dir: &PathBuf| {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let lower = name.to_lowercase();
                    if lower.ends_with(".safetensors") || lower.ends_with(".gguf") || lower.ends_with(".bin") {
                        models.push(SdModel { name, path: entry.path().to_string_lossy().to_string() });
                    }
                }
            }
        }
    };
    collect_from(&base_dir.join("models").join("text_encoders"));
    collect_from(&base_dir.join("models").join("clip"));
    Ok(models)
}

pub(crate) async fn open_flux_text_encoders_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    // Для FLUX в актуальных примерах чаще используются clip_l/t5xxl из models/clip.
    let text_dir = base_dir.join("models").join("clip");
    std::fs::create_dir_all(&text_dir).ok();
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(text_dir).spawn().ok();
    Ok(())
}

pub(crate) async fn scan_vae_models(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<Vec<SdModel>, String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    let vae_dir = base_dir.join("models").join("vae");
    std::fs::create_dir_all(&vae_dir).ok();
    let mut models = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&vae_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if lower.ends_with(".safetensors") || lower.ends_with(".ckpt") || lower.ends_with(".pt") {
                    models.push(SdModel { name, path: entry.path().to_string_lossy().to_string() });
                }
            }
        }
    }
    Ok(models)
}

pub(crate) async fn open_vae_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    let vae_dir = base_dir.join("models").join("vae");
    std::fs::create_dir_all(&vae_dir).ok();
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(vae_dir).spawn().ok();
    Ok(())
}

pub(crate) async fn scan_lora_models(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<Vec<SdModel>, String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    let lora_dir = base_dir.join("models").join("loras");
    let mut models = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&lora_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if lower.ends_with(".safetensors") || lower.ends_with(".pt") || lower.ends_with(".bin") {
                    models.push(SdModel { name, path: entry.path().to_string_lossy().to_string() });
                }
            }
        }
    }
    Ok(models)
}

pub(crate) async fn scan_animatediff_motion_modules(comfy_dir: Option<String>) -> Result<Vec<SdModel>, String> {
    let comfy_root = resolve_comfy_dir_or_detect(comfy_dir.as_deref().unwrap_or(""))?;
    let motion_dir = comfy_root.join("custom_nodes").join("comfyui-animatediff").join("models");
    std::fs::create_dir_all(&motion_dir).ok();
    let mut models = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&motion_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if lower.ends_with(".ckpt") || lower.ends_with(".pth") || lower.ends_with(".safetensors") {
                    models.push(SdModel { name, path: entry.path().to_string_lossy().to_string() });
                }
            }
        }
    }
    Ok(models)
}

pub(crate) async fn open_animatediff_motion_folder(comfy_dir: Option<String>) -> Result<(), String> {
    let comfy_root = resolve_comfy_dir_or_detect(comfy_dir.as_deref().unwrap_or(""))?;
    let motion_dir = comfy_root.join("custom_nodes").join("comfyui-animatediff").join("models");
    std::fs::create_dir_all(&motion_dir).ok();
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(motion_dir).spawn().ok();
    Ok(())
}

pub(crate) async fn open_lora_folder(app: tauri::AppHandle, comfy_dir: Option<String>) -> Result<(), String> {
    let base_dir = resolve_models_base_dir(&app, comfy_dir.as_deref())?;
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(base_dir.join("models").join("loras")).spawn().ok();
    Ok(())
}

// ─── Построение workflow ──────────────────────────────────────────────────────

fn build_comfy_workflow(args: &StableDiffusionGenerateArgs) -> Result<serde_json::Value, String> {
    let ckpt_name = comfy_checkpoint_name(&args.model_path)?;
    let model_type = args.model_type.as_deref().unwrap_or("sd15");
    let model_file_name = std::path::Path::new(&args.model_path)
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| "Некорректный путь к модели".to_string())?;
    let mut workflow = serde_json::Map::new();

    workflow.insert("1".to_string(), serde_json::json!({
        "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt_name }
    }));

    let mut current_model_ref = serde_json::json!(["1", 0]);
    let mut current_clip_ref = serde_json::json!(["1", 1]);
    let mut current_vae_ref = serde_json::json!(["1", 2]);
    let mut next_id = 10u32;
    let (sampler_name, scheduler_name) = resolve_sampler_and_scheduler(args.sampler.as_str());
    let seed = if args.seed < 0 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
    } else { args.seed };

    for lora in &args.loras {
        let lora_name = comfy_lora_name(&lora.path)?;
        let id_str = next_id.to_string();
        workflow.insert(id_str.clone(), serde_json::json!({
            "class_type": "LoraLoader",
            "inputs": {
                "model": current_model_ref, "clip": current_clip_ref,
                "lora_name": lora_name, "strength_model": lora.weight, "strength_clip": lora.weight
            }
        }));
        current_model_ref = serde_json::json!([id_str, 0]);
        current_clip_ref = serde_json::json!([next_id.to_string(), 1]);
        next_id += 1;
    }

    if let Some(raw_vae_path) = args.vae_path.as_deref() {
        let trimmed = raw_vae_path.trim();
        if !trimmed.is_empty() {
            let vae_name = comfy_vae_name(trimmed)?;
            let id_str = next_id.to_string();
            workflow.insert(id_str.clone(), serde_json::json!({
                "class_type": "VAELoader", "inputs": { "vae_name": vae_name }
            }));
            current_vae_ref = serde_json::json!([id_str, 0]);
        }
    }

    if model_type == "flux_gguf" {
        let te1 = args.flux_text_encoder_1.as_deref().ok_or_else(|| "Не выбран Text Encoder 1".to_string())?;
        let te2 = args.flux_text_encoder_2.as_deref().ok_or_else(|| "Не выбран Text Encoder 2".to_string())?;
        let flux_vae = args.flux_vae_path.as_deref().ok_or_else(|| "Не выбран FLUX VAE".to_string())?;
        let clip_name_1 = comfy_text_encoder_name(te1)?;
        let clip_name_2 = comfy_text_encoder_name(te2)?;
        let flux_vae_name = comfy_vae_name(flux_vae)?;
        workflow = serde_json::Map::new();
        workflow.insert("1".to_string(), serde_json::json!({
            "class_type": "UnetLoaderGGUF",
            "inputs": { "unet_name": model_file_name }
        }));
        workflow.insert("2".to_string(), serde_json::json!({
            "class_type": "DualCLIPLoaderGGUF",
            "inputs": { "clip_name1": clip_name_1, "clip_name2": clip_name_2, "type": "flux" }
        }));
        workflow.insert("3".to_string(), serde_json::json!({
            "class_type": "VAELoader",
            "inputs": { "vae_name": flux_vae_name }
        }));
        workflow.insert("4".to_string(), serde_json::json!({
            "class_type": "CLIPTextEncodeFlux",
            "inputs": { "clip": ["2", 0], "clip_l": args.prompt, "t5xxl": args.prompt, "guidance": args.cfg_scale.max(1.0) }
        }));
        workflow.insert("5".to_string(), serde_json::json!({
            "class_type": "CLIPTextEncode",
            "inputs": { "text": args.negative_prompt, "clip": ["2", 0] }
        }));
        workflow.insert("6".to_string(), serde_json::json!({
            "class_type": "EmptySD3LatentImage",
            "inputs": { "width": args.width, "height": args.height, "batch_size": 1 }
        }));
        workflow.insert("7".to_string(), serde_json::json!({
            "class_type": "KSampler",
            "inputs": {
                "seed": seed, "steps": args.steps, "cfg": args.cfg_scale.max(1.0),
                "sampler_name": sampler_name, "scheduler": "simple", "denoise": 1.0,
                "model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]
            }
        }));
        workflow.insert("8".to_string(), serde_json::json!({
            "class_type": "VAEDecode", "inputs": { "samples": ["7", 0], "vae": ["3", 0] }
        }));
        workflow.insert("9".to_string(), serde_json::json!({
            "class_type": "SaveImage", "inputs": { "filename_prefix": "ffstudio", "images": ["8", 0] }
        }));
        return Ok(serde_json::Value::Object(workflow));
    } else if model_type == "flux" {
        let te1 = args.flux_text_encoder_1.as_deref().ok_or_else(|| "Не выбран Text Encoder 1".to_string())?;
        let te2 = args.flux_text_encoder_2.as_deref().ok_or_else(|| "Не выбран Text Encoder 2".to_string())?;
        let flux_vae = args.flux_vae_path.as_deref().ok_or_else(|| "Не выбран FLUX VAE".to_string())?;
        let clip_name_1 = comfy_text_encoder_name(te1)?;
        let clip_name_2 = comfy_text_encoder_name(te2)?;
        let flux_vae_name = comfy_vae_name(flux_vae)?;
        let weight_dtype = args
            .flux_weight_dtype
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or("default");
        workflow = serde_json::Map::new();
        workflow.insert("1".to_string(), serde_json::json!({
            "class_type": "UNETLoader",
            "inputs": { "unet_name": model_file_name, "weight_dtype": weight_dtype }
        }));
        workflow.insert("2".to_string(), serde_json::json!({
            "class_type": "DualCLIPLoader",
            "inputs": {
                "clip_name1": clip_name_1,
                "clip_name2": clip_name_2,
                "type": "flux",
                "device": "default"
            }
        }));
        workflow.insert("3".to_string(), serde_json::json!({
            "class_type": "CLIPTextEncode",
            "inputs": { "text": args.prompt, "clip": ["2", 0] }
        }));
        workflow.insert("4".to_string(), serde_json::json!({
            "class_type": "FluxGuidance",
            "inputs": { "conditioning": ["3", 0], "guidance": args.cfg_scale.max(1.0) }
        }));
        workflow.insert("5".to_string(), serde_json::json!({
            "class_type": "EmptySD3LatentImage",
            "inputs": { "width": args.width, "height": args.height, "batch_size": 1 }
        }));
        workflow.insert("6".to_string(), serde_json::json!({
            "class_type": "BasicGuider",
            "inputs": { "model": ["1", 0], "conditioning": ["4", 0] }
        }));
        workflow.insert("7".to_string(), serde_json::json!({
            "class_type": "KSamplerSelect",
            "inputs": { "sampler_name": sampler_name }
        }));
        workflow.insert("8".to_string(), serde_json::json!({
            "class_type": "BasicScheduler",
            "inputs": { "model": ["1", 0], "scheduler": "simple", "steps": args.steps, "denoise": 1.0 }
        }));
        workflow.insert("9".to_string(), serde_json::json!({
            "class_type": "RandomNoise",
            "inputs": { "noise_seed": seed }
        }));
        workflow.insert("10".to_string(), serde_json::json!({
            "class_type": "SamplerCustomAdvanced",
            "inputs": { "noise": ["9", 0], "guider": ["6", 0], "sampler": ["7", 0], "sigmas": ["8", 0], "latent_image": ["5", 0] }
        }));
        workflow.insert("11".to_string(), serde_json::json!({
            "class_type": "VAELoader",
            "inputs": { "vae_name": flux_vae_name }
        }));
        workflow.insert("12".to_string(), serde_json::json!({
            "class_type": "VAEDecode", "inputs": { "samples": ["10", 0], "vae": ["11", 0] }
        }));
        workflow.insert("13".to_string(), serde_json::json!({
            "class_type": "SaveImage", "inputs": { "filename_prefix": "ffstudio", "images": ["12", 0] }
        }));
        return Ok(serde_json::Value::Object(workflow));
    } else if model_type == "sdxl" {
        workflow.insert("2".to_string(), serde_json::json!({
            "class_type": "CLIPTextEncodeSDXL",
            "inputs": { "width": args.width, "height": args.height, "crop_w": 0, "crop_h": 0,
                "target_width": args.width, "target_height": args.height,
                "text_g": args.prompt, "text_l": args.prompt, "clip": current_clip_ref.clone() }
        }));
        workflow.insert("3".to_string(), serde_json::json!({
            "class_type": "CLIPTextEncodeSDXL",
            "inputs": { "width": args.width, "height": args.height, "crop_w": 0, "crop_h": 0,
                "target_width": args.width, "target_height": args.height,
                "text_g": args.negative_prompt, "text_l": args.negative_prompt, "clip": current_clip_ref }
        }));
    } else {
        workflow.insert("2".to_string(), serde_json::json!({
            "class_type": "CLIPTextEncode",
            "inputs": { "text": args.prompt, "clip": current_clip_ref.clone() }
        }));
        workflow.insert("3".to_string(), serde_json::json!({
            "class_type": "CLIPTextEncode",
            "inputs": { "text": args.negative_prompt, "clip": current_clip_ref }
        }));
    }

    workflow.insert("4".to_string(), serde_json::json!({
        "class_type": "EmptyLatentImage",
        "inputs": { "width": args.width, "height": args.height, "batch_size": 1 }
    }));

    workflow.insert("5".to_string(), serde_json::json!({
        "class_type": "KSampler",
        "inputs": { "seed": seed, "steps": args.steps, "cfg": args.cfg_scale,
            "sampler_name": sampler_name, "scheduler": scheduler_name, "denoise": 1.0,
            "model": current_model_ref, "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0] }
    }));

    let use_hires_fix = model_type == "sd15" && args.hires_fix.unwrap_or(false);
    if use_hires_fix {
        let hires_scale = args.hires_scale.unwrap_or(1.5).clamp(1.2, 2.0);
        let hires_steps = args.hires_steps.unwrap_or(12).clamp(6, 30);
        let hires_denoise = args.hires_denoise.unwrap_or(0.25).clamp(0.1, 0.6);
        let hires_upscale_method = resolve_hires_upscale_method(args.hires_upscale_method.as_deref());
        workflow.insert("6".to_string(), serde_json::json!({
            "class_type": "LatentUpscaleBy",
            "inputs": { "samples": ["5", 0], "upscale_method": hires_upscale_method, "scale_by": hires_scale }
        }));
        workflow.insert("7".to_string(), serde_json::json!({
            "class_type": "KSampler",
            "inputs": { "seed": seed, "steps": hires_steps, "cfg": args.cfg_scale,
                "sampler_name": sampler_name, "scheduler": scheduler_name, "denoise": hires_denoise,
                "model": current_model_ref, "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["6", 0] }
        }));
        workflow.insert("8".to_string(), serde_json::json!({
            "class_type": "VAEDecode", "inputs": { "samples": ["7", 0], "vae": current_vae_ref }
        }));
        workflow.insert("9".to_string(), serde_json::json!({
            "class_type": "SaveImage", "inputs": { "filename_prefix": "ffstudio", "images": ["8", 0] }
        }));
    } else {
        workflow.insert("6".to_string(), serde_json::json!({
            "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": current_vae_ref }
        }));
        workflow.insert("7".to_string(), serde_json::json!({
            "class_type": "SaveImage", "inputs": { "filename_prefix": "ffstudio", "images": ["6", 0] }
        }));
    }

    Ok(serde_json::Value::Object(workflow))
}

fn build_comfy_refine_workflow(
    args: &StableDiffusionRefineArgs, uploaded: &crate::models::ComfyUploadResponse,
) -> Result<serde_json::Value, String> {
    let ckpt_name = comfy_checkpoint_name(&args.model_path)?;
    let mut workflow = serde_json::Map::new();

    workflow.insert("1".to_string(), serde_json::json!({
        "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt_name }
    }));

    let current_clip_ref = serde_json::json!(["1", 1]);
    let mut current_vae_ref = serde_json::json!(["1", 2]);
    let mut next_id = 10u32;

    if let Some(raw_vae_path) = args.vae_path.as_deref() {
        let trimmed = raw_vae_path.trim();
        if !trimmed.is_empty() {
            let vae_name = comfy_vae_name(trimmed)?;
            let id_str = next_id.to_string();
            workflow.insert(id_str.clone(), serde_json::json!({
                "class_type": "VAELoader", "inputs": { "vae_name": vae_name }
            }));
            current_vae_ref = serde_json::json!([id_str, 0]);
            next_id += 1;
        }
    }

    let prompt_id = next_id.to_string();
    workflow.insert(prompt_id.clone(), serde_json::json!({
        "class_type": "CLIPTextEncode", "inputs": { "text": args.prompt, "clip": current_clip_ref.clone() }
    })); next_id += 1;

    let negative_id = next_id.to_string();
    workflow.insert(negative_id.clone(), serde_json::json!({
        "class_type": "CLIPTextEncode", "inputs": { "text": args.negative_prompt, "clip": current_clip_ref }
    })); next_id += 1;

    let image_ref = comfy_join_subfolder(uploaded.subfolder.as_deref(), &uploaded.name);
    let load_id = next_id.to_string();
    workflow.insert(load_id.clone(), serde_json::json!({
        "class_type": "LoadImage", "inputs": { "image": image_ref }
    })); next_id += 1;

    let vae_encode_id = next_id.to_string();
    workflow.insert(vae_encode_id.clone(), serde_json::json!({
        "class_type": "VAEEncode", "inputs": { "pixels": [load_id, 0], "vae": current_vae_ref.clone() }
    })); next_id += 1;

    let hires_scale = args.hires_scale.unwrap_or(1.5).clamp(1.2, 2.0);
    let hires_steps = args.hires_steps.unwrap_or(12).clamp(6, 30);
    let hires_denoise = args.hires_denoise.unwrap_or(0.25).clamp(0.1, 0.6);
    let hires_upscale_method = resolve_hires_upscale_method(args.hires_upscale_method.as_deref());

    let latent_upscale_id = next_id.to_string();
    workflow.insert(latent_upscale_id.clone(), serde_json::json!({
        "class_type": "LatentUpscaleBy",
        "inputs": { "samples": [vae_encode_id, 0], "upscale_method": hires_upscale_method, "scale_by": hires_scale }
    })); next_id += 1;

    let (sampler_name, scheduler_name) = resolve_sampler_and_scheduler(args.sampler.as_str());
    let seed = if args.seed < 0 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
    } else { args.seed };

    let ks_id = next_id.to_string();
    workflow.insert(ks_id.clone(), serde_json::json!({
        "class_type": "KSampler",
        "inputs": { "seed": seed, "steps": hires_steps, "cfg": args.cfg_scale,
            "sampler_name": sampler_name, "scheduler": scheduler_name, "denoise": hires_denoise,
            "model": ["1", 0], "positive": [prompt_id, 0], "negative": [negative_id, 0],
            "latent_image": [latent_upscale_id, 0] }
    })); next_id += 1;

    let decode_id = next_id.to_string();
    workflow.insert(decode_id.clone(), serde_json::json!({
        "class_type": "VAEDecode", "inputs": { "samples": [ks_id, 0], "vae": current_vae_ref }
    })); next_id += 1;

    workflow.insert(next_id.to_string(), serde_json::json!({
        "class_type": "SaveImage", "inputs": { "filename_prefix": "ffstudio", "images": [decode_id, 0] }
    }));

    Ok(serde_json::Value::Object(workflow))
}

// ─── Генерация изображений ────────────────────────────────────────────────────

pub(crate) async fn stable_diffusion_generate(
    app: tauri::AppHandle, window: tauri::Window, args: StableDiffusionGenerateArgs,
) -> Result<serde_json::Value, String> {
    if args.model_path.is_empty() { return Err("Модель не выбрана".to_string()); }
    if !std::path::Path::new(&args.model_path).exists() {
        return Err(format!("Файл модели не найден: {}", args.model_path));
    }
    if let Some(vae_path) = args.vae_path.as_deref() {
        let trimmed = vae_path.trim();
        if !trimmed.is_empty() && !std::path::Path::new(trimmed).exists() {
            return Err(format!("Файл VAE не найден: {}", trimmed));
        }
    }

    let comfy_url = comfy_base_url(args.comfy_api_url.as_deref());
    *SD_ACTIVE_COMFY_URL.lock().unwrap() = Some(comfy_url.clone());
    let client = reqwest::Client::new();
    let model_type = args.model_type.as_deref().unwrap_or("sd15");
    if model_type == "flux" || model_type == "flux_gguf" {
        let normalized_model_path = args.model_path.replace('\\', "/").to_lowercase();
        if model_type == "flux_gguf" {
            if !normalized_model_path.ends_with(".gguf") {
                return Err("Для FLUX GGUF нужно выбрать модель с расширением .gguf".to_string());
            }
            if !normalized_model_path.contains("/models/unet/") {
                return Err("Для FLUX GGUF поместите модель в ComfyUI/models/unet и выберите ее оттуда".to_string());
            }
        }
        if let Some(te1) = args.flux_text_encoder_1.as_deref() {
            if te1.trim().is_empty() || !std::path::Path::new(te1).exists() {
                return Err("Файл Text Encoder 1 не найден".to_string());
            }
        } else {
            return Err("Не выбран Text Encoder 1".to_string());
        }
        if let Some(te2) = args.flux_text_encoder_2.as_deref() {
            if te2.trim().is_empty() || !std::path::Path::new(te2).exists() {
                return Err("Файл Text Encoder 2 не найден".to_string());
            }
        } else {
            return Err("Не выбран Text Encoder 2".to_string());
        }
        if let Some(fvae) = args.flux_vae_path.as_deref() {
            if fvae.trim().is_empty() || !std::path::Path::new(fvae).exists() {
                return Err("Файл FLUX VAE не найден".to_string());
            }
        } else {
            return Err("Не выбран FLUX VAE".to_string());
        }
        let info = comfy_object_info(&client, &comfy_url).await?;
        if model_type == "flux_gguf" {
            require_flux_gguf_nodes(&info)?;
            let te1 = args.flux_text_encoder_1.as_deref().unwrap_or_default();
            let te2 = args.flux_text_encoder_2.as_deref().unwrap_or_default();
            validate_flux_gguf_encoders(&info, te1, te2)?;
        } else {
            require_flux_nodes(&info)?;
        }
    }
    let workflow = build_comfy_workflow(&args)?;
    let client_id = format!("ffstudio-{}", std::process::id());

    let seed = if args.seed < 0 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
    } else { args.seed };

    let queue_resp = client.post(format!("{}/prompt", comfy_url))
        .json(&serde_json::json!({ "prompt": workflow, "client_id": client_id }))
        .send().await
        .map_err(|e| format!("ComfyUI недоступен: {}. Запустите ComfyUI на 127.0.0.1:8188 или задайте COMFYUI_API_URL.", e))?;

    if !queue_resp.status().is_success() {
        let status = queue_resp.status();
        let body = queue_resp.text().await.unwrap_or_default();
        return Err(format!("ComfyUI вернул ошибку постановки в очередь: HTTP {}. {}", status, body));
    }

    let queue_json: serde_json::Value = queue_resp.json().await.map_err(|e| e.to_string())?;
    if let Some(node_errors) = queue_json.get("node_errors") {
        let has_node_errors = !node_errors.is_null()
            && (node_errors.as_object().map(|o| !o.is_empty()).unwrap_or(false)
                || node_errors.as_array().map(|a| !a.is_empty()).unwrap_or(false));
        if has_node_errors {
            return Err(format!("ComfyUI вернул node_errors: {}", node_errors));
        }
    }
    let prompt_id = queue_json["prompt_id"].as_str()
        .ok_or_else(|| "ComfyUI не вернул prompt_id".to_string())?.to_string();
    *SD_ACTIVE_PROMPT_ID.lock().unwrap() = Some(prompt_id.clone());

    let mut progress_step = 0u32;
    let mut empty_outputs_after_finish_checks = 0u32;
    let extra_steps = if args.model_type.as_deref().unwrap_or("sd15") == "sd15" && args.hires_fix.unwrap_or(false) {
        args.hires_steps.unwrap_or(12)
    } else { 0 };
    let total_steps = (args.steps + extra_steps).max(1);
    window.emit("sd-progress", serde_json::json!({ "percent": 2.0, "step": 0, "totalSteps": total_steps })).ok();

    loop {
        if SD_ACTIVE_PROMPT_ID.lock().unwrap().is_none() { return Err("CANCELLED".to_string()); }

        let history_resp = client.get(format!("{}/history/{}", comfy_url, prompt_id))
            .send().await.map_err(|e| format!("Ошибка запроса истории ComfyUI: {}", e))?;

        if history_resp.status().is_success() {
            let history: serde_json::Value = history_resp.json().await.map_err(|e| e.to_string())?;
            if let Some(entry) = history.get(&prompt_id) {
                if let Some(outputs) = entry.get("outputs").and_then(|v| v.as_object()) {
                    if let Some((filename, subfolder, img_type)) =
                        comfy_find_image_descriptor(&serde_json::Value::Object(outputs.clone()))
                    {
                        let image_resp = client.get(format!("{}/view", comfy_url))
                            .query(&[("filename", filename.as_str()), ("subfolder", subfolder.as_str()), ("type", img_type.as_str())])
                            .send().await.map_err(|e| format!("Ошибка загрузки результата из ComfyUI: {}", e))?;
                        if !image_resp.status().is_success() {
                            return Err(format!("ComfyUI не отдал изображение: HTTP {}", image_resp.status()));
                        }
                        let bytes = image_resp.bytes().await.map_err(|e| e.to_string())?;
                        cleanup_comfy_image_if_needed(args.comfy_dir.as_deref(), &subfolder, &filename, args.keep_comfy_copy.unwrap_or(false));
                        let base64 = base64_encode(&bytes);
                        *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                        *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                        window.emit("sd-progress", serde_json::json!({ "percent": 100.0, "step": total_steps, "totalSteps": total_steps })).ok();

                        let _ = free_comfy_vram(Some(&comfy_url)).await;
                        return Ok(serde_json::json!({ "image": base64, "seed": seed }));
                    }
                    if comfy_entry_finished(entry) {
                        if let Some(err_msg) = comfy_extract_error(entry) {
                            *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                            *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                            let _ = free_comfy_vram(Some(&comfy_url)).await;
                            return Err(format!("Ошибка ComfyUI: {}", err_msg));
                        }
                        if entry
                            .get("status")
                            .and_then(|v| v.get("status_str"))
                            .and_then(|v| v.as_str())
                            == Some("error")
                        {
                            *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                            *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                            let _ = free_comfy_vram(Some(&comfy_url)).await;
                            return Err(format!(
                                "Ошибка ComfyUI (raw messages): {}",
                                comfy_status_messages_dump(entry)
                            ));
                        }
                        empty_outputs_after_finish_checks += 1;
                        if empty_outputs_after_finish_checks < 12 {
                            sleep(Duration::from_millis(450)).await;
                            continue;
                        }
                        let output_nodes: Vec<String> = outputs.keys().cloned().collect();
                        return Err(format!(
                            "ComfyUI завершил задачу, но не вернул изображение (prompt_id={}, output_nodes={}, {})",
                            prompt_id,
                            output_nodes.join(", "),
                            comfy_status_summary(entry)
                        ));
                    }
                }
                if let Some(err_msg) = comfy_extract_error(entry) {
                    *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                    *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                    
                    let _ = free_comfy_vram(Some(&comfy_url)).await;
                    return Err(format!("Ошибка ComfyUI: {}", err_msg));
                }
                if entry
                    .get("status")
                    .and_then(|v| v.get("status_str"))
                    .and_then(|v| v.as_str())
                    == Some("error")
                {
                    *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                    *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                    let _ = free_comfy_vram(Some(&comfy_url)).await;
                    return Err(format!(
                        "Ошибка ComfyUI (raw messages): {}",
                        comfy_status_messages_dump(entry)
                    ));
                }
            }
        }

        if progress_step < total_steps { progress_step += 1; }
        let percent = ((progress_step as f64 / total_steps as f64) * 92.0 + 3.0).min(95.0);
        window.emit("sd-progress", serde_json::json!({ "percent": percent, "step": progress_step.min(total_steps), "totalSteps": total_steps })).ok();
        sleep(Duration::from_millis(450)).await;
    }
}

pub(crate) async fn stable_diffusion_refine(
    app: tauri::AppHandle, window: tauri::Window, args: StableDiffusionRefineArgs,
) -> Result<serde_json::Value, String> {
    if args.model_path.is_empty() { return Err("Модель не выбрана".to_string()); }
    if !std::path::Path::new(&args.model_path).exists() {
        return Err(format!("Файл модели не найден: {}", args.model_path));
    }
    if args.input_image.trim().is_empty() { return Err("Нет входного изображения для Refine".to_string()); }

    let input_bytes = decode_base64_image_data(&args.input_image)?;
    let tmp_path = std::env::temp_dir().join(format!(
        "ffstudio_refine_input_{}_{}.png", std::process::id(), chrono::Utc::now().timestamp_millis()
    ));
    std::fs::write(&tmp_path, input_bytes).map_err(|e| format!("Не удалось сохранить входное изображение: {}", e))?;
    register_temp_file(tmp_path.clone());

    let comfy_url = comfy_base_url(args.comfy_api_url.as_deref());
    *SD_ACTIVE_COMFY_URL.lock().unwrap() = Some(comfy_url.clone());
    let client = reqwest::Client::new();
    let client_id = format!("ffstudio-{}", std::process::id());

    let uploaded = comfy_upload_image(&client, &comfy_url, &tmp_path.to_string_lossy()).await?;
    let workflow = build_comfy_refine_workflow(&args, &uploaded)?;

    let seed = if args.seed < 0 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
    } else { args.seed };

    let queue_resp = client.post(format!("{}/prompt", comfy_url))
        .json(&serde_json::json!({ "prompt": workflow, "client_id": client_id }))
        .send().await
        .map_err(|e| format!("ComfyUI недоступен: {}. Запустите ComfyUI на 127.0.0.1:8188 или задайте COMFYUI_API_URL.", e))?;

    if !queue_resp.status().is_success() {
        let status = queue_resp.status();
        let body = queue_resp.text().await.unwrap_or_default();
        return Err(format!("ComfyUI вернул ошибку: HTTP {}. {}", status, body));
    }

    let queue_json: serde_json::Value = queue_resp.json().await.map_err(|e| e.to_string())?;
    if let Some(node_errors) = queue_json.get("node_errors") {
        let has_node_errors = !node_errors.is_null()
            && (node_errors.as_object().map(|o| !o.is_empty()).unwrap_or(false)
                || node_errors.as_array().map(|a| !a.is_empty()).unwrap_or(false));
        if has_node_errors {
            return Err(format!("ComfyUI вернул node_errors: {}", node_errors));
        }
    }
    let prompt_id = queue_json["prompt_id"].as_str()
        .ok_or_else(|| "ComfyUI не вернул prompt_id".to_string())?.to_string();
    *SD_ACTIVE_PROMPT_ID.lock().unwrap() = Some(prompt_id.clone());

    let mut progress_step = 0u32;
    let mut empty_outputs_after_finish_checks = 0u32;
    let total_steps = args.hires_steps.unwrap_or(12).clamp(6, 30);
    window.emit("sd-progress", serde_json::json!({ "percent": 2.0, "step": 0, "totalSteps": total_steps })).ok();

    loop {
        if SD_ACTIVE_PROMPT_ID.lock().unwrap().is_none() { return Err("CANCELLED".to_string()); }

        let history_resp = client.get(format!("{}/history/{}", comfy_url, prompt_id))
            .send().await.map_err(|e| format!("Ошибка запроса истории ComfyUI: {}", e))?;

        if history_resp.status().is_success() {
            let history: serde_json::Value = history_resp.json().await.map_err(|e| e.to_string())?;
            if let Some(entry) = history.get(&prompt_id) {
                if let Some(outputs) = entry.get("outputs").and_then(|v| v.as_object()) {
                    if let Some((filename, subfolder, img_type)) =
                        comfy_find_image_descriptor(&serde_json::Value::Object(outputs.clone()))
                    {
                        let image_resp = client.get(format!("{}/view", comfy_url))
                            .query(&[("filename", filename.as_str()), ("subfolder", subfolder.as_str()), ("type", img_type.as_str())])
                            .send().await.map_err(|e| format!("Ошибка загрузки результата: {}", e))?;
                        if !image_resp.status().is_success() {
                            return Err(format!("ComfyUI не отдал изображение: HTTP {}", image_resp.status()));
                        }
                        let bytes = image_resp.bytes().await.map_err(|e| e.to_string())?;
                        cleanup_comfy_image_if_needed(args.comfy_dir.as_deref(), &subfolder, &filename, args.keep_comfy_copy.unwrap_or(false));
                        let base64 = base64_encode(&bytes);
                        *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                        *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                        window.emit("sd-progress", serde_json::json!({ "percent": 100.0, "step": total_steps, "totalSteps": total_steps })).ok();

                        let _ = free_comfy_vram(Some(&comfy_url)).await;
                        return Ok(serde_json::json!({ "image": base64, "seed": seed }));
                    }
                    if comfy_entry_finished(entry) {
                        if let Some(err_msg) = comfy_extract_error(entry) {
                            *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                            *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                            let _ = free_comfy_vram(Some(&comfy_url)).await;
                            return Err(format!("Ошибка ComfyUI: {}", err_msg));
                        }
                        if entry
                            .get("status")
                            .and_then(|v| v.get("status_str"))
                            .and_then(|v| v.as_str())
                            == Some("error")
                        {
                            *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                            *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                            let _ = free_comfy_vram(Some(&comfy_url)).await;
                            return Err(format!(
                                "Ошибка ComfyUI (raw messages): {}",
                                comfy_status_messages_dump(entry)
                            ));
                        }
                        empty_outputs_after_finish_checks += 1;
                        if empty_outputs_after_finish_checks < 12 {
                            sleep(Duration::from_millis(450)).await;
                            continue;
                        }
                        let output_nodes: Vec<String> = outputs.keys().cloned().collect();
                        return Err(format!(
                            "ComfyUI завершил Refine, но не вернул изображение (prompt_id={}, output_nodes={}, {})",
                            prompt_id,
                            output_nodes.join(", "),
                            comfy_status_summary(entry)
                        ));
                    }
                }
                if let Some(err_msg) = comfy_extract_error(entry) {
                    *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                    *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                    
                    let _ = free_comfy_vram(Some(&comfy_url)).await;
                    return Err(format!("Ошибка ComfyUI: {}", err_msg));
                }
                if entry
                    .get("status")
                    .and_then(|v| v.get("status_str"))
                    .and_then(|v| v.as_str())
                    == Some("error")
                {
                    *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
                    *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
                    let _ = free_comfy_vram(Some(&comfy_url)).await;
                    return Err(format!(
                        "Ошибка ComfyUI (raw messages): {}",
                        comfy_status_messages_dump(entry)
                    ));
                }
            }
        }

        if progress_step < total_steps { progress_step += 1; }
        let percent = ((progress_step as f64 / total_steps as f64) * 92.0 + 3.0).min(95.0);
        window.emit("sd-progress", serde_json::json!({ "percent": percent, "step": progress_step.min(total_steps), "totalSteps": total_steps })).ok();
        sleep(Duration::from_millis(450)).await;
    }
}

pub(crate) async fn free_comfy_vram(comfy_url: Option<&str>) -> Result<(), String> {
    let base_url = comfy_base_url(comfy_url);
    let _ = reqwest::Client::new()
        .post(format!("{}/free", base_url))
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    Ok(())
}

pub(crate) async fn cancel_stable_diffusion() -> Result<(), String> {
    let prompt_id = SD_ACTIVE_PROMPT_ID.lock().unwrap().clone();
    let comfy_url = SD_ACTIVE_COMFY_URL.lock().unwrap().clone().unwrap_or_else(|| comfy_base_url(None));
    if prompt_id.is_some() {
        let _ = reqwest::Client::new().post(format!("{}/interrupt", comfy_url.clone())).send().await;
    }
    *SD_ACTIVE_PROMPT_ID.lock().unwrap() = None;
    *SD_ACTIVE_COMFY_URL.lock().unwrap() = None;
    
    let _ = free_comfy_vram(Some(&comfy_url)).await;
    Ok(())
}

pub(crate) async fn install_animatediff_nodes(_app: tauri::AppHandle, comfy_dir: String) -> Result<String, String> {
    let mut comfy_dir = normalize_fs_input(&comfy_dir);
    if comfy_dir.is_empty() {
        if let Some((detected_dir, _)) = detect_comfy_paths() { comfy_dir = detected_dir; }
        else { return Err("Укажите папку ComfyUI (где находится main.py) в настройках".to_string()); }
    }
    let comfy_path = PathBuf::from(&comfy_dir);
    if !comfy_path.join("main.py").exists() {
        return Err(format!("main.py не найден: {}", comfy_path.join("main.py").to_string_lossy()));
    }
    let custom_nodes = comfy_path.join("custom_nodes");
    std::fs::create_dir_all(&custom_nodes).map_err(|e| e.to_string())?;
    let target = custom_nodes.join("comfyui-animatediff");
    if target.exists() && (target.join(".git").exists() || target.join("nodes.py").exists()) {
        return Ok(format!("AnimateDiff уже установлен: {}", target.to_string_lossy()));
    }
    let status = new_cmd("git")
        .args(["clone", "--depth", "1", "https://github.com/ArtVentureX/comfyui-animatediff", target.to_string_lossy().as_ref()])
        .output().map_err(|e| format!("git не найден: {}", e))?;
    if !status.status.success() {
        return Err(crate::utils::process::command_error("git clone comfyui-animatediff завершился с ошибкой", &status));
    }
    Ok(format!("AnimateDiff установлен: {}. Перезапустите ComfyUI.", target.to_string_lossy()))
}

pub(crate) async fn list_recommended_models() -> Result<Vec<RecommendedModel>, String> {
    Ok(recommended_models())
}

// ─── Upscale ─────────────────────────────────────────────────────────────────

pub(crate) async fn upscale_image(app: tauri::AppHandle, args: ImageUpscaleArgs) -> Result<serde_json::Value, String> {
    if args.input_image.trim().is_empty() { return Err("Нет изображения для Upscale".to_string()); }
    let input_bytes = decode_base64_image_data(&args.input_image)?;
    let img = image::load_from_memory(&input_bytes).map_err(|e| format!("Не удалось прочитать изображение: {}", e))?;
    let scale = args.scale.unwrap_or(1.5).clamp(1.1, 4.0);
    let dst_w = ((img.width() as f64) * scale).round().clamp(1.0, 8192.0) as u32;
    let dst_h = ((img.height() as f64) * scale).round().clamp(1.0, 8192.0) as u32;
    let filter = match args.method.as_deref().unwrap_or("bicubic") {
        "nearest-exact" => image::imageops::FilterType::Nearest,
        "bilinear" => image::imageops::FilterType::Triangle,
        "area" => image::imageops::FilterType::Gaussian,
        "bislerp" => image::imageops::FilterType::Lanczos3,
        _ => image::imageops::FilterType::CatmullRom,
    };
    let resized = img.resize(dst_w, dst_h, filter);
    let mut out = std::io::Cursor::new(Vec::<u8>::new());
    resized.write_to(&mut out, image::ImageOutputFormat::Png)
        .map_err(|e| format!("Не удалось закодировать Upscale PNG: {}", e))?;
    let bytes = out.into_inner();
    let saved_path = save_sd_result_bytes(&app, &bytes, args.output_dir.as_deref(), args.comfy_dir.as_deref())?;
    Ok(serde_json::json!({ "image": base64_encode(&bytes), "savedPath": saved_path, "width": dst_w, "height": dst_h }))
}

// ─── Внутренний хелпер для парсинга ошибок ComfyUI ──────────────────────────

fn comfy_extract_error(entry: &serde_json::Value) -> Option<String> {
    let mut details: Vec<String> = Vec::new();
    if let Some(messages) = entry.get("status").and_then(|v| v.get("messages")).and_then(|v| v.as_array()) {
        for msg in messages {
            let event = msg.get(0).and_then(|v| v.as_str()).unwrap_or_default();
            let payload = msg.get(1).unwrap_or(&serde_json::Value::Null);
            let exception = payload
                .get("exception_message")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let node_id = payload
                .get("node_id")
                .map(|v| v.to_string())
                .unwrap_or_default();
            if event.contains("error") || event.contains("exception") {
                if !exception.is_empty() {
                    details.push(format!("{}: {}", event, exception));
                } else if !node_id.is_empty() {
                    details.push(format!("{} (node_id={})", event, node_id));
                } else {
                    details.push(event.to_string());
                }
            }
        }
    }
    if details.is_empty() { None } else { Some(details.join(" | ")) }
}

fn comfy_entry_finished(entry: &serde_json::Value) -> bool {
    let Some(status) = entry.get("status") else { return false };
    if status.get("completed").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    if let Some(status_str) = status.get("status_str").and_then(|v| v.as_str()) {
        return matches!(status_str, "success" | "error");
    }
    false
}

fn comfy_find_image_descriptor(value: &serde_json::Value) -> Option<(String, String, String)> {
    match value {
        serde_json::Value::Object(map) => {
            let filename = map
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if !filename.is_empty() {
                let subfolder = map
                    .get("subfolder")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let img_type = map
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("output")
                    .to_string();
                return Some((filename, subfolder, img_type));
            }
            for child in map.values() {
                if let Some(found) = comfy_find_image_descriptor(child) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                if let Some(found) = comfy_find_image_descriptor(item) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn comfy_status_summary(entry: &serde_json::Value) -> String {
    let status_str = entry
        .get("status")
        .and_then(|v| v.get("status_str"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let completed = entry
        .get("status")
        .and_then(|v| v.get("completed"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let msg_count = entry
        .get("status")
        .and_then(|v| v.get("messages"))
        .and_then(|v| v.as_array())
        .map(|v| v.len())
        .unwrap_or(0);
    format!("status={}, completed={}, messages={}", status_str, completed, msg_count)
}

fn comfy_status_messages_dump(entry: &serde_json::Value) -> String {
    let Some(messages) = entry
        .get("status")
        .and_then(|v| v.get("messages"))
        .and_then(|v| v.as_array()) else {
        return "[]".to_string();
    };
    let parts: Vec<String> = messages
        .iter()
        .map(|m| {
            let event = m.get(0).and_then(|v| v.as_str()).unwrap_or("unknown_event");
            let payload = m.get(1).cloned().unwrap_or(serde_json::Value::Null);
            format!("{}: {}", event, payload)
        })
        .collect();
    format!("[{}]", parts.join(" | "))
}
