use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::Emitter;
use tauri::Manager;
use tokio::time::{sleep, Duration};

use crate::ffmpeg_impl::resolve_ffmpeg;
use crate::models::{FishProgressEvent, VcClientProgressEvent, VcClientStatus, VoiceGenerateArgs};
use crate::utils::process::{command_error, new_cmd};
use crate::{FISH_PID, VCCLIENT_LAST_MESSAGE, VCCLIENT_PID};

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

fn set_vcclient_message(message: impl Into<String>) {
    if let Ok(mut last) = VCCLIENT_LAST_MESSAGE.lock() { *last = message.into(); }
}

fn vcclient_last_message() -> String {
    VCCLIENT_LAST_MESSAGE.lock().map(|msg| msg.clone()).unwrap_or_default()
}

// ─── Пути VCClient ───────────────────────────────────────────────────────────

const VCCLIENT_CUDA_URL: &str = "https://huggingface.co/wok000/vcclient000/resolve/main/vcclient_win_cuda_2.1.4-alpha.zip?download=true";
const VCCLIENT_DML_URL: &str = "https://huggingface.co/wok000/vcclient000/resolve/main/vcclient_win_dml_2.1.4-alpha.zip?download=true";

fn vcclient_parent_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?.join("voice-changer");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn vcclient_install_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> { Ok(vcclient_parent_dir(app)?.join("vcclient")) }
fn vcclient_log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> { Ok(vcclient_parent_dir(app)?.join("vcclient.log")) }
fn vcclient_archive_path(app: &tauri::AppHandle, flavor: &str) -> Result<PathBuf, String> {
    Ok(vcclient_parent_dir(app)?.join(format!("vcclient_{}.zip", flavor)))
}
fn vcclient_url_for_flavor(flavor: &str) -> Result<&'static str, String> {
    match flavor { "cuda" => Ok(VCCLIENT_CUDA_URL), "dml" => Ok(VCCLIENT_DML_URL),
        _ => Err("Неизвестная сборка VCClient. Ожидается cuda или dml.".to_string()) }
}
fn normalize_vcclient_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() { "http://127.0.0.1:18888".to_string() } else { trimmed.to_string() }
}
fn find_file_in_tree(root: &std::path::Path, file_name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() { stack.push(path); continue; }
            if path.file_name().and_then(|n| n.to_str()).map(|n| n.eq_ignore_ascii_case(file_name)).unwrap_or(false) {
                return Some(path);
            }
        }
    }
    None
}
fn vcclient_launcher_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let install_dir = vcclient_install_dir(app)?;
    if !install_dir.exists() { return Err("VCClient еще не установлен".to_string()); }
    find_file_in_tree(&install_dir, "START_HTTP.bat")
        .or_else(|| find_file_in_tree(&install_dir, "start_http.bat"))
        .ok_or_else(|| "Не найден стартовый bat-файл VCClient (START_HTTP.bat)".to_string())
}
fn read_log_tail(path: &std::path::Path, max_lines: usize) -> String {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = content.lines().collect();
    lines[lines.len().saturating_sub(max_lines)..].join("\n")
}
async fn vcclient_healthcheck(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_millis(1500)).build() else { return false };
    client.get(normalize_vcclient_url(url)).send().await.map(|r| r.status().is_success()).unwrap_or(false)
}
fn vcclient_status_from_parts(
    install_dir: PathBuf, log_path: PathBuf, ui_url: String,
    installed: bool, running: bool, message: String,
) -> VcClientStatus {
    let pid = VCCLIENT_PID.lock().ok().and_then(|guard| *guard);
    let log_tail = read_log_tail(&log_path, 120);
    let status = if !installed { "not_installed" } else if running { "online" } else if pid.is_some() { "starting" } else { "stopped" };
    VcClientStatus { installed, running, status: status.to_string(), message, install_dir: install_dir.to_string_lossy().to_string(),
        log_path: log_path.to_string_lossy().to_string(), log_tail, ui_url, pid, last_message: vcclient_last_message() }
}
fn emit_vcclient_progress(window: &tauri::Window, percent: f64, message: impl Into<String>) {
    let message = message.into();
    set_vcclient_message(message.clone());
    window.emit("vcclient-progress", VcClientProgressEvent { percent, message }).ok();
}

// ─── Fish Speech ──────────────────────────────────────────────────────────────

