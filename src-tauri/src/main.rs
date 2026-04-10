#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::Emitter;
use tauri::Manager;

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

fn resolve_ffmpeg(app: &tauri::AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("ffmpeg.exe");
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    "ffmpeg".to_string()
}

fn resolve_ffprobe(app: &tauri::AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("ffprobe.exe");
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    "ffprobe".to_string()
}

#[tauri::command]
async fn check_ffmpeg(app: tauri::AppHandle, ffmpeg_path: String) -> Result<FfmpegVersion, String> {
    let path = if ffmpeg_path.is_empty() {
        resolve_ffmpeg(&app)
    } else {
        ffmpeg_path
    };
    let output = Command::new(&path)
        .arg("-version")
        .output()
        .map_err(|e| format!("FFmpeg не найден: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout
        .lines()
        .next()
        .unwrap_or("unknown")
        .replace("ffmpeg version ", "")
        .split_whitespace()
        .next()
        .unwrap_or("unknown")
        .to_string();
    Ok(FfmpegVersion { version, path })
}

#[tauri::command]
async fn get_media_info(app: tauri::AppHandle, input: String, ffprobe_path: String) -> Result<MediaInfo, String> {
    let probe = if ffprobe_path.is_empty() {
        resolve_ffprobe(&app)
    } else {
        ffprobe_path
    };
    let output = Command::new(&probe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            &input,
        ])
        .output()
        .map_err(|e| format!("ffprobe: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Разбор ffprobe: {}", e))?;
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
            "audio" => {
                info.audio_codec = stream["codec_name"].as_str().unwrap_or("").to_string();
            }
            _ => {}
        }
    }
    Ok(info)
}

#[tauri::command]
async fn convert(app: tauri::AppHandle, args: ConvertArgs, window: tauri::Window) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg(&app);
    let duration = get_duration_with(&resolve_ffprobe(&app), &args.input).unwrap_or(0.0);
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-i").arg(&args.input)
        .args(&args.args)
        .arg(&args.output)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    run_ffmpeg(cmd, args.job_id, duration, window).await
}

#[tauri::command]
async fn convert_concat(
    app: tauri::AppHandle,
    list_path: String,
    output: String,
    args: Vec<String>,
    job_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg(&app);
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-f").arg("concat")
        .arg("-safe").arg("0")
        .arg("-i").arg(&list_path)
        .args(&args)
        .arg(&output)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    run_ffmpeg(cmd, job_id, 0.0, window).await
}

#[tauri::command]
async fn convert_two_pass(
    app: tauri::AppHandle,
    input: String,
    output: String,
    pass1_args: Vec<String>,
    pass2_args: Vec<String>,
    job_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg(&app);
    let ffprobe = resolve_ffprobe(&app);
    let duration = get_duration_with(&ffprobe, &input).unwrap_or(0.0);
    let null_out = if cfg!(target_os = "windows") { "NUL" } else { "/dev/null" };

    let mut cmd1 = Command::new(&ffmpeg);
    cmd1.arg("-y").arg("-i").arg(&input)
        .args(&pass1_args).arg(null_out)
        .stderr(Stdio::piped()).stdout(Stdio::null());
    run_ffmpeg(cmd1, format!("{}-pass1", job_id), duration, window.clone()).await?;

    let mut cmd2 = Command::new(&ffmpeg);
    cmd2.arg("-y").arg("-i").arg(&input)
        .args(&pass2_args).arg(&output)
        .stderr(Stdio::piped()).stdout(Stdio::null());
    run_ffmpeg(cmd2, job_id, duration, window).await
}

#[tauri::command]
async fn cancel_job(_job_id: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("taskkill").args(["/F", "/IM", "ffmpeg.exe"]).output().ok();
    #[cfg(not(target_os = "windows"))]
    Command::new("pkill").arg("-f").arg("ffmpeg").output().ok();
    Ok(())
}

#[tauri::command]
async fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
async fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("explorer").arg(format!("/select,{}", path)).spawn().ok();
    #[cfg(target_os = "macos")]
    Command::new("open").arg("-R").arg(&path).spawn().ok();
    #[cfg(target_os = "linux")]
    {
        let dir = std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("."));
        Command::new("xdg-open").arg(dir).spawn().ok();
    }
    Ok(())
}

