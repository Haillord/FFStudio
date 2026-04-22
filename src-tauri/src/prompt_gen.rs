// src-tauri/src/prompt_gen.rs
//
// Генератор промптов для SD 1.5 / SDXL / FLUX на основе llama.cpp + Qwen2.5-3B-Instruct
// Использует llama-server (HTTP API) вместо llama-cli — чистый JSON, без парсинга stdout

use std::path::PathBuf;
use std::time::Duration;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tauri::{Manager, Emitter};
use crate::utils::process::new_cmd;

// ─── URLs ────────────────────────────────────────────────────────────────────

const QWEN_MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf";
const QWEN_MODEL_FILENAME: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";

const LLAMA_RELEASES_API: &str =
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";

const LLAMA_FALLBACK_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b5046/llama-b5046-bin-win-avx2-x64.zip";

// Порт для llama-server
const LLAMA_SERVER_PORT: u16 = 18642;

// ─── Структуры событий ───────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PromptGenProgressEvent {
    pub stage: String,
    pub percent: f64,
    pub done: bool,
    pub error: Option<String>,
    pub message: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PromptGenStatus {
    pub llama_installed: bool,
    pub model_installed: bool,
    pub ready: bool,
    pub model_path: String,
}

// ─── Пути ────────────────────────────────────────────────────────────────────

fn prompt_gen_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не удалось получить app data dir: {}", e))?;
    Ok(app_data.join("prompt_gen"))
}

fn find_llama_server(dir: &PathBuf) -> Option<PathBuf> {
    let direct = dir.join("llama-server.exe");
    if direct.exists() {
        return Some(direct);
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let nested = path.join("llama-server.exe");
                if nested.exists() {
                    return Some(nested);
                }
            }
        }
    }
    None
}

fn get_llama_server_path(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let dir = prompt_gen_dir(app)?;
    Ok(find_llama_server(&dir))
}

fn get_model_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = prompt_gen_dir(app)?;
    Ok(dir.join(QWEN_MODEL_FILENAME))
}

// ─── Публичные команды ───────────────────────────────────────────────────────

pub(crate) async fn get_prompt_gen_status(app: tauri::AppHandle) -> Result<PromptGenStatus, String> {
    let server_path = get_llama_server_path(&app)?;
    let model = get_model_path(&app)?;

    let llama_installed = server_path.is_some();
    let model_installed = model.exists();

    Ok(PromptGenStatus {
        llama_installed,
        model_installed,
        ready: llama_installed && model_installed,
        model_path: model.to_string_lossy().to_string(),
    })
}

pub(crate) async fn install_prompt_gen(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<PromptGenStatus, String> {
    let dir = prompt_gen_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку: {}", e))?;

    // Клиент без глобального таймаута — таймауты задаём на уровне запросов
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0")
        .build()
        .map_err(|e| e.to_string())?;

    // ─── 1. llama.cpp binary ─────────────────────────────────────────────────
    if find_llama_server(&dir).is_none() {
        emit_prog(&window, "llama_cpp", 0.0, false, None, "Получение ссылки на llama.cpp...");

        let llama_url = fetch_llama_release_url(&client).await
            .unwrap_or_else(|_| LLAMA_FALLBACK_URL.to_string());

        emit_prog(&window, "llama_cpp", 2.0, false, None, "Скачивание llama.cpp (~5MB)...");

        let zip_path = dir.join("llama-cpp.zip");
        download_with_progress(
            &client, &llama_url, &zip_path,
            &window, "llama_cpp", 2.0, 40.0,
        ).await?;

        emit_prog(&window, "llama_cpp", 42.0, false, None, "Распаковка llama.cpp...");

        let status = new_cmd("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-Command",
                &format!(
                    "Expand-Archive -Force -Path '{}' -DestinationPath '{}'",
                    zip_path.to_string_lossy(),
                    dir.to_string_lossy()
                ),
            ])
            .status()
            .map_err(|e| format!("Ошибка распаковки: {}", e))?;

        if !status.success() {
            return Err("Распаковка llama.cpp завершилась с ошибкой".to_string());
        }

        let _ = std::fs::remove_file(&zip_path);

        if find_llama_server(&dir).is_none() {
            return Err("llama-server.exe не найден после распаковки".to_string());
        }

        emit_prog(&window, "llama_cpp", 50.0, false, None, "✓ llama.cpp установлен");
    } else {
        emit_prog(&window, "llama_cpp", 50.0, false, None, "✓ llama.cpp уже установлен");
    }

    // ─── 2. GGUF модель ──────────────────────────────────────────────────────
    let model = get_model_path(&app)?;
    if !model.exists() {
        emit_prog(&window, "model", 50.0, false, None, "Скачивание модели Qwen2.5-3B (~1.9GB)...");

        let temp_path = model.with_extension("gguf.part");
        download_with_progress(
            &client, QWEN_MODEL_URL, &temp_path,
            &window, "model", 50.0, 99.0,
        ).await?;

        std::fs::rename(&temp_path, &model)
            .map_err(|e| format!("Не удалось сохранить модель: {}", e))?;
    }

    emit_prog(&window, "done", 100.0, true, None, "✓ Генератор промптов готов");
    get_prompt_gen_status(app).await
}