pub(crate) async fn check_fish_speech(app: tauri::AppHandle) -> Result<String, String> {
    let fish_dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?.join("fish-speech");
    if !fish_dir.join("fish_speech").exists() { return Err("Репозиторий fish-speech не установлен".to_string()); }
    let checkpoints = fish_dir.join("checkpoints");
    for file in &["model.pth", "firefly-gan-vq-fsq-8x1024-21hz-generator.pth", "config.json", "tokenizer.tiktoken", "special_tokens.json"] {
        if !checkpoints.join(file).exists() { return Err(format!("Отсутствует вес: {}", file)); }
    }
    Ok("Fish Speech 1.5 готов".to_string())
}

pub(crate) async fn check_s2_runtime(app: tauri::AppHandle) -> Result<String, String> {
    let fish_dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?.join("fish-speech-s2");
    if !fish_dir.join("fish_speech").exists() { return Err("S2 runtime не установлен (fish_speech не найден)".to_string()); }
    if !fish_dir.join("checkpoints").join("s2-pro").join("codec.pth").exists() {
        return Err("Не найден checkpoints/s2-pro/codec.pth".to_string());
    }
    Ok("Fish Audio S2 Pro готов".to_string())
}

pub(crate) async fn download_fish_speech(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let res_dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&res_dir).map_err(|e| e.to_string())?;
    let fish_dir = res_dir.join("fish-speech");
    let checkpoints = fish_dir.join("checkpoints");

    if fish_dir.exists() && !fish_dir.join("pyproject.toml").exists() && !fish_dir.join("setup.py").exists() {
        std::fs::remove_dir_all(&fish_dir).ok();
    }
    if !fish_dir.exists() {
        window.emit("fish-progress", FishProgressEvent { percent: 5.0, message: "Клонирование репозитория fish-speech...".to_string() }).ok();
        let status = new_cmd("git").args(["clone", "https://github.com/fishaudio/fish-speech", fish_dir.to_str().unwrap()])
            .status().map_err(|e| format!("git: {}", e))?;
        if status.success() {
            new_cmd("git").args(["checkout", "v1.5.0"]).current_dir(&fish_dir).status().ok();
        }
        if !status.success() { return Err("Ошибка клонирования репозитория".to_string()); }
    }

    std::fs::create_dir_all(&checkpoints).map_err(|e| e.to_string())?;
    window.emit("fish-progress", FishProgressEvent { percent: 20.0, message: "Установка зависимостей Python...".to_string() }).ok();
    let python = find_python()?;
    let status = new_cmd(&python).args(["-m", "pip", "install", "--force-reinstall", "--no-deps", "."])
        .current_dir(&fish_dir).status().map_err(|e| format!("pip: {}", e))?;
    if !status.success() { return Err("Ошибка установки зависимостей".to_string()); }

    let files = [
        ("https://huggingface.co/fishaudio/fish-speech-1.5/resolve/main/model.pth", "model.pth"),
        ("https://huggingface.co/fishaudio/fish-speech-1.5/resolve/main/firefly-gan-vq-fsq-8x1024-21hz-generator.pth", "firefly-gan-vq-fsq-8x1024-21hz-generator.pth"),
        ("https://huggingface.co/fishaudio/fish-speech-1.5/resolve/main/config.json", "config.json"),
        ("https://huggingface.co/fishaudio/fish-speech-1.5/resolve/main/tokenizer.tiktoken", "tokenizer.tiktoken"),
        ("https://huggingface.co/fishaudio/fish-speech-1.5/resolve/main/special_tokens.json", "special_tokens.json"),
    ];
    for (i, (url, filename)) in files.iter().enumerate() {
        let dest = checkpoints.join(filename);
        let pct = 30.0 + (i as f64 / files.len() as f64) * 70.0;
        if dest.exists() {
            window.emit("fish-progress", FishProgressEvent { percent: pct, message: format!("Пропуск {} (уже есть)", filename) }).ok();
            continue;
        }
        window.emit("fish-progress", FishProgressEvent { percent: pct, message: format!("Загрузка {}...", filename) }).ok();
        let status = new_cmd("curl").args(["-L", "-o", dest.to_str().unwrap(), url])
            .status().map_err(|e| format!("curl: {}", e))?;
        if !status.success() { return Err(format!("Ошибка загрузки {}", filename)); }
    }
    window.emit("fish-progress", FishProgressEvent { percent: 100.0, message: "Установка завершена!".to_string() }).ok();
    Ok(())
}

