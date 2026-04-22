use std::path::PathBuf;
use std::process::Stdio;
use std::fs::Metadata;
use tokio::time::{sleep, Duration};

use crate::models::{ComfyAutoSetupResult, ComfyInstallResult, ModelDownloadProgressEvent, RecommendedModel};
use crate::utils::fs_paths::normalize_fs_input;
use crate::utils::process::{command_error, new_cmd};
use crate::{append_log, COMFY_CHILD_PID};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tauri::Emitter;

// ─── URL helpers ─────────────────────────────────────────────────────────────

pub(crate) fn normalize_comfy_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() { "http://127.0.0.1:8188".to_string() } else { trimmed.to_string() }
}

// ─── Патч совместимости ComfyUI-GGUF ─────────────────────────────────────────

pub(crate) fn patch_comfy_gguf_ops(comfy_dir: &std::path::Path) {
    let ops_path = comfy_dir.join("comfy").join("ops.py");
    let Ok(content) = std::fs::read_to_string(&ops_path) else { return };

    let bad  = "if offloadable and (device != s.weight.device or";
    let good = "if offloadable and s.weight is not None and (device != s.weight.device or";

    if content.contains(bad) {
        let patched = content.replace(bad, good);
        let _ = std::fs::write(&ops_path, patched);
    }
}

pub(crate) fn comfy_base_url(custom_url: Option<&str>) -> String {
    if let Some(url) = custom_url { return normalize_comfy_url(url); }
    normalize_comfy_url(&std::env::var("COMFYUI_API_URL").unwrap_or_default())
}

// ─── Обнаружение ComfyUI ──────────────────────────────────────────────────────

pub(crate) fn detect_comfy_paths() -> Option<(String, String)> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(home) = std::env::var("USERPROFILE") {
            let home = PathBuf::from(home);
            candidates.push(home.join("Downloads").join("ComfyUI_windows_portable_nvidia").join("ComfyUI"));
            candidates.push(home.join("Desktop").join("ComfyUI_windows_portable_nvidia").join("ComfyUI"));
            candidates.push(home.join("ComfyUI_windows_portable_nvidia").join("ComfyUI"));
            candidates.push(home.join("ComfyUI").join("ComfyUI"));
            candidates.push(home.join("ComfyUI"));
        }
        for letter in b'C'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            candidates.push(root.join("ComfyUI_windows_portable_nvidia").join("ComfyUI"));
            candidates.push(root.join("ComfyUI_windows_portable").join("ComfyUI"));
            candidates.push(root.join("ComfyUI").join("ComfyUI"));
            candidates.push(root.join("ComfyUI"));
        }
        for comfy_dir in candidates {
            if !comfy_dir.join("main.py").exists() { continue; }
            let portable_root = comfy_dir.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| comfy_dir.clone());
            let embed_python = portable_root.join("python_embeded").join("python.exe");
            let comfy_python = if embed_python.exists() {
                embed_python.to_string_lossy().to_string()
            } else { "python".to_string() };
            return Some((comfy_dir.to_string_lossy().to_string(), comfy_python));
        }
    }
    None
}

fn resolve_comfy_main_dir_from_input(raw_dir: &str) -> Option<PathBuf> {
    let normalized = normalize_fs_input(raw_dir);
    if normalized.is_empty() {
        return None;
    }
    let path = PathBuf::from(normalized);
    if path.join("main.py").exists() {
        return Some(path);
    }
    let nested = path.join("ComfyUI");
    if nested.join("main.py").exists() {
        return Some(nested);
    }
    None
}

pub(crate) fn resolve_comfy_dir_or_detect(comfy_dir: &str) -> Result<PathBuf, String> {
    if let Some(path) = resolve_comfy_main_dir_from_input(comfy_dir) {
        return Ok(path);
    }
    if let Some((detected_dir, _)) = detect_comfy_paths() {
        if let Some(path) = resolve_comfy_main_dir_from_input(&detected_dir) {
            return Ok(path);
        }
    }
    Err("Не удалось определить папку ComfyUI (main.py). Укажите путь в настройках.".to_string())
}

