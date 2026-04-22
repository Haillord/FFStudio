use tauri::Emitter;
use tauri::Manager;
use tokio::time::{sleep, Duration};

use crate::comfy_impl::comfy_base_url;
use crate::models::{AnimateDiffVideoArgs, ComfyUploadResponse, VideoGenerateResult};

// ─── ComfyUI upload helpers ───────────────────────────────────────────────────

pub(crate) async fn comfy_upload_image(
    client: &reqwest::Client, comfy_url: &str, file_path: &str,
) -> Result<ComfyUploadResponse, String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("Не удалось прочитать файл: {}", e))?;
    let filename = std::path::Path::new(file_path)
        .file_name().and_then(|v| v.to_str()).unwrap_or("input.png").to_string();

    let mut last_err = None;
    for ep in ["/upload/image", "/api/upload/image"] {
        let part = reqwest::multipart::Part::bytes(bytes.clone()).file_name(filename.clone());
        let form = reqwest::multipart::Form::new().part("image", part).text("type", "input");
        let resp = match client.post(format!("{}{}", comfy_url, ep)).multipart(form).send().await {
            Ok(r) => r,
            Err(e) => { last_err = Some(format!("upload {}: {}", ep, e)); continue; }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            last_err = Some(format!("upload {}: HTTP {} {}", ep, status, body));
            continue;
        }
        let parsed: ComfyUploadResponse = resp.json().await.map_err(|e| e.to_string())?;
        if parsed.name.trim().is_empty() {
            last_err = Some(format!("upload {}: пустое имя файла в ответе", ep)); continue;
        }
        return Ok(parsed);
    }
    Err(last_err.unwrap_or_else(|| "Не удалось загрузить изображение в ComfyUI".to_string()))
}

pub(crate) fn comfy_join_subfolder(subfolder: Option<&str>, name: &str) -> String {
    let sub = subfolder.unwrap_or("").trim().trim_matches('/');
    if sub.is_empty() { name.to_string() } else { format!("{}/{}", sub, name) }
}