pub(crate) async fn download_s2_runtime(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let res_dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?;
    std::fs::create_dir_all(&res_dir).map_err(|e| e.to_string())?;
    let fish_dir = res_dir.join("fish-speech-s2");
    let checkpoints = fish_dir.join("checkpoints").join("s2-pro");

    if fish_dir.exists() && !fish_dir.join("pyproject.toml").exists() { std::fs::remove_dir_all(&fish_dir).ok(); }
    if !fish_dir.exists() {
        window.emit("fish-progress", FishProgressEvent { percent: 5.0, message: "S2: клонирование fish-speech (main)...".to_string() }).ok();
        let status = new_cmd("git").args(["clone", "https://github.com/fishaudio/fish-speech", fish_dir.to_str().unwrap_or_default()])
            .status().map_err(|e| format!("git: {}", e))?;
        if !status.success() { return Err("Ошибка клонирования fish-speech".to_string()); }
    }

    window.emit("fish-progress", FishProgressEvent { percent: 25.0, message: "S2: установка Python-зависимостей...".to_string() }).ok();
    let python = find_python()?;
    let pip_check = new_cmd(&python).args(["-m", "pip", "--version"]).output().map_err(|e| format!("Не удалось проверить pip: {}", e))?;
    if !pip_check.status.success() { return Err(command_error("pip недоступен", &pip_check)); }
    let install = new_cmd(&python).args(["-m", "pip", "install", "-e", "."]).current_dir(&fish_dir).output().map_err(|e| format!("pip install: {}", e))?;
    if !install.status.success() { return Err(command_error("Не удалось установить зависимости S2 runtime", &install)); }
    let hf = new_cmd(&python).args(["-m", "pip", "install", "-U", "huggingface_hub"]).output().map_err(|e| format!("pip huggingface_hub: {}", e))?;
    if !hf.status.success() { return Err(command_error("Не удалось установить huggingface_hub", &hf)); }

    std::fs::create_dir_all(&checkpoints).ok();
    window.emit("fish-progress", FishProgressEvent { percent: 55.0, message: "S2: загрузка весов fishaudio/s2-pro...".to_string() }).ok();

    let hf_script = r#"from huggingface_hub import snapshot_download
snapshot_download(repo_id="fishaudio/s2-pro", local_dir=".", local_dir_use_symlinks=False, resume_download=True)
"#;
    let dl = new_cmd(&python).args(["-c", hf_script]).env("HF_HOME", fish_dir.to_string_lossy().to_string())
        .current_dir(&fish_dir).output().map_err(|e| format!("huggingface_hub download: {}", e))?;
    if !dl.status.success() { return Err(command_error("Не удалось скачать веса S2 Pro", &dl)); }

    let nested_codec = fish_dir.join("checkpoints").join("s2-pro").join("codec.pth");
    let nested_alt = fish_dir.join("checkpoints").join("s2-pro").join("checkpoints").join("s2-pro").join("codec.pth");
    if !nested_codec.exists() && nested_alt.exists() {
        if let Some(parent) = nested_codec.parent() { std::fs::create_dir_all(parent).ok(); }
        std::fs::copy(&nested_alt, &nested_codec).ok();
    }
    let codec = checkpoints.join("codec.pth");
    if !codec.exists() { return Err("Скачивание завершилось, но codec.pth не найден".to_string()); }
    if std::fs::metadata(&codec).map(|m| m.len()).unwrap_or(0) == 0 { return Err("Скачивание завершилось, но codec.pth пустой (0 байт)".to_string()); }
    window.emit("fish-progress", FishProgressEvent { percent: 100.0, message: "S2 runtime и веса установлены".to_string() }).ok();
    Ok(())
}