fn find_main_py_dir(root: &std::path::Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() { stack.push(path); continue; }
            if path.file_name().and_then(|n| n.to_str()) == Some("main.py") {
                return path.parent().map(|p| p.to_path_buf());
            }
        }
    }
    None
}

// ─── Жизненный цикл ComfyUI ──────────────────────────────────────────────────

pub(crate) async fn check_comfyui(comfy_url: String) -> Result<String, String> {
    let base = comfy_base_url(Some(&comfy_url));
    let client = reqwest::Client::new();
    let resp = client.get(format!("{}/system_stats", base)).send().await
        .map_err(|e| format!("ComfyUI недоступен: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("ComfyUI ответил с HTTP {}", resp.status()));
    }
    Ok(format!("ComfyUI online ({})", base))
}

pub(crate) async fn impl_start_comfyui(comfy_url: String, comfy_dir: String, python_bin: String) -> Result<String, String> {
    let base = comfy_base_url(Some(&comfy_url));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?;

    if let Ok(resp) = client.get(format!("{}/system_stats", base)).send().await {
        if resp.status().is_success() { return Ok(format!("Уже запущен на {}", base)); }
    }

    let mut comfy_dir = normalize_fs_input(&comfy_dir);
    let mut python_bin = normalize_fs_input(&python_bin);

    if comfy_dir.is_empty() {
        if let Some((detected_dir, detected_python)) = detect_comfy_paths() {
            comfy_dir = detected_dir;
            if python_bin.is_empty() { python_bin = detected_python; }
        } else {
            return Err("Укажите папку ComfyUI в настройках (где находится main.py)".to_string());
        }
    }

    let comfy_path = resolve_comfy_main_dir_from_input(&comfy_dir)
        .ok_or_else(|| format!("main.py не найден: {} или {}/ComfyUI", comfy_dir, comfy_dir))?;

    patch_comfy_gguf_ops(&comfy_path);

    let parsed = reqwest::Url::parse(&base).map_err(|e| format!("Некорректный URL ComfyUI: {}", e))?;
    let host = parsed.host_str().unwrap_or("127.0.0.1").to_string();
    let port = parsed.port_or_known_default().unwrap_or(8188).to_string();
    let python = if python_bin.is_empty() { "python" } else { &python_bin };

    let child = new_cmd(python)
        .arg("main.py").arg("--listen").arg(&host).arg("--port").arg(&port)
        .current_dir(&comfy_path).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("Не удалось запустить ComfyUI: {}", e))?;
    *COMFY_CHILD_PID.lock().unwrap() = Some(child.id());

    for _ in 0..40u32 {
        if let Ok(resp) = client.get(format!("{}/system_stats", base)).send().await {
            if resp.status().is_success() { return Ok(format!("Запущен на {}", base)); }
        }
        sleep(Duration::from_millis(300)).await;
    }
    Err("ComfyUI запущен, но API пока не отвечает. Подождите 10-30 секунд и нажмите 'Проверить'.".to_string())
}

pub(crate) async fn impl_stop_comfyui() -> Result<String, String> {
    let pid = COMFY_CHILD_PID.lock().map_err(|_| "COMFY_CHILD_PID lock error".to_string())?.take();
    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        {
            let output = new_cmd("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output()
                .map_err(|e| format!("Не удалось остановить ComfyUI: {}", e))?;
            if !output.status.success() { return Err(command_error("taskkill ComfyUI завершился с ошибкой", &output)); }
        }
        #[cfg(not(target_os = "windows"))]
        { new_cmd("kill").arg(pid.to_string()).output().map_err(|e| format!("Не удалось остановить ComfyUI: {}", e))?; }
        Ok("ComfyUI остановлен".to_string())
    } else {
        Err("ComfyUI не был запущен из приложения (PID неизвестен). Перезапустите ComfyUI вручную.".to_string())
    }
}