async fn download_comfy_output_file(
    client: &reqwest::Client, comfy_url: &str, filename: &str, subfolder: &str, file_type: &str,
) -> Result<Vec<u8>, String> {
    let resp = client.get(format!("{}/view", comfy_url))
        .query(&[("filename", filename), ("subfolder", subfolder), ("type", file_type)])
        .send().await.map_err(|e| format!("Ошибка загрузки результата из ComfyUI: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("ComfyUI не отдал файл: HTTP {}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

async fn comfy_object_info(client: &reqwest::Client, comfy_url: &str) -> Result<serde_json::Value, String> {
    let resp = client.get(format!("{}/object_info", comfy_url)).send().await
        .map_err(|e| format!("ComfyUI недоступен (object_info): {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ComfyUI object_info: HTTP {} {}", status, body));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

fn require_comfy_nodes(object_info: &serde_json::Value, frames: u32) -> Result<(), String> {
    let mut missing = Vec::new();
    for node in ["AnimateDiffModuleLoader", "AnimateDiffSampler", "AnimateDiffCombine"] {
        if object_info.get(node).is_none() { missing.push(node); }
    }
    if frames > 16 && object_info.get("AnimateDiffSlidingWindowOptions").is_none() {
        missing.push("AnimateDiffSlidingWindowOptions");
    }
    if missing.is_empty() { Ok(()) } else { Err(format!("MISSING_COMFY_NODES: {}", missing.join(", "))) }
}

fn require_motion_module_available(object_info: &serde_json::Value, motion_module: &str) -> Result<(), String> {
    let loader = object_info.get("AnimateDiffModuleLoader")
        .ok_or_else(|| "MISSING_COMFY_NODES: AnimateDiffModuleLoader".to_string())?;
    let list = loader.get("input").and_then(|v| v.get("required"))
        .and_then(|v| v.get("model_name")).and_then(|v| v.get(0))
        .and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let available: Vec<String> = list.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    if available.is_empty() { return Err("MISSING_MOTION_MODULES: none".to_string()); }
    if !available.iter().any(|m| m == motion_module) {
        return Err(format!("MOTION_MODULE_NOT_FOUND: requested='{}'; available={}", motion_module, available.join(", ")));
    }
    Ok(())
}

fn filename_ext(name: &str) -> String {
    std::path::Path::new(name).extension().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

fn is_likely_ffmpeg_missing(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("ffmpeg") || lower.contains("not found") || lower.contains("no such file")
        || lower.contains("cannot find") || lower.contains("exit code") || lower.contains("ошибка")
}

// ─── AnimateDiff workflow ─────────────────────────────────────────────────────

fn animatediff_workflow(
    args: &AnimateDiffVideoArgs, output_format: &str, uploaded: Option<&ComfyUploadResponse>,
) -> Result<serde_json::Value, String> {
    use crate::sd_impl::comfy_checkpoint_name;
    let ckpt_name = comfy_checkpoint_name(&args.checkpoint)?;
    let seed = if args.seed < 0 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
    } else { args.seed };

    let use_sliding_window = args.frames > 16;
    let output_format = output_format.trim();
    if output_format.is_empty() { return Err("Пустой формат вывода".to_string()); }
    let mode = args.mode.as_deref().unwrap_or("txt2vid");
    let denoise = args.denoise.unwrap_or(0.8).clamp(0.05, 1.0);
    let use_init_image = mode == "img2vid";

    let mut prompt = serde_json::json!({
        "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt_name } },
        "2": { "class_type": "CLIPTextEncode", "inputs": { "text": args.prompt, "clip": ["1", 1] } },
        "3": { "class_type": "CLIPTextEncode", "inputs": { "text": args.negative_prompt, "clip": ["1", 1] } },
        "4": { "class_type": "EmptyLatentImage", "inputs": { "width": args.width, "height": args.height, "batch_size": 1 } },
        "5": { "class_type": "AnimateDiffModuleLoader", "inputs": { "model_name": args.motion_module } },
        "6": {
            "class_type": "AnimateDiffSampler",
            "inputs": {
                "motion_module": ["5", 0], "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
                "latent_image": ["4", 0], "inject_method": "default", "frame_number": args.frames,
                "seed": seed, "steps": args.steps, "cfg": args.cfg_scale,
                "sampler_name": "euler", "scheduler": "normal", "denoise": denoise
            }
        },
        "7": { "class_type": "VAEDecode", "inputs": { "samples": ["6", 0], "vae": ["1", 2] } },
        "8": {
            "class_type": "AnimateDiffCombine",
            "inputs": {
                "images": ["7", 0], "frame_rate": args.fps, "loop_count": 0,
                "pingpong": false, "format": output_format, "save_image": true, "filename_prefix": "ffstudio"
            }
        }
    });

    if use_init_image {
        let up = uploaded.ok_or_else(|| "Не загружено входное изображение".to_string())?;
        let image_ref = comfy_join_subfolder(up.subfolder.as_deref(), &up.name);
        if let Some(map) = prompt.as_object_mut() {
            map.insert("10".to_string(), serde_json::json!({ "class_type": "LoadImage", "inputs": { "image": image_ref } }));
            map.insert("11".to_string(), serde_json::json!({ "class_type": "VAEEncode", "inputs": { "pixels": ["10", 0], "vae": ["1", 2] } }));
            if let Some(sampler) = map.get_mut("6") {
                if let Some(inputs) = sampler.get_mut("inputs").and_then(|v| v.as_object_mut()) {
                    inputs.insert("latent_image".to_string(), serde_json::json!(["11", 0]));
                }
            }
        }
    }

    if use_sliding_window {
        if let Some(map) = prompt.as_object_mut() {
            map.insert("9".to_string(), serde_json::json!({
                "class_type": "AnimateDiffSlidingWindowOptions",
                "inputs": { "context_length": 16, "context_stride": 1, "context_overlap": 4, "schedule": "uniform", "closed_loop": true }
            }));
            if let Some(sampler) = map.get_mut("6") {
                if let Some(inputs) = sampler.get_mut("inputs").and_then(|v| v.as_object_mut()) {
                    inputs.insert("sliding_window_opts".to_string(), serde_json::json!(["9", 0]));
                }
            }
        }
    }

    Ok(prompt)
}

// ─── Основная функция генерации видео ────────────────────────────────────────

pub(crate) async fn video_generate(
    app: tauri::AppHandle, window: tauri::Window, args: serde_json::Value, comfy_api_url: Option<String>,
) -> Result<VideoGenerateResult, String> {
    let model = args.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if model != "animatediff" { return Err("VIDEO_GENERATION_NOT_IMPLEMENTED".to_string()); }

    let parsed: AnimateDiffVideoArgs = serde_json::from_value(args)
        .map_err(|e| format!("Некорректные параметры: {}", e))?;
    if parsed.prompt.trim().is_empty() { return Err("Пустой prompt".to_string()); }
    if parsed.checkpoint.trim().is_empty() { return Err("Модель не выбрана".to_string()); }

    let comfy_url = comfy_base_url(comfy_api_url.as_deref());
    let client = reqwest::Client::new();
    let client_id = format!("ffstudio-{}", std::process::id());
    let preferred_format = parsed.output_format.as_deref().unwrap_or("video/h264-mp4").trim().to_string();
    let mode = parsed.mode.clone().unwrap_or_else(|| "txt2vid".to_string());

    let info = comfy_object_info(&client, &comfy_url).await?;
    require_comfy_nodes(&info, parsed.frames)?;
    require_motion_module_available(&info, &parsed.motion_module)?;

    let uploaded = if mode == "img2vid" {
        let input = parsed.input_image.as_deref().unwrap_or("").trim().to_string();
        if input.is_empty() { return Err("Не выбрана входная картинка".to_string()); }
        Some(comfy_upload_image(&client, &comfy_url, &input).await?)
    } else { None };

    async fn attempt(
        app: &tauri::AppHandle, window: &tauri::Window, client: &reqwest::Client,
        comfy_url: &str, client_id: &str, args: &AnimateDiffVideoArgs,
        output_format: &str, uploaded: Option<&ComfyUploadResponse>,
    ) -> Result<VideoGenerateResult, String> {
        let workflow = animatediff_workflow(args, output_format, uploaded)?;
        window.emit("sd-progress", serde_json::json!({ "percent": 2.0, "step": 0, "totalSteps": args.steps.max(1) })).ok();

        let queue_resp = client.post(format!("{}/prompt", comfy_url))
            .json(&serde_json::json!({ "prompt": workflow, "client_id": client_id }))
            .send().await
            .map_err(|e| format!("ComfyUI недоступен: {}. Запустите ComfyUI на 127.0.0.1:8188 или укажите API URL.", e))?;
        if !queue_resp.status().is_success() {
            let status = queue_resp.status();
            let body = queue_resp.text().await.unwrap_or_default();
            return Err(format!("ComfyUI вернул ошибку постановки в очередь: HTTP {}. {}", status, body));
        }

        let queue_json: serde_json::Value = queue_resp.json().await.map_err(|e| e.to_string())?;
        let prompt_id = queue_json["prompt_id"].as_str()
            .ok_or_else(|| "ComfyUI не вернул prompt_id".to_string())?.to_string();

        let total_steps = args.steps.max(1);
        let mut progress_step = 0u32;
        loop {
            let history_resp = client.get(format!("{}/history/{}", comfy_url, prompt_id))
                .send().await.map_err(|e| format!("Ошибка запроса истории ComfyUI: {}", e))?;
            if history_resp.status().is_success() {
                let history: serde_json::Value = history_resp.json().await.map_err(|e| e.to_string())?;
                if let Some(entry) = history.get(&prompt_id) {
                    if let Some(outputs) = entry.get("outputs").and_then(|v| v.as_object()) {
                        let mut best: Option<(String, String, String)> = None;
                        'outer: for node_out in outputs.values() {
                            for key in ["gifs", "videos", "images"] {
                                if let Some(arr) = node_out.get(key).and_then(|v| v.as_array()) {
                                    if let Some(first) = arr.first() {
                                        let filename = first.get("filename").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        if filename.is_empty() { continue; }
                                        let subfolder = first.get("subfolder").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let ftype = first.get("type").and_then(|v| v.as_str()).unwrap_or("output").to_string();
                                        best = Some((filename, subfolder, ftype));
                                        break 'outer;
                                    }
                                }
                            }
                        }
                        if let Some((filename, subfolder, ftype)) = best {
                            let bytes = download_comfy_output_file(client, comfy_url, &filename, &subfolder, &ftype).await?;
                            let ext = { let e = filename_ext(&filename); if e.is_empty() {
                                if output_format.contains("gif") { "gif" } else if output_format.contains("webp") { "webp" } else { "mp4" }.to_string()
                            } else { e } };
                            let downloads = app.path().download_dir().map_err(|e| format!("Не удалось найти папку загрузок: {}", e))?;
                            std::fs::create_dir_all(&downloads).ok();
                            let out_path = downloads.join(format!("ffstudio_animatediff_{}.{}", chrono::Local::now().format("%Y%m%d_%H%M%S"), ext));
                            std::fs::write(&out_path, bytes).map_err(|e| format!("Не удалось сохранить результат: {}", e))?;
                            window.emit("sd-progress", serde_json::json!({ "percent": 100.0, "step": total_steps, "totalSteps": total_steps })).ok();
                            return Ok(VideoGenerateResult { output_path: out_path.to_string_lossy().to_string() });
                        }
                        return Err("ComfyUI завершил задачу, но не вернул файл (video/gif)".to_string());
                    }
                    if let Some(err_msg) = entry.get("status").and_then(|s| s.get("messages")).and_then(|m| m.as_array())
                        .and_then(|arr| arr.iter().find_map(|msg| {
                            let event = msg.get(0)?.as_str()?;
                            let text = msg.get(1)?.get("exception_message")?.as_str()?;
                            if event.contains("execution_error") { Some(text.to_string()) } else { None }
                        }))
                    {
                        return Err(format!("Ошибка ComfyUI: {}", err_msg));
                    }
                }
            }
            if progress_step < total_steps { progress_step += 1; }
            let percent = ((progress_step as f64 / total_steps as f64) * 92.0 + 3.0).min(95.0);
            window.emit("sd-progress", serde_json::json!({ "percent": percent, "step": progress_step.min(total_steps), "totalSteps": total_steps })).ok();
            sleep(Duration::from_millis(650)).await;
        }
    }

    let preferred = preferred_format.as_str();
    if !preferred.starts_with("video/") {
        return attempt(&app, &window, &client, &comfy_url, &client_id, &parsed, preferred, uploaded.as_ref()).await;
    }

    match attempt(&app, &window, &client, &comfy_url, &client_id, &parsed, preferred, uploaded.as_ref()).await {
        Ok(ok) => Ok(ok),
        Err(e1) => {
            if !is_likely_ffmpeg_missing(&e1) { return Err(e1); }
            match attempt(&app, &window, &client, &comfy_url, &client_id, &parsed, "image/webp", uploaded.as_ref()).await {
                Ok(ok) => Ok(ok),
                Err(e2) => {
                    match attempt(&app, &window, &client, &comfy_url, &client_id, &parsed, "image/gif", uploaded.as_ref()).await {
                        Ok(ok) => Ok(ok),
                        Err(e3) => Err(format!("{}\n(авто‑fallback mp4→webp→gif не помог)\n{}\n{}", e1, e2, e3)),
                    }
                }
            }
        }
    }
}