pub(crate) async fn impl_fish_speech_tts(
    app: tauri::AppHandle, window: tauri::Window, text: String, reference_audio: String,
    output: String, speed: f64, temperature: f64, top_p: f64, device: String,
) -> Result<(), String> {
    let res_dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?;
    let fish_dir = res_dir.join("fish-speech");
    let checkpoints = fish_dir.join("checkpoints");
    let old_checkpoints = res_dir.join("checkpoints");
    if old_checkpoints.exists() && !checkpoints.exists() { std::fs::rename(old_checkpoints, &checkpoints).ok(); }

    let python = find_python()?;
    let vqgan_checkpoint = format!("{}/firefly-gan-vq-fsq-8x1024-21hz-generator.pth", checkpoints.to_str().unwrap());
    let resolved_device = if device == "auto" { if is_cuda_available() { "cuda".to_string() } else { "cpu".to_string() } } else { device };
    let ref_wav = fish_dir.join("ref_codes.wav");
    let ref_npy = fish_dir.join("ref_codes.npy");

    if !reference_audio.is_empty() {
        window.emit("fish-progress", FishProgressEvent { percent: 5.0, message: "Кодирование референсного голоса...".to_string() }).ok();
        let cmd0 = new_cmd(&python)
            .args(["tools/vqgan/inference.py", "--input-path", &reference_audio, "--output-path", ref_wav.to_str().unwrap(),
                "--checkpoint-path", &vqgan_checkpoint, "--device", &resolved_device])
            .current_dir(&fish_dir).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Python step0: {}", e))?;
        *FISH_PID.lock().unwrap() = Some(cmd0.id());
        let out0 = cmd0.wait_with_output().map_err(|e| e.to_string())?;
        if !out0.status.success() {
            std::fs::remove_file(&ref_wav).ok(); std::fs::remove_file(&ref_npy).ok();
            return Err(String::from_utf8_lossy(&out0.stderr).to_string());
        }
    }

    window.emit("fish-progress", FishProgressEvent { percent: 10.0, message: "Генерация семантических кодов...".to_string() }).ok();
    let temp_str = temperature.to_string();
    let top_p_str = top_p.to_string();
    let mut args_step1 = vec!["tools/llama/generate.py", "--text", &text, "--checkpoint-path",
        checkpoints.to_str().unwrap(), "--device", &resolved_device, "--num-samples", "1", "--temperature", &temp_str, "--top-p", &top_p_str];
    let ref_npy_str = ref_npy.to_str().unwrap().to_string();
    if !reference_audio.is_empty() { args_step1.extend_from_slice(&["--prompt-tokens", &ref_npy_str, "--prompt-text", ""]); }

    let cmd1 = new_cmd(&python).args(&args_step1).current_dir(&fish_dir).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("Python step1: {}", e))?;
    *FISH_PID.lock().unwrap() = Some(cmd1.id());
    let out1 = cmd1.wait_with_output().map_err(|e| e.to_string())?;
    if !out1.status.success() { return Err(String::from_utf8_lossy(&out1.stderr).to_string()); }

    window.emit("fish-progress", FishProgressEvent { percent: 60.0, message: "Декодирование в аудио...".to_string() }).ok();
    let tmp_npy = fish_dir.join("codes_0.npy");
    let cmd2 = new_cmd(&python)
        .args(["tools/vqgan/inference.py", "--input-path", tmp_npy.to_str().unwrap(), "--output-path", &output,
            "--checkpoint-path", &vqgan_checkpoint, "--device", &resolved_device])
        .current_dir(&fish_dir).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Python step2: {}", e))?;
    *FISH_PID.lock().unwrap() = Some(cmd2.id());
    let out2 = cmd2.wait_with_output().map_err(|e| e.to_string())?;
    *FISH_PID.lock().unwrap() = None;
    std::fs::remove_file(&tmp_npy).ok(); std::fs::remove_file(&ref_wav).ok(); std::fs::remove_file(&ref_npy).ok();
    if !out2.status.success() { return Err(String::from_utf8_lossy(&out2.stderr).to_string()); }

    if (speed - 1.0).abs() > 0.01 {
        window.emit("fish-progress", FishProgressEvent { percent: 90.0, message: "Изменение скорости речи...".to_string() }).ok();
        let tmp_output = format!("{}.tmp.wav", output);
        std::fs::rename(&output, &tmp_output).ok();
        let mut cmd_speed = new_cmd(resolve_ffmpeg(&app))
            .args(["-y", "-i", &tmp_output, "-filter:a", &format!("atempo={}", speed), "-c:v", "copy", &output])
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("FFmpeg speed: {}", e))?;
        let _ = cmd_speed.wait().ok();
        std::fs::remove_file(&tmp_output).ok();
    }
    window.emit("fish-progress", FishProgressEvent { percent: 100.0, message: "Готово!".to_string() }).ok();
    Ok(())
}