pub(crate) async fn free_comfyui_memory(comfy_url: String) -> Result<String, String> {
    let base = comfy_base_url(Some(&comfy_url));
    let client = reqwest::Client::new();
    
    let resp = client.post(format!("{}/free", base))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Не удалось отправить запрос на очистку памяти: {}", e))?;
    
    if !resp.status().is_success() {
        return Err(format!("ComfyUI вернул ошибку при очистке памяти: HTTP {}", resp.status()));
    }
    
    Ok("Модели выгружены из видеопамяти".to_string())
}

pub(crate) async fn restart_comfyui(comfy_url: String, comfy_dir: String, python_bin: String) -> Result<String, String> {
    let _ = impl_stop_comfyui().await;
    impl_start_comfyui(comfy_url, comfy_dir, python_bin).await
}

pub(crate) async fn auto_setup_comfyui() -> Result<ComfyAutoSetupResult, String> {
    let comfy_api_url = "http://127.0.0.1:8188".to_string();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
    if let Ok(resp) = client.get(format!("{}/system_stats", &comfy_api_url)).send().await {
        if resp.status().is_success() {
            return Ok(ComfyAutoSetupResult {
                comfy_api_url, comfy_dir: String::new(), comfy_python: "python".to_string(),
                started: false, message: "ComfyUI уже запущен на 127.0.0.1:8188".to_string(),
            });
        }
    }
    let (comfy_dir, comfy_python) = detect_comfy_paths().ok_or_else(|| {
        "Не найден ComfyUI portable. Установите ComfyUI или укажите путь вручную в расширенных настройках.".to_string()
    })?;
    
    if let Ok(path) = std::path::Path::new(&comfy_dir).canonicalize() {
        patch_comfy_gguf_ops(&path);
    }
    
    let start_msg = impl_start_comfyui(comfy_api_url.clone(), comfy_dir.clone(), comfy_python.clone()).await?;
    Ok(ComfyAutoSetupResult { comfy_api_url, comfy_dir, comfy_python, started: true, message: start_msg })
}

pub(crate) async fn install_comfyui_portable(install_dir: String) -> Result<ComfyInstallResult, String> {
    #[cfg(not(target_os = "windows"))]
    { let _ = install_dir; return Err("Автоустановка пока поддерживается только на Windows".to_string()); }

    #[cfg(target_os = "windows")]
    {
        let target_dir = normalize_fs_input(&install_dir);
        if target_dir.is_empty() { return Err("Укажите папку установки".to_string()); }
        let target_path = PathBuf::from(&target_dir);
        std::fs::create_dir_all(&target_path).map_err(|e| format!("Не удалось создать папку: {}", e))?;

        let archive_url = "https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia_cu126.7z";
        let archive_path = target_path.join("ComfyUI_windows_portable_nvidia_cu126.7z");
        let seven_zip_path = target_path.join("7zr.exe");

        if !archive_path.exists() {
            let status = new_cmd("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                    &format!("Invoke-WebRequest -UseBasicParsing -Uri '{}' -OutFile '{}'",
                        archive_url, archive_path.to_string_lossy())])
                .status().map_err(|e| format!("Не удалось скачать ComfyUI: {}", e))?;
            if !status.success() { return Err("Скачивание ComfyUI завершилось с ошибкой".to_string()); }
        }
        if !seven_zip_path.exists() {
            let status = new_cmd("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                    &format!("Invoke-WebRequest -UseBasicParsing -Uri 'https://www.7-zip.org/a/7zr.exe' -OutFile '{}'",
                        seven_zip_path.to_string_lossy())])
                .status().map_err(|e| format!("Не удалось скачать распаковщик 7zr: {}", e))?;
            if !status.success() { return Err("Скачивание 7zr.exe завершилось с ошибкой".to_string()); }
        }
        let status = new_cmd(&seven_zip_path)
            .arg("x").arg(archive_path.to_string_lossy().to_string())
            .arg(format!("-o{}", target_path.to_string_lossy())).arg("-y")
            .status().map_err(|e| format!("Ошибка распаковки архива: {}", e))?;
        if !status.success() { return Err("Распаковка ComfyUI завершилась с ошибкой".to_string()); }

        let comfy_dir_path = find_main_py_dir(&target_path)
            .ok_or_else(|| "Не удалось найти main.py после распаковки".to_string())?;
        let comfy_dir = comfy_dir_path.to_string_lossy().to_string();
        let portable_root = comfy_dir_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| comfy_dir_path.clone());
        let embed_python = portable_root.join("python_embeded").join("python.exe");
        let comfy_python = if embed_python.exists() {
            embed_python.to_string_lossy().to_string()
        } else { "python".to_string() };

        let comfy_api_url = "http://127.0.0.1:8188".to_string();
        let start_msg = impl_start_comfyui(comfy_api_url.clone(), comfy_dir.clone(), comfy_python.clone()).await?;
        Ok(ComfyInstallResult { comfy_api_url, comfy_dir, comfy_python, message: format!("Установка завершена. {}", start_msg) })
    }
}