pub(crate) async fn generate_sd_prompt(
    app: tauri::AppHandle,
    description: String,
    style: String,
    model_type: String,
) -> Result<String, String> {
    let server_exe = get_llama_server_path(&app)?
        .ok_or("llama-server.exe не найден. Установите генератор промптов.")?;
    let model = get_model_path(&app)?;

    if !model.exists() {
        return Err("Модель не найдена. Нажмите «Установить» в панели промпта.".to_string());
    }

    let system = build_system_prompt(&model_type);
    let user_msg = build_user_message(&description, &style);

    // ─── Запускаем llama-server ───────────────────────────────────────────────
    let mut server_proc = new_cmd(&server_exe)
        .arg("-m").arg(&model)
        .arg("--port").arg(LLAMA_SERVER_PORT.to_string())
        .arg("--host").arg("127.0.0.1")
        .arg("-n").arg("768")
        .arg("-t").arg("4")
        .arg("-c").arg("4096")
        .arg("--log-disable")
        .spawn()
        .map_err(|e| format!("Не удалось запустить llama-server: {}", e))?;

    let base_url = format!("http://127.0.0.1:{}", LLAMA_SERVER_PORT);

    // Клиент без глобального таймаута — таймаут задаём на уровне запроса
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    // Ждём пока сервер поднимется (до 60 сек)
    let ready = wait_for_server(&client, &base_url, 60).await;
    if !ready {
        let _ = server_proc.kill();
        return Err("llama-server не запустился за 60 секунд".to_string());
    }

    // Делаем запрос, убиваем сервер в любом случае
    let result = call_chat_api(&client, &base_url, system, &user_msg, &model_type).await;
    let _ = server_proc.kill();

    result
}

// ─── HTTP API ────────────────────────────────────────────────────────────────