async fn s2_pro_tts(
    app: tauri::AppHandle, window: tauri::Window, text: String, reference_audio: String,
    output: String, speed: f64, _temperature: f64, _top_p: f64, device: String,
) -> Result<(), String> {
    let res_dir = app.path().data_dir().map_err(|e: tauri::Error| e.to_string())?;
    let fish_dir = res_dir.join("fish-speech-s2");
    let checkpoints = fish_dir.join("checkpoints").join("s2-pro");
    let codec_checkpoint = checkpoints.join("codec.pth");
    if !fish_dir.join("fish_speech").exists() { return Err("S2 runtime не найден.".to_string()); }
    if !codec_checkpoint.exists() { return Err("Не найдены веса S2 Pro. Ожидается checkpoints/s2-pro/codec.pth.".to_string()); }

    let python = find_python()?;
    let resolved_device = if device == "auto" { if is_cuda_available() { "cuda".to_string() } else { "cpu".to_string() } } else { device };

    let mut known_npys: HashSet<PathBuf> = std::fs::read_dir(&fish_dir).ok().into_iter().flat_map(|it| it.flatten())
        .map(|e| e.path()).filter(|p| p.extension().and_then(|v| v.to_str()) == Some("npy")).collect();
    let known_wavs: HashSet<PathBuf> = std::fs::read_dir(&fish_dir).ok().into_iter().flat_map(|it| it.flatten())
        .map(|e| e.path()).filter(|p| p.extension().and_then(|v| v.to_str()) == Some("wav")).collect();

    let mut prompt_tokens_path: Option<PathBuf> = None;
    if !reference_audio.is_empty() {
        window.emit("fish-progress", FishProgressEvent { percent: 10.0, message: "S2: подготовка токенов референса...".to_string() }).ok();
        let cmd0 = new_cmd(&python)
            .args(["fish_speech/models/dac/inference.py", "-i", &reference_audio,
                "--checkpoint-path", codec_checkpoint.to_str().unwrap_or_default(), "--device", &resolved_device])
            .current_dir(&fish_dir).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("S2 step0: {}", e))?;
        *FISH_PID.lock().unwrap() = Some(cmd0.id());
        let out0 = cmd0.wait_with_output().map_err(|e| e.to_string())?;
        if !out0.status.success() { *FISH_PID.lock().unwrap() = None; return Err(String::from_utf8_lossy(&out0.stderr).to_string()); }
        let mut created: Vec<PathBuf> = std::fs::read_dir(&fish_dir).ok().into_iter().flat_map(|it| it.flatten())
            .map(|e| e.path()).filter(|p| p.extension().and_then(|v| v.to_str()) == Some("npy"))
            .filter(|p| !known_npys.contains(p)).collect();
        created.sort();
        prompt_tokens_path = created.pop();
        if let Some(p) = &prompt_tokens_path { known_npys.insert(p.clone()); }
    }

    window.emit("fish-progress", FishProgressEvent { percent: 45.0, message: "S2: генерация семантических токенов...".to_string() }).ok();
    let mut args_step1 = vec!["fish_speech/models/text2semantic/inference.py".to_string(), "--text".to_string(), text.clone(), "--device".to_string(), resolved_device.clone()];
    if let Some(p) = &prompt_tokens_path { args_step1.extend_from_slice(&["--prompt-tokens".to_string(), p.to_string_lossy().to_string(), "--prompt-text".to_string(), String::new()]); }

    let cmd1 = new_cmd(&python).args(args_step1).current_dir(&fish_dir).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("S2 step1: {}", e))?;
    *FISH_PID.lock().unwrap() = Some(cmd1.id());
    let out1 = cmd1.wait_with_output().map_err(|e| e.to_string())?;
    if !out1.status.success() { *FISH_PID.lock().unwrap() = None; return Err(String::from_utf8_lossy(&out1.stderr).to_string()); }

    let mut codes: Vec<PathBuf> = std::fs::read_dir(&fish_dir).ok().into_iter().flat_map(|it| it.flatten())
        .map(|e| e.path()).filter(|p| p.extension().and_then(|v| v.to_str()) == Some("npy"))
        .filter(|p| !known_npys.contains(p)).collect();
    codes.sort();
    let codes_path = codes.pop().ok_or_else(|| "S2 не создал файл семантических токенов".to_string())?;

    window.emit("fish-progress", FishProgressEvent { percent: 75.0, message: "S2: декодирование в аудио...".to_string() }).ok();
    let cmd2 = new_cmd(&python)
        .args(["fish_speech/models/dac/inference.py", "-i", codes_path.to_str().unwrap_or_default(),
            "--checkpoint-path", codec_checkpoint.to_str().unwrap_or_default(), "--device", &resolved_device])
        .current_dir(&fish_dir).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("S2 step2: {}", e))?;
    *FISH_PID.lock().unwrap() = Some(cmd2.id());
    let out2 = cmd2.wait_with_output().map_err(|e| e.to_string())?;
    *FISH_PID.lock().unwrap() = None;
    if !out2.status.success() { return Err(String::from_utf8_lossy(&out2.stderr).to_string()); }

    let mut created_wavs: Vec<PathBuf> = std::fs::read_dir(&fish_dir).ok().into_iter().flat_map(|it| it.flatten())
        .map(|e| e.path()).filter(|p| p.extension().and_then(|v| v.to_str()) == Some("wav"))
        .filter(|p| !known_wavs.contains(p)).collect();
    created_wavs.sort();
    let generated_wav = created_wavs.pop().ok_or_else(|| "S2 не создал итоговый .wav файл".to_string())?;

    if let Some(parent) = std::path::Path::new(&output).parent() { std::fs::create_dir_all(parent).ok(); }
    std::fs::copy(&generated_wav, &output).map_err(|e| format!("Не удалось сохранить результат S2: {}", e))?;

    if (speed - 1.0).abs() > 0.01 {
        window.emit("fish-progress", FishProgressEvent { percent: 90.0, message: "Изменение скорости речи...".to_string() }).ok();
        let tmp_output = format!("{}.tmp.wav", output);
        std::fs::rename(&output, &tmp_output).ok();
        let mut cmd_speed = new_cmd(resolve_ffmpeg(&app))
            .args(["-y", "-i", &tmp_output, "-filter:a", &format!("atempo={}", speed), "-c:v", "copy", &output])
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("FFmpeg speed: {}", e))?;
        let _ = cmd_speed.wait().ok();
        std::fs::remove_file(&tmp_output).ok();
    }

    std::fs::remove_file(codes_path).ok();
    if let Some(pt) = prompt_tokens_path { std::fs::remove_file(pt).ok(); }
    window.emit("fish-progress", FishProgressEvent { percent: 100.0, message: "Готово!".to_string() }).ok();
    Ok(())
}

