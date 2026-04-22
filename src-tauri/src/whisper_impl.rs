use std::path::PathBuf;
use std::process::Stdio;
use tauri::{Emitter, Manager};

use crate::ffmpeg_impl::resolve_ffmpeg;
use crate::utils::process::{command_error, new_cmd};
use crate::{WHISPER_PID};

// ─── Утилиты ─────────────────────────────────────────────────────────────────

pub(crate) fn find_python() -> Result<String, String> {
    for candidate in &["python", "python3", "py"] {
        if new_cmd(candidate).arg("--version").output().is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("Python не найден. Установите Python 3.10+".to_string())
}

fn is_cuda_available() -> bool {
    new_cmd("nvidia-smi").output().is_ok()
}

// ─── Whisper ─────────────────────────────────────────────────────────────────

fn whisper_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?.join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn emit_whisper_progress(window: &tauri::Window, percent: f64, message: impl Into<String>) {
    let message = message.into();
    window.emit("whisper-progress", serde_json::json!({
        "percent": percent,
        "message": message
    })).ok();
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub(crate) struct WhisperResult {
    pub text: String,
    pub srt_path: String,
    pub segments: Vec<serde_json::Value>,
}

// ─── Публичные методы ────────────────────────────────────────────────────────

pub(crate) async fn check_whisper(app: tauri::AppHandle) -> Result<String, String> {
    let python = find_python()?;
    
    let check = new_cmd(&python)
        .args(["-c", "import faster_whisper; print('OK')"])
        .output()
        .map_err(|e| format!("Ошибка проверки faster-whisper: {}", e))?;
    
    if check.status.success() {
        Ok("Faster Whisper готов к работе".to_string())
    } else {
        Err("faster-whisper не установлен".to_string())
    }
}

pub(crate) async fn install_whisper(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let python = find_python()?;
    
    emit_whisper_progress(&window, 10.0, "Установка faster-whisper...");
    
    let mut pip_args = vec!["-m", "pip", "install", "--upgrade", "faster-whisper"];
    
    if is_cuda_available() {
        emit_whisper_progress(&window, 20.0, "Обнаружена CUDA, устанавливаем версию с поддержкой GPU");
        pip_args.extend_from_slice(&["--extra-index-url", "https://download.pytorch.org/whl/cu121"]);
    } else {
        emit_whisper_progress(&window, 20.0, "Устанавливаем CPU версию");
    }
    
    let install = new_cmd(&python)
        .args(&pip_args)
        .output()
        .map_err(|e| format!("Ошибка pip install: {}", e))?;
    
    if !install.status.success() {
        return Err(command_error("Не удалось установить faster-whisper", &install));
    }
    
    emit_whisper_progress(&window, 100.0, "Установка Whisper завершена");
    Ok(())
}

pub(crate) async fn run_whisper(
    app: tauri::AppHandle, window: tauri::Window,
    input: String, model: String, language: String, job_id: String, output_path: Option<String>,
) -> Result<WhisperResult, String> {
    let python = find_python()?;
    let work_dir = whisper_dir(&app)?;
    
    emit_whisper_progress(&window, 5.0, "Загрузка модели и запуск транскрибации...");
    
    let srt_output = if let Some(path) = output_path {
        std::path::PathBuf::from(path)
    } else {
        work_dir.join(format!("{}.srt", job_id))
    };
    
    let script = format!(r#"
from faster_whisper import WhisperModel
import json
import sys

model = WhisperModel("{}", device="{}", compute_type="int8")
segments, info = model.transcribe("{}", language="{}" if "{}" != "auto" else None, vad_filter=True)

result = []
full_text = ""

for segment in segments:
    full_text += segment.text
    result.append({{
        "start": segment.start,
        "end": segment.end,
        "text": segment.text,
        "words": [w.word for w in segment.words] if segment.words else []
    }})

with open(r"{}", "w", encoding="utf-8") as f:
    for i, seg in enumerate(result):
        start = int(seg["start"])
        end = int(seg["end"])
        f.write(f"{{i+1}}\\n")
        f.write(f"{{start//3600:02d}}:{{(start%3600)//60:02d}}:{{start%60:02d}},{{int((seg['start']%1)*1000):03d}} --> ")
        f.write(f"{{end//3600:02d}}:{{(end%3600)//60:02d}}:{{end%60:02d}},{{int((seg['end']%1)*1000):03d}}\\n")
        f.write(f"{{seg['text'].strip()}}\\n\\n")

print(json.dumps({{
    "text": full_text,
    "srt_path": r"{}",
    "segments": result
}}))
"#, 
        model, 
        if is_cuda_available() { "cuda" } else { "cpu" },
        input.replace('\\', "/"),
        language, language,
        srt_output.to_str().unwrap(),
        srt_output.to_str().unwrap()
    );
    
    let cmd = new_cmd(&python)
        .arg("-c")
        .arg(&script)
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Ошибка запуска Whisper: {}", e))?;
    
    *WHISPER_PID.lock().unwrap() = Some(cmd.id());
    
    let output = cmd.wait_with_output().map_err(|e| e.to_string())?;
    *WHISPER_PID.lock().unwrap() = None;
    
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    
    emit_whisper_progress(&window, 100.0, "Транскрибация завершена");
    
    let result: WhisperResult = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Ошибка парсинга результата: {}", e))?;
    
    Ok(result)
}

pub(crate) async fn burn_subtitles(
    app: tauri::AppHandle, window: tauri::Window,
    input: String, srt_path: String, output: String, hard: bool, job_id: String,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg(&app);
    
    emit_whisper_progress(&window, 10.0, "Запуск вжигания субтитров...");
    
    let filter;
    let mut args = vec!["-y", "-i", &input];
    
    if hard {
        // Жёсткое вжигание
        filter = format!("subtitles='{}':force_style='FontName=Arial,FontSize=24,PrimaryColour=&Hffffff,OutlineColour=&H0,BorderStyle=1,Outline=1,Shadow=0'", 
            srt_path.replace('\\', "/").replace(':', "\\:"));
        args.extend_from_slice(&[
            "-vf", &filter,
            "-c:v", "libx264", "-crf", "23", "-preset", "medium",
            "-c:a", "aac", "-b:a", "192k"
        ]);
    } else {
        // Мягкие субтитры
        args.extend_from_slice(&[
            "-i", &srt_path,
            "-c:v", "copy", "-c:a", "copy",
            "-c:s", "mov_text",
            "-metadata:s:s:0", "language=ru"
        ]);
    }
    
    args.push(&output);
    
    let cmd = new_cmd(&ffmpeg)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Ошибка запуска FFmpeg: {}", e))?;
    
    crate::ACTIVE_FFMPEG_PIDS.lock().unwrap().insert(job_id.clone(), cmd.id());
    
    let output = cmd.wait_with_output().map_err(|e| e.to_string())?;
    crate::ACTIVE_FFMPEG_PIDS.lock().unwrap().remove(&job_id);
    
    if !output.status.success() {
        return Err(command_error("Ошибка вжигания субтитров", &output));
    }
    
    emit_whisper_progress(&window, 100.0, "Субтитры добавлены");
    Ok(())
}

pub(crate) async fn cancel_whisper() -> Result<(), String> {
    if let Some(pid) = *WHISPER_PID.lock().unwrap() {
        #[cfg(target_os = "windows")]
        new_cmd("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output().ok();
        #[cfg(not(target_os = "windows"))]
        new_cmd("kill").arg(pid.to_string()).output().ok();
        *WHISPER_PID.lock().unwrap() = None;
    }
    Ok(())
}