// ─── Рекомендованные модели ───────────────────────────────────────────────────

pub(crate) fn recommended_models() -> Vec<RecommendedModel> {
    vec![
        RecommendedModel {
            id: "ad_mm_sd_v15_v2".to_string(),
            name: "AnimateDiff Motion Module v2 (SD1.5)".to_string(),
            kind: "motion".to_string(),
            size_bytes: 1_700_000_000,
            url: "https://huggingface.co/guoyww/animatediff/resolve/main/mm_sd_v15_v2.ckpt?download=true".to_string(),
            filename: "mm_sd_v15_v2.ckpt".to_string(),
            target_subdir: "custom_nodes/comfyui-animatediff/models".to_string(),
            note: "Сбалансированный вариант для AnimateDiff + SD1.5".to_string(),
        },
        RecommendedModel {
            id: "ad_v3_sd15_mm".to_string(),
            name: "AnimateDiff Motion Module v3 (SD1.5)".to_string(),
            kind: "motion".to_string(),
            size_bytes: 1_700_000_000,
            url: "https://huggingface.co/guoyww/animatediff/resolve/main/v3_sd15_mm.ckpt?download=true".to_string(),
            filename: "v3_sd15_mm.ckpt".to_string(),
            target_subdir: "custom_nodes/comfyui-animatediff/models".to_string(),
            note: "Более выраженное движение для SD1.5".to_string(),
        },
        RecommendedModel {
            id: "sd15_base_checkpoint".to_string(),
            name: "Stable Diffusion v1.5 (base checkpoint)".to_string(),
            kind: "checkpoint".to_string(),
            size_bytes: 4_300_000_000,
            url: "https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors?download=true".to_string(),
            filename: "v1-5-pruned-emaonly.safetensors".to_string(),
            target_subdir: "models/checkpoints".to_string(),
            note: "Базовый checkpoint SD1.5 для AnimateDiff".to_string(),
        },
    ]
}