pub(crate) async fn voice_tts(app: tauri::AppHandle, window: tauri::Window, args: VoiceGenerateArgs) -> Result<(), String> {
    match args.model.as_str() {
        "fish_speech_1_5" => impl_fish_speech_tts(app, window, args.text, args.reference_audio, args.output, args.speed, args.temperature, args.top_p, args.device).await,
        "s2_mini" => s2_pro_tts(app, window, args.text, args.reference_audio, args.output, args.speed, args.temperature, args.top_p, args.device).await,
        _ => Err("Неизвестная voice-модель".to_string()),
    }
}

pub(crate) async fn cancel_fish_speech() -> Result<(), String> {
    if let Some(pid) = *FISH_PID.lock().unwrap() {
        #[cfg(target_os = "windows")]
        new_cmd("taskkill").args(["/F", "/PID", &pid.to_string()]).output().ok();
        #[cfg(not(target_os = "windows"))]
        new_cmd("kill").arg(pid.to_string()).output().ok();
    }
    Ok(())
}

// ─── Перевод ─────────────────────────────────────────────────────────────────

pub(crate) async fn translate_ru_en(text: String) -> Result<String, String> {
    if text.trim().is_empty() { return Ok(String::new()); }
    let python = find_python()?;
    let script = r#"
import os, sys, subprocess
text = os.environ.get("FF_RU_TEXT", "")
if not text.strip(): print(""); sys.exit(0)
def ensure_argos():
    try:
        import argostranslate.package, argostranslate.translate
    except Exception:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "argostranslate"])
try:
    ensure_argos()
    import argostranslate.package, argostranslate.translate
    langs = argostranslate.translate.get_installed_languages()
    ru = next((l for l in langs if l.code == "ru"), None)
    en = next((l for l in langs if l.code == "en"), None)
    has_pair = ru and en and any(t.to_lang.code == "en" for t in ru.translations_to)
    if not has_pair:
        argostranslate.package.update_package_index()
        packages = argostranslate.package.get_available_packages()
        pkg = next((p for p in packages if p.from_code == "ru" and p.to_code == "en"), None)
        if pkg is None: raise RuntimeError("Не найден пакет перевода ru->en")
        argostranslate.package.install_from_path(pkg.download())
    print(argostranslate.translate.translate(text, "ru", "en").strip())
except Exception as e:
    print(str(e), file=sys.stderr); sys.exit(1)