#[tauri::command]
async fn write_temp_list(contents: String) -> Result<String, String> {
    let tmp = std::env::temp_dir().join("ffstudio_merge_list.txt");
    std::fs::write(&tmp, &contents).map_err(|e| e.to_string())?;
    Ok(tmp.to_string_lossy().to_string())
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity((data.len() + 2) / 3 * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };

        encoded.push(CHARS[b0 >> 2] as char);
        encoded.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        
        if chunk.len() > 1 {
            encoded.push(CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] as char);
        } else {
            encoded.push('=');
        }
        
        if chunk.len() > 2 {
            encoded.push(CHARS[b2 & 0x3f] as char);
        } else {
            encoded.push('=');
        }
    }

    encoded
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64_encode(&bytes))
}

#[tauri::command]
async fn preview_frame(app: tauri::AppHandle, input: String, time: f64, vf_args: String) -> Result<String, String> {
    let ffmpeg = resolve_ffmpeg(&app);
    let tmp = std::env::temp_dir().join("ffstudio_preview.jpg");
    
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-ss").arg(time.to_string())
        .arg("-i").arg(&input)
        .arg("-vframes").arg("1");
    
    if !vf_args.is_empty() {
        cmd.arg("-vf").arg(&vf_args);
    }
    
    cmd.arg("-q:v").arg("2")
        .arg(tmp.to_string_lossy().as_ref())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    
    let status = cmd.spawn()
        .map_err(|e| e.to_string())?
        .wait()
        .map_err(|e| e.to_string())?;
    
    if status.success() {
        Ok(tmp.to_string_lossy().to_string())
    } else {
        Err("Не удалось извлечь кадр".to_string())
    }
}

#[tauri::command]
async fn run_ytdlp(url: String, format: String, output_dir: Option<String>) -> Result<String, String> {
    let output_path = if let Some(dir) = output_dir {
        format!("{}\\%(title)s.%(ext)s", dir)
    } else {
        format!("{}\\%(title)s.%(ext)s", std::env::var("USERPROFILE").unwrap_or(".".to_string()) + "\\Downloads")
    };

    let output = Command::new("yt-dlp")
        .arg("--no-playlist")
        .arg("-f").arg(format)
        .arg("-o").arg(output_path)
        .arg(&url)
        .output()
        .map_err(|e| format!("yt-dlp не найден: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("✅ Готово!\n{}", stdout))
    } else {
        Err(format!("❌ Ошибка:\n{}", stderr))
    }
}

async fn run_ffmpeg(
    mut cmd: Command,
    job_id: String,
    duration: f64,
    window: tauri::Window,
) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| format!("Ошибка запуска FFmpeg: {}", e))?;
    let stderr = child.stderr.take().expect("no stderr");
    let reader = BufReader::new(stderr);
    let win = window.clone();
    let jid = job_id.clone();

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
            win.emit("ffmpeg-progress", ProgressEvent {
                job_id: jid.clone(), percent, fps, speed, time: time_str, done: false, error: None,
            }).ok();
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        window.emit("ffmpeg-progress", ProgressEvent {
            job_id, percent: 100.0, fps: 0.0, speed: 0.0,
            time: String::new(), done: true, error: None,
        }).ok();
        Ok(())
    } else {
        let err = format!("FFmpeg завершился с кодом {:?}", status.code());
        window.emit("ffmpeg-progress", ProgressEvent {
            job_id, percent: 0.0, fps: 0.0, speed: 0.0,
            time: String::new(), done: true, error: Some(err.clone()),
        }).ok();
        Err(err)
    }
}

fn get_duration_with(ffprobe: &str, input: &str) -> Option<f64> {
    Command::new(ffprobe)
        .args(["-v", "quiet", "-show_entries", "format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", input])
        .output().ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            get_media_info,
            convert,
            convert_concat,
            convert_two_pass,
            cancel_job,
            file_exists,
            open_in_explorer,
            write_temp_list,
            preview_frame,
            read_file_base64,
            run_ytdlp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}