pub(crate) async fn install_recommended_model(
    app: tauri::AppHandle, window: tauri::Window, model_id: String, comfy_dir: String,
) -> Result<String, String> {
    let model = recommended_models().into_iter().find(|m| m.id == model_id)
        .ok_or_else(|| format!("Неизвестная модель: {}", model_id))?;

    let comfy_root = resolve_comfy_dir_or_detect(&comfy_dir)?;
    let target_dir = comfy_root.join(model.target_subdir.replace('/', "\\"));
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let final_path = target_dir.join(&model.filename);
    let temp_path = target_dir.join(format!("{}.part", &model.filename));

    if final_path.exists() {
        window.emit("model-download-progress", ModelDownloadProgressEvent {
            model_id: model.id.clone(), percent: 100.0, downloaded: 0, total: 0,
            done: true, error: None, message: format!("Модель уже установлена: {}", final_path.to_string_lossy()),
        }).ok();
        return Ok(final_path.to_string_lossy().to_string());
    }

    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let resp = client.get(&model.url).send().await
        .map_err(|e| format!("Ошибка загрузки {}: {}", model.name, e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ошибка загрузки {}: HTTP {} {}", model.name, status, body));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(&temp_path).await.map_err(|e| format!("Не удалось создать файл: {}", e))?;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Ошибка потока загрузки: {}", e))?;
        file.write_all(&chunk).await.map_err(|e| format!("Ошибка записи файла: {}", e))?;
        downloaded += chunk.len() as u64;
        let percent = if total > 0 { (downloaded as f64 / total as f64 * 100.0).min(100.0) } else { 0.0 };
        window.emit("model-download-progress", ModelDownloadProgressEvent {
            model_id: model.id.clone(), percent, downloaded, total, done: false, error: None,
            message: format!("Скачивание {}...", model.name),
        }).ok();
    }

    file.flush().await.map_err(|e| format!("Ошибка записи: {}", e))?;
    drop(file);
    std::fs::rename(&temp_path, &final_path).map_err(|e| format!("Не удалось сохранить модель: {}", e))?;

    window.emit("model-download-progress", ModelDownloadProgressEvent {
        model_id: model.id.clone(), percent: 100.0, downloaded, total, done: true, error: None,
        message: format!("Готово: {}", final_path.to_string_lossy()),
    }).ok();
    append_log(&app, "INFO", "model_installed", &format!("id={} path={}", model.id, final_path.to_string_lossy()));
    Ok(final_path.to_string_lossy().to_string())
}

// ─── Галерея вывода ───────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct GalleryItem {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub created_ts: i64,
    pub modified_ts: i64,
}

pub(crate) async fn get_gallery_files(outputDir: String) -> Result<Vec<GalleryItem>, String> {
    let mut dir = normalize_fs_input(&outputDir);
    
    // Если папка вывода не указана - используем стандартную папку output внутри ComfyUI
    if dir.is_empty() {
        if let Some((comfy_dir, _)) = detect_comfy_paths() {
            let default_output = PathBuf::from(&comfy_dir).join("output");
            if default_output.exists() && default_output.is_dir() {
                dir = default_output.to_string_lossy().to_string();
            }
        }
    }
    
    if dir.is_empty() {
        return Ok(Vec::new());
    }
    
    let path = PathBuf::from(&dir);
    if !path.exists() || !path.is_dir() {
        return Ok(Vec::new());
    }
    
    let mut files = Vec::new();
    
    let entries = std::fs::read_dir(path)
        .map_err(|e| format!("Не удалось прочитать папку вывода: {}", e))?;
    
    for entry in entries.flatten() {
        let entry_path = entry.path();
        
        if entry_path.is_file() {
            if let Some(ext) = entry_path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if ext_lower == "png" || ext_lower == "jpg" || ext_lower == "jpeg" || ext_lower == "webp" {
                    
                    let meta: Metadata = entry.metadata()
                        .map_err(|e| format!("Не удалось получить метаданные файла: {}", e))?;
                    
                    let created = meta.created()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or_default();
                    
                    let modified = meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or_default();
                    
                    files.push(GalleryItem {
                        path: entry_path.to_string_lossy().to_string(),
                        filename: entry_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                        size_bytes: meta.len(),
                        created_ts: created,
                        modified_ts: modified,
                    });
                }
            }
        }
    }
    
    // Сортировка по дате модификации, новейшие сверху
    files.sort_by(|a, b| b.modified_ts.cmp(&a.modified_ts));
    
    Ok(files)
}