"#;
    let output = new_cmd(&python).arg("-c").arg(script).env("FF_RU_TEXT", text).output()
        .map_err(|e| format!("Python translate: {}", e))?;
    if output.status.success() { Ok(String::from_utf8_lossy(&output.stdout).trim().to_string()) }
    else { Err(format!("Не удалось выполнить локальный перевод RU->EN: {}", String::from_utf8_lossy(&output.stderr).trim())) }
}

// ─── VCClient ────────────────────────────────────────────────────────────────

pub(crate) async fn check_vcclient(app: tauri::AppHandle, server_url: Option<String>) -> Result<VcClientStatus, String> {
    let install_dir = vcclient_install_dir(&app)?;
    let log_path = vcclient_log_path(&app)?;
    let ui_url = normalize_vcclient_url(server_url.as_deref().unwrap_or(""));
    let installed = vcclient_launcher_path(&app).is_ok();
    let running = vcclient_healthcheck(&ui_url).await;
    let message = if !installed { "VCClient еще не установлен".to_string() }
        else if running { format!("VCClient отвечает по {}", ui_url) }
        else if VCCLIENT_PID.lock().ok().and_then(|g| *g).is_some() { "VCClient запускается или перестал отвечать".to_string() }
        else { "VCClient установлен, но сейчас не запущен".to_string() };
    Ok(vcclient_status_from_parts(install_dir, log_path, ui_url, installed, running, message))
}

