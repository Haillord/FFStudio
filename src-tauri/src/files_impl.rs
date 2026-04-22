use std::path::PathBuf;

use crate::utils::encoding::{base64_encode, decode_base64_image_data};
use crate::{append_log, app_log_path, register_temp_file};

pub(crate) async fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

pub(crate) async fn next_available_path(path: String) -> Result<String, String> {
    let candidate = PathBuf::from(path.trim());
    if candidate.as_os_str().is_empty() { return Err("Пустой путь".to_string()); }
    if !candidate.exists() { return Ok(candidate.to_string_lossy().to_string()); }

    let parent = candidate.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let stem = candidate.file_stem().and_then(|s| s.to_str()).unwrap_or("output").to_string();
    let ext = candidate.extension().and_then(|s| s.to_str())
        .map(|s| format!(".{}", s)).unwrap_or_default();

    for idx in 1..=9999u32 {
        let next = parent.join(format!("{}_{:03}{}", stem, idx, ext));
        if !next.exists() { return Ok(next.to_string_lossy().to_string()); }
    }
    Err("Не удалось подобрать свободное имя файла".to_string())
}

pub(crate) fn next_available_path_sync(path: &PathBuf) -> Result<PathBuf, String> {
    if !path.exists() { return Ok(path.clone()); }
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output").to_string();
    let ext = path.extension().and_then(|s| s.to_str())
        .map(|s| format!(".{}", s)).unwrap_or_default();
    for idx in 1..=9999u32 {
        let next = parent.join(format!("{}_{:03}{}", stem, idx, ext));
        if !next.exists() { return Ok(next); }
    }
    Err("Не удалось подобрать свободное имя файла".to_string())
}

pub(crate) async fn open_in_explorer(path: String) -> Result<(), String> {
    use crate::utils::process::new_cmd;
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(format!("/select,{}", path)).spawn().ok();
    #[cfg(target_os = "macos")]
    new_cmd("open").arg("-R").arg(&path).spawn().ok();
    #[cfg(target_os = "linux")]
    {
        let dir = std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("."));
        new_cmd("xdg-open").arg(dir).spawn().ok();
    }
    Ok(())
}

pub(crate) async fn write_temp_list(contents: String) -> Result<String, String> {
    let tmp = std::env::temp_dir().join("ffstudio_merge_list.txt");
    std::fs::write(&tmp, &contents).map_err(|e| e.to_string())?;
    register_temp_file(tmp.clone());
    Ok(tmp.to_string_lossy().to_string())
}

pub(crate) async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64_encode(&bytes))
}

pub(crate) async fn save_base64_image(data: String, path: String) -> Result<(), String> {
    let bytes = decode_base64_image_data(&data)?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn export_logs(app: tauri::AppHandle, destination: String) -> Result<String, String> {
    let src = app_log_path(&app)?;
    if !src.exists() { return Err("Лог-файл пока не создан".to_string()); }
    if destination.trim().is_empty() { return Err("Не указан путь для экспорта логов".to_string()); }
    let dst = PathBuf::from(destination);
    if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    append_log(&app, "INFO", "logs_exported", &format!("to={}", dst.to_string_lossy()));
    Ok(dst.to_string_lossy().to_string())
}
