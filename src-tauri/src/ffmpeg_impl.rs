use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;

use crate::models::{ConvertArgs, FfmpegVersion, MediaInfo, ProgressEvent};
use crate::utils::process::{get_duration_with, new_cmd};
use crate::{append_log, register_temp_file, ACTIVE_FFMPEG_PIDS, FFMPEG_SEMAPHORE};

// ─── Поиск ffmpeg / ffprobe ──────────────────────────────────────────────────

pub(crate) fn resolve_ffmpeg(app: &tauri::AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("ffmpeg.exe");
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    if cfg!(debug_assertions) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(debug_dir) = exe.parent() {
                let candidate = debug_dir.join("..").join("..").join("resources").join("ffmpeg.exe");
                if candidate.exists() { return candidate.to_string_lossy().to_string(); }
                let candidate2 = debug_dir.join("..").join("..").join("..").join("resources").join("ffmpeg.exe");
                if candidate2.exists() { return candidate2.to_string_lossy().to_string(); }
            }
        }
    }
    "ffmpeg".to_string()
}

pub(crate) fn resolve_ffprobe(app: &tauri::AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("ffprobe.exe");
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    if cfg!(debug_assertions) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(debug_dir) = exe.parent() {
                let candidate = debug_dir.join("..").join("..").join("resources").join("ffprobe.exe");
                if candidate.exists() { return candidate.to_string_lossy().to_string(); }
                let candidate2 = debug_dir.join("..").join("..").join("..").join("resources").join("ffprobe.exe");
                if candidate2.exists() { return candidate2.to_string_lossy().to_string(); }
            }
        }
    }
    "ffprobe".to_string()
}

// ─── Проверка и информация ───────────────────────────────────────────────────