pub(crate) async fn install_vcclient(app: tauri::AppHandle, window: tauri::Window, flavor: String) -> Result<VcClientStatus, String> {
    let flavor = flavor.trim().to_lowercase();
    let archive_url = vcclient_url_for_flavor(&flavor)?;
    let parent_dir = vcclient_parent_dir(&app)?;
    let install_dir = vcclient_install_dir(&app)?;
    let archive_path = vcclient_archive_path(&app, &flavor)?;
    let log_path = vcclient_log_path(&app)?;
    let ui_url = normalize_vcclient_url("");

    emit_vcclient_progress(&window, 2.0, "Подготовка...");
    if install_dir.exists() {
        std::fs::remove_dir_all(&install_dir)
            .map_err(|e| format!("Не удалось очистить старую установку: {}", e))?;
    }
    std::fs::create_dir_all(&parent_dir).map_err(|e| e.to_string())?;

    // ── Скачивание через reqwest со стримингом ──
    emit_vcclient_progress(&window, 5.0, "Скачивание VCClient...");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(archive_url).send().await
        .map_err(|e| format!("Ошибка запроса: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}: не удалось скачать VCClient", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(&archive_path).await
        .map_err(|e| format!("Не удалось создать файл: {}", e))?;

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Ошибка потока: {}", e))?;
        file.write_all(&chunk).await
            .map_err(|e| format!("Ошибка записи: {}", e))?;
        downloaded += chunk.len() as u64;

        let pct = if total > 0 {
            5.0 + (downloaded as f64 / total as f64 * 60.0)
        } else { 30.0 };

        let msg = if total > 0 {
            format!("Скачивание... {:.0}MB / {:.0}MB", downloaded as f64 / 1e6, total as f64 / 1e6)
        } else {
            format!("Скачивание... {:.0}MB", downloaded as f64 / 1e6)
        };
        emit_vcclient_progress(&window, pct, msg);
    }
    file.flush().await.map_err(|e| format!("Ошибка записи: {}", e))?;
    drop(file);

    // ── Распаковка ──
    emit_vcclient_progress(&window, 70.0, "Распаковка VCClient...");
    let ex = new_cmd("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
            &format!("Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                archive_path.to_string_lossy(), install_dir.to_string_lossy())])
        .output()
        .map_err(|e| format!("Не удалось распаковать: {}", e))?;
    if !ex.status.success() {
        return Err(command_error("Распаковка завершилась с ошибкой", &ex));
    }

    std::fs::remove_file(&archive_path).ok(); // чистим архив

    let launcher = vcclient_launcher_path(&app)?;
    let launcher_dir = launcher.parent().map(|p| p.to_path_buf()).unwrap_or(install_dir.clone());
    let msg = format!("VCClient {} установлен в {}", flavor, launcher_dir.to_string_lossy());
    set_vcclient_message(msg.clone());
    emit_vcclient_progress(&window, 100.0, "VCClient установлен");
    Ok(vcclient_status_from_parts(install_dir, log_path, ui_url, true, false, msg))
}

pub(crate) async fn start_vcclient(app: tauri::AppHandle, window: tauri::Window, server_url: Option<String>) -> Result<VcClientStatus, String> {
    let install_dir = vcclient_install_dir(&app)?;
    let log_path = vcclient_log_path(&app)?;
    let ui_url = normalize_vcclient_url(server_url.as_deref().unwrap_or(""));

    if vcclient_healthcheck(&ui_url).await {
        let msg = format!("VCClient уже запущен на {}", ui_url);
        return Ok(vcclient_status_from_parts(install_dir, log_path, ui_url, true, true, msg));
    }

    let launcher = vcclient_launcher_path(&app)?;
    let launcher_dir = launcher.parent().map(|p| p.to_path_buf()).ok_or_else(|| "Не удалось определить папку VCClient".to_string())?;
    emit_vcclient_progress(&window, 10.0, "Запуск VCClient...");

    let log_file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)
        .map_err(|e| format!("Не удалось открыть лог VCClient: {}", e))?;
    let log_file_err = log_file.try_clone().map_err(|e| format!("Не удалось подготовить лог: {}", e))?;

    let child = new_cmd("cmd").arg("/C").arg(launcher.to_string_lossy().to_string())
        .current_dir(&launcher_dir).stdout(Stdio::from(log_file)).stderr(Stdio::from(log_file_err))
        .spawn().map_err(|e| format!("Не удалось запустить VCClient: {}", e))?;
    *VCCLIENT_PID.lock().unwrap() = Some(child.id());
    set_vcclient_message(format!("VCClient запускается: {}", launcher_dir.to_string_lossy()));

    for attempt in 0..40u32 {
        let percent = 20.0 + (attempt as f64 * 2.0).min(70.0);
        emit_vcclient_progress(&window, percent, "Ожидание веб-интерфейса VCClient...");
        if vcclient_healthcheck(&ui_url).await {
            let msg = format!("VCClient запущен на {}", ui_url);
            set_vcclient_message(msg.clone());
            emit_vcclient_progress(&window, 100.0, msg.clone());
            return Ok(vcclient_status_from_parts(install_dir, log_path, ui_url, true, true, msg));
        }
        sleep(Duration::from_millis(500)).await;
    }
    Err(format!("VCClient запущен, но веб-интерфейс не ответил по {}. Проверьте лог: {}", ui_url, log_path.to_string_lossy()))
}

pub(crate) async fn stop_vcclient(app: tauri::AppHandle, window: tauri::Window, server_url: Option<String>) -> Result<VcClientStatus, String> {
    let install_dir = vcclient_install_dir(&app)?;
    let log_path = vcclient_log_path(&app)?;
    let ui_url = normalize_vcclient_url(server_url.as_deref().unwrap_or(""));
    emit_vcclient_progress(&window, 10.0, "Остановка VCClient...");

    if let Some(pid) = VCCLIENT_PID.lock().ok().and_then(|g| *g) {
        #[cfg(target_os = "windows")]
        {
            let output = new_cmd("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output()
                .map_err(|e| format!("Не удалось остановить VCClient: {}", e))?;
            if !output.status.success() { return Err(command_error("taskkill VCClient завершился с ошибкой", &output)); }
        }
        #[cfg(not(target_os = "windows"))]
        { new_cmd("kill").arg(pid.to_string()).output().map_err(|e| format!("Не удалось остановить VCClient: {}", e))?; }
    }
    if let Ok(mut guard) = VCCLIENT_PID.lock() { *guard = None; }
    let msg = "VCClient остановлен".to_string();
    set_vcclient_message(msg.clone());
    emit_vcclient_progress(&window, 100.0, msg.clone());
    Ok(vcclient_status_from_parts(install_dir, log_path, ui_url, vcclient_launcher_path(&app).is_ok(), false, msg))
}

pub(crate) async fn open_vcclient_ui(server_url: Option<String>) -> Result<(), String> {
    let url = normalize_vcclient_url(server_url.as_deref().unwrap_or(""));
    #[cfg(target_os = "windows")]
    new_cmd("explorer").arg(&url).spawn().map_err(|e| format!("Не удалось открыть VCClient UI: {}", e))?;
    #[cfg(target_os = "macos")]
    new_cmd("open").arg(&url).spawn().map_err(|e| format!("Не удалось открыть VCClient UI: {}", e))?;
    #[cfg(target_os = "linux")]
    new_cmd("xdg-open").arg(&url).spawn().map_err(|e| format!("Не удалось открыть VCClient UI: {}", e))?;
    Ok(())
}