async fn wait_for_server(client: &reqwest::Client, base_url: &str, timeout_secs: u64) -> bool {
    let health_url = format!("{}/health", base_url);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

    while tokio::time::Instant::now() < deadline {
        if let Ok(resp) = client
            .get(&health_url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

async fn call_chat_api(
    client: &reqwest::Client,
    base_url: &str,
    system: &str,
    user_msg: &str,
    model_type: &str,
) -> Result<String, String> {
    let url = format!("{}/v1/chat/completions", base_url);

    let body = serde_json::json!({
        "model": "qwen",
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user_msg }
        ],
        "max_tokens": 768,
        "temperature": 0.75,
        "top_p": 0.92,
        "repeat_penalty": 1.05,
        "stream": false
    });

    let resp = client
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(120)) // теперь работает — нет глобального таймаута
        .send()
        .await
        .map_err(|e| format!("Ошибка запроса к llama-server: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("llama-server вернул HTTP {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await
        .map_err(|e| format!("Не удалось разобрать ответ: {}", e))?;

    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    if content.len() < 3 {
        return Err(format!(
            "Модель вернула слишком короткий результат. Ответ сервера: {:?}",
            json
        ));
    }

    Ok(clean_output(&content, model_type))
}

// ─── Вспомогательные функции ─────────────────────────────────────────────────

async fn fetch_llama_release_url(client: &reqwest::Client) -> Result<String, String> {
    let resp = client
        .get(LLAMA_RELEASES_API)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let assets = json["assets"].as_array().ok_or("нет assets")?;

    for asset in assets {
        let name = asset["name"].as_str().unwrap_or("");
        if name.contains("bin-win-avx2-x64") && name.ends_with(".zip") {
            let url = asset["browser_download_url"].as_str().ok_or("нет URL")?;
            return Ok(url.to_string());
        }
    }
    Err("AVX2 бинарник не найден в последнем релизе".to_string())
}

async fn download_with_progress(
    client: &reqwest::Client,
    url: &str,
    dest: &PathBuf,
    window: &tauri::Window,
    stage: &str,
    start_pct: f64,
    end_pct: f64,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(600)) // 10 мин на большие файлы
        .send()
        .await
        .map_err(|e| format!("Ошибка запроса: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), url));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest).await
        .map_err(|e| format!("Не удалось создать файл: {}", e))?;

    let range = end_pct - start_pct;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Ошибка потока: {}", e))?;
        file.write_all(&chunk).await
            .map_err(|e| format!("Ошибка записи: {}", e))?;
        downloaded += chunk.len() as u64;

        let file_pct = if total > 0 { downloaded as f64 / total as f64 } else { 0.0 };
        let overall_pct = (start_pct + file_pct * range).min(end_pct);

        let msg = if total > 0 {
            format!("{:.0}MB / {:.0}MB", downloaded as f64 / 1e6, total as f64 / 1e6)
        } else {
            format!("{:.0}MB", downloaded as f64 / 1e6)
        };

        emit_prog(window, stage, overall_pct, false, None, &msg);
    }

    file.flush().await.map_err(|e| format!("Ошибка финальной записи: {}", e))?;
    Ok(())
}

fn emit_prog(
    window: &tauri::Window,
    stage: &str,
    percent: f64,
    done: bool,
    error: Option<String>,
    message: &str,
) {
    let _ = window.emit("prompt-gen-progress", PromptGenProgressEvent {
        stage: stage.to_string(),
        percent,
        done,
        error,
        message: message.to_string(),
    });
}

fn build_system_prompt(model_type: &str) -> &'static str {
    match model_type {
        "flux" => {
            "You are an expert FLUX prompt engineer for ComfyUI. \
Convert the user description into an optimized FLUX prompt. \
Output ONLY the final prompt — no explanation, no quotes, no prefixes, no labels. \
Write in natural cinematic English: subject, scene, lighting, mood, lens, composition. \
Include quality cues: highly detailed, cinematic lighting, atmospheric, sharp focus. \
Stop immediately after the last word of the prompt. Do not add anything else."
        }
        "sdxl" => {
            "You are an expert Stable Diffusion XL prompt engineer. \
Convert the user description into an optimized SDXL prompt. \
Output ONLY the prompt — no explanation, no quotes, no prefix, no labels. \
Use comma-separated tags, NOT long sentences. \
ALWAYS start with: masterpiece, best quality, ultra detailed, \
then add subject, clothing, pose, setting, lighting, style tags. \
Include: composition, camera angle, color grading, depth of field. \
Keep it concise and tag-based. English only. \
Stop immediately after the last tag."
        }
        _ => {
            "You are an expert Stable Diffusion 1.5 prompt engineer. \
Convert the user description into an optimized SD 1.5 prompt. \
Output ONLY the prompt — no explanation, no quotes, no prefix, no labels. \
ALWAYS use short comma-separated TAGS, never long sentences. \
ALWAYS start with exactly: masterpiece, best quality, highly detailed, \
then add subject tags, body tags, setting tags, lighting tags, style tags. \
Example format: masterpiece, best quality, highly detailed, 1girl, brown hair, \
standing, forest background, dappled sunlight, sharp focus, cinematic. \
Include: subject, lighting, atmosphere, colors, composition, camera style, depth of field. \
English only. Stop immediately after the last tag."
        }
    }
}

fn build_user_message(description: &str, style: &str) -> String {
    let style_hint = match style {
        "photorealism" => "ultra photorealistic, 8k photography, DSLR, sharp focus",
        "anime"        => "anime style, cel shading, Studio Ghibli / Makoto Shinkai aesthetic",
        "fantasy"      => "epic fantasy art, magical, ethereal lighting, painterly",
        "cyberpunk"    => "cyberpunk, neon lights, dystopian city, rain, blade runner aesthetic",
        "oil_painting" => "oil painting, classical art style, fine brushwork, museum quality",
        "watercolor"   => "watercolor illustration, soft edges, flowing colors, artistic",
        "dark_fantasy" => "dark fantasy, gothic, dramatic lighting, ominous atmosphere",
        "concept_art"  => "concept art, artstation trending, professional illustration, detailed",
        "3d_render"    => "3D render, octane render, ray tracing, volumetric lighting",
        _              => "",
    };

    if style_hint.is_empty() {
        description.to_string()
    } else {
        format!("{}. Visual style: {}", description, style_hint)
    }
}

/// Очистка вывода модели от мусорных преамбул.
/// Для FLUX берём весь текст целиком (prose без запятых).
/// Для SD/SDXL ищем строку с тегами через запятую.
fn clean_output(raw: &str, model_type: &str) -> String {
    let s = raw.trim();

    // Префиксы которые любит добавлять LLM
    let junk_prefixes = [
        "Sure! ", "sure! ",
        "Here is ", "here is ",
        "Certainly! ", "certainly! ",
        "Create ", "create ",
        "Prompt: ", "prompt: ",
        "Result: ", "result: ",
        "Generated: ", "generated: ",
        "SD Prompt: ", "FLUX Prompt: ",
        "SDXL Prompt: ", "Output: ",
    ];

    // Для FLUX — prose, берём всё целиком
    if model_type == "flux" {
        let mut res = s.trim_matches('"').trim_matches('\'').trim();
        for prefix in &junk_prefixes {
            if res.starts_with(prefix) {
                res = &res[prefix.len()..];
                break;
            }
        }
        return res.trim().to_string();
    }

    // Для SD / SDXL — ищем строку с тегами (есть запятые, достаточно длинная)
    let result = s
        .lines()
        .map(|l| l.trim())
        .find(|l| {
            l.contains(',')
                && l.len() > 20
                && !l.starts_with("Sure")
                && !l.starts_with("Here")
                && !l.starts_with("Certainly")
                && !l.starts_with("Create")
                && !l.starts_with("Prompt:")
                && !l.starts_with("Result:")
                && !l.starts_with("Generated:")
                && !l.starts_with("Output:")
        })
        .unwrap_or(s);

    let mut res = result.trim_matches('"').trim_matches('\'').trim();

    for prefix in &junk_prefixes {
        if res.starts_with(prefix) {
            res = &res[prefix.len()..];
            break;
        }
    }

    res.trim().to_string()
}