pub(crate) async fn check_ffmpeg(app: tauri::AppHandle, ffmpeg_path: String) -> Result<FfmpegVersion, String> {
    let path = if ffmpeg_path.is_empty() { resolve_ffmpeg(&app) } else { ffmpeg_path };
    append_log(&app, "INFO", "check_ffmpeg_start", &format!("path={}", path));
    let output = new_cmd(&path).arg("-version").output()
        .map_err(|e| format!("FFmpeg не найден: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout.lines().next().unwrap_or("unknown")
        .replace("ffmpeg version ", "")
        .split_whitespace().next().unwrap_or("unknown").to_string();
    append_log(&app, "INFO", "check_ffmpeg_ok", &format!("version={} path={}", version, path));
    Ok(FfmpegVersion { version, path })
}

pub(crate) async fn get_media_info(app: tauri::AppHandle, input: String, ffprobe_path: String) -> Result<MediaInfo, String> {
    let probe = if ffprobe_path.is_empty() { resolve_ffprobe(&app) } else { ffprobe_path };
    append_log(&app, "INFO", "media_info_start", &format!("input={}", input));
    let output = new_cmd(&probe)
        .args(["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", &input])
        .output().map_err(|e| format!("ffprobe: {}", e))?;
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Разбор ffprobe: {}", e))?;
    let format = &json["format"];
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let mut info = MediaInfo {
        duration: format["duration"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        width: 0, height: 0,
        video_codec: String::new(),
        audio_codec: String::new(),
        fps: 0.0,
        bitrate: format["bit_rate"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        size: format["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        format: format["format_name"].as_str().unwrap_or("unknown").to_string(),
    };
    for stream in &streams {
        match stream["codec_type"].as_str().unwrap_or("") {
            "video" => {
                info.width = stream["width"].as_u64().unwrap_or(0) as u32;
                info.height = stream["height"].as_u64().unwrap_or(0) as u32;
                info.video_codec = stream["codec_name"].as_str().unwrap_or("").to_string();
                if let Some(s) = stream["r_frame_rate"].as_str() {
                    let p: Vec<&str> = s.split('/').collect();
                    if p.len() == 2 {
                        let n: f64 = p[0].parse().unwrap_or(0.0);
                        let d: f64 = p[1].parse().unwrap_or(1.0);
                        if d != 0.0 { info.fps = n / d; }
                    }
                }
            }
            "audio" => { info.audio_codec = stream["codec_name"].as_str().unwrap_or("").to_string(); }
            _ => {}
        }
    }
    append_log(&app, "INFO", "media_info_ok", &format!("input={}", input));
    Ok(info)
}

// ─── Конвертация ─────────────────────────────────────────────────────────────

pub(crate) async fn convert(app: tauri::AppHandle, args: ConvertArgs, window: tauri::Window) -> Result<(), String> {
    append_log(&app, "INFO", "convert_start", &format!("job_id={} input={} output={}", args.job_id, args.input, args.output));
    let ffmpeg = resolve_ffmpeg(&app);
    let duration = get_duration_with(&resolve_ffprobe(&app), &args.input).unwrap_or(0.0);
    let mut cmd = new_cmd(&ffmpeg);
    cmd.arg("-y").arg("-i").arg(&args.input).args(&args.args).arg(&args.output)
        .stderr(Stdio::piped()).stdout(Stdio::null());
    run_ffmpeg(cmd, args.job_id.clone(), duration, window).await
        .map(|_| append_log(&app, "INFO", "convert_done", &format!("job_id={}", args.job_id)))
        .map_err(|e| { append_log(&app, "ERROR", "convert_error", &format!("job_id={} error={}", args.job_id, e)); e })
}

pub(crate) async fn convert_concat(
    app: tauri::AppHandle, list_path: String, output: String,
    args: Vec<String>, job_id: String, window: tauri::Window,
) -> Result<(), String> {
    append_log(&app, "INFO", "convert_concat_start", &format!("job_id={} output={}", job_id, output));
    let ffmpeg = resolve_ffmpeg(&app);
    let mut cmd = new_cmd(&ffmpeg);
    cmd.arg("-y").arg("-f").arg("concat").arg("-safe").arg("0")
        .arg("-i").arg(&list_path).args(&args).arg(&output)
        .stderr(Stdio::piped()).stdout(Stdio::null());
    run_ffmpeg(cmd, job_id.clone(), 0.0, window).await
        .map(|_| append_log(&app, "INFO", "convert_concat_done", &format!("job_id={}", job_id)))
        .map_err(|e| { append_log(&app, "ERROR", "convert_concat_error", &format!("job_id={} error={}", job_id, e)); e })
}

pub(crate) async fn convert_two_pass(
    app: tauri::AppHandle, input: String, output: String,
    pass1_args: Vec<String>, pass2_args: Vec<String>,
    job_id: String, window: tauri::Window,
) -> Result<(), String> {
    append_log(&app, "INFO", "convert_two_pass_start", &format!("job_id={} input={} output={}", job_id, input, output));
    let ffmpeg = resolve_ffmpeg(&app);
    let duration = get_duration_with(&resolve_ffprobe(&app), &input).unwrap_or(0.0);
    let null_out = if cfg!(target_os = "windows") { "NUL" } else { "/dev/null" };

    let mut cmd1 = new_cmd(&ffmpeg);
    cmd1.arg("-y").arg("-i").arg(&input).args(&pass1_args).arg(null_out)
        .stderr(Stdio::piped()).stdout(Stdio::null());
    run_ffmpeg(cmd1, format!("{}-pass1", job_id), duration, window.clone()).await?;

    let mut cmd2 = new_cmd(&ffmpeg);
    cmd2.arg("-y").arg("-i").arg(&input).args(&pass2_args).arg(&output)
        .stderr(Stdio::piped()).stdout(Stdio::null());
    run_ffmpeg(cmd2, job_id.clone(), duration, window).await
        .map(|_| append_log(&app, "INFO", "convert_two_pass_done", &format!("job_id={}", job_id)))
        .map_err(|e| { append_log(&app, "ERROR", "convert_two_pass_error", &format!("job_id={} error={}", job_id, e)); e })
}

pub(crate) async fn cancel_job(job_id: String) -> Result<(), String> {
    if let Ok(mut active) = ACTIVE_FFMPEG_PIDS.lock() {
        if let Some(pid) = active.remove(&job_id) {
            #[cfg(target_os = "windows")]
            { new_cmd("taskkill").args(["/F", "/PID", &pid.to_string()]).output().ok(); }
            #[cfg(not(target_os = "windows"))]
            { new_cmd("kill").arg(pid.to_string()).output().ok(); }
        }
    }
    Ok(())
}

pub(crate) async fn set_parallel_limit(limit: u32) -> Result<u32, String> {
    let clamped = limit.clamp(1, 4);
    if let Ok(mut guard) = FFMPEG_SEMAPHORE.lock() {
        *guard = Arc::new(tokio::sync::Semaphore::new(clamped as usize));
        return Ok(clamped);
    }
    Err("Не удалось применить лимит параллельных задач".to_string())
}

// ─── Предпросмотр ────────────────────────────────────────────────────────────

pub(crate) async fn preview_frame(app: tauri::AppHandle, input: String, time: f64, vf_args: String) -> Result<String, String> {
    let ffmpeg = resolve_ffmpeg(&app);
    let tmp = std::env::temp_dir().join("ffstudio_preview.jpg");
    register_temp_file(tmp.clone());
    let mut cmd = new_cmd(&ffmpeg);
    cmd.arg("-y").arg("-ss").arg(time.to_string()).arg("-i").arg(&input).arg("-vframes").arg("1");
    if !vf_args.is_empty() { cmd.arg("-vf").arg(&vf_args); }
    cmd.arg("-q:v").arg("2").arg(tmp.to_string_lossy().as_ref())
        .stdout(Stdio::null()).stderr(Stdio::null());
    let status = cmd.spawn().map_err(|e| e.to_string())?.wait().map_err(|e| e.to_string())?;
    if status.success() { Ok(tmp.to_string_lossy().to_string()) }
    else { Err("Не удалось извлечь кадр".to_string()) }
}

pub(crate) async fn prepare_audio_preview(app: tauri::AppHandle, input: String) -> Result<String, String> {
    if input.trim().is_empty() { return Err("Не указан входной файл".to_string()); }
    if !std::path::Path::new(&input).exists() { return Err("Файл для предпрослушки не найден".to_string()); }
    let ffmpeg = resolve_ffmpeg(&app);
    let tmp = std::env::temp_dir().join(format!(
        "ffstudio_audio_preview_{}_{}.wav",
        std::process::id(), chrono::Utc::now().timestamp_millis()
    ));
    register_temp_file(tmp.clone());
    let status = new_cmd(&ffmpeg)
        .arg("-y").arg("-i").arg(&input).arg("-vn")
        .arg("-ac").arg("1").arg("-ar").arg("22050")
        .arg("-acodec").arg("pcm_s16le")
        .arg(tmp.to_string_lossy().to_string())
        .stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("Не удалось запустить FFmpeg для предпрослушки: {}", e))?
        .wait().map_err(|e| format!("Не удалось дождаться FFmpeg: {}", e))?;
    if status.success() { Ok(tmp.to_string_lossy().to_string()) }
    else { Err("Не удалось подготовить WAV для предпрослушки".to_string()) }
}

// ─── yt-dlp ──────────────────────────────────────────────────────────────────

pub(crate) async fn run_ytdlp(url: String, format: String, output_dir: Option<String>) -> Result<String, String> {
    let output_path = if let Some(dir) = output_dir {
        format!("{}\\%(title)s.%(ext)s", dir)
    } else {
        format!("{}\\%(title)s.%(ext)s", std::env::var("USERPROFILE").unwrap_or(".".to_string()) + "\\Downloads")
    };
    let output = new_cmd("yt-dlp")
        .arg("--no-playlist").arg("-f").arg(format).arg("-o").arg(output_path).arg(&url)
        .output().map_err(|e| format!("yt-dlp не найден: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() { Ok(format!("✅ Готово!\n{}", stdout)) }
    else { Err(format!("❌ Ошибка:\n{}", stderr)) }
}

// ─── Основной цикл FFmpeg ─────────────────────────────────────────────────────

pub(crate) async fn run_ffmpeg(
    mut cmd: Command, job_id: String, duration: f64, window: tauri::Window,
) -> Result<(), String> {
    let semaphore = FFMPEG_SEMAPHORE
        .lock().map_err(|_| "Очередь задач недоступна. Перезапустите приложение.".to_string())?
        .clone();
    let _permit = semaphore.acquire().await
        .map_err(|_| "Очередь задач недоступна. Перезапустите приложение.".to_string())?;

    let mut child = cmd.spawn().map_err(|e| format!("Ошибка запуска FFmpeg: {}", e))?;
    if let Ok(mut active) = ACTIVE_FFMPEG_PIDS.lock() {
        active.insert(job_id.clone(), child.id());
    }

    let stderr = child.stderr.take().expect("no stderr");
    let reader = BufReader::new(stderr);

    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        if line.contains("time=") {
            let mut percent = 0.0f64;
            let mut fps = 0.0f64;
            let mut speed = 0.0f64;
            let mut time_str = String::new();
            for token in line.split_whitespace() {
                if let Some((key, val)) = token.split_once('=') {
                    match key {
                        "fps" => fps = val.parse().unwrap_or(fps),
                        "speed" => speed = val.trim_end_matches('x').parse().unwrap_or(speed),
                        "time" => {
                            time_str = val.to_string();
                            if duration > 0.0 {
                                let p: Vec<&str> = val.split(':').collect();
                                if p.len() == 3 {
                                    let secs = p[0].parse::<f64>().unwrap_or(0.0) * 3600.0
                                        + p[1].parse::<f64>().unwrap_or(0.0) * 60.0
                                        + p[2].parse::<f64>().unwrap_or(0.0);
                                    percent = (secs / duration * 100.0).min(99.9);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            window.emit("ffmpeg-progress", ProgressEvent {
                job_id: job_id.clone(), percent, fps, speed, time: time_str, done: false, error: None,
            }).ok();
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if let Ok(mut active) = ACTIVE_FFMPEG_PIDS.lock() { active.remove(&job_id); }

    if status.success() {
        window.emit("ffmpeg-progress", ProgressEvent {
            job_id, percent: 100.0, fps: 0.0, speed: 0.0,
            time: String::new(), done: true, error: None,
        }).ok();
        Ok(())
    } else {
        let err = format!(
            "Ошибка конвертации: FFmpeg завершился с кодом {:?}. Проверьте параметры кодека/формата и повторите.",
            status.code()
        );
        window.emit("ffmpeg-progress", ProgressEvent {
            job_id, percent: 0.0, fps: 0.0, speed: 0.0,
            time: String::new(), done: true, error: Some(err.clone()),
        }).ok();
        Err(err)
    }
}
