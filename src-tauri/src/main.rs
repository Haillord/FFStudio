#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod utils;

mod comfy_impl;
mod ffmpeg_impl;
mod files_impl;
mod sd_impl;
mod vcclient_impl;
mod video_impl;
mod whisper_impl;
mod audiocraft_impl;
mod prompt_gen;

pub(crate) use comfy_impl::*;
pub(crate) use ffmpeg_impl::*;
pub(crate) use files_impl::*;
pub(crate) use sd_impl::*;
pub(crate) use vcclient_impl::*;
pub(crate) use video_impl::*;
pub(crate) use whisper_impl::*;
pub(crate) use audiocraft_impl::*;
pub(crate) use prompt_gen::*;

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent};
use tokio::sync::Semaphore;
use models::*;

// ─── Глобальные состояния ─────────────────────────────────────────────────────

pub(crate) static FISH_PID: once_cell::sync::Lazy<Arc<Mutex<Option<u32>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
pub(crate) static VCCLIENT_PID: once_cell::sync::Lazy<Arc<Mutex<Option<u32>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
pub(crate) static VCCLIENT_LAST_MESSAGE: once_cell::sync::Lazy<Arc<Mutex<String>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(String::new())));
pub(crate) static ACTIVE_FFMPEG_PIDS: once_cell::sync::Lazy<Arc<Mutex<std::collections::HashMap<String, u32>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(std::collections::HashMap::new())));
pub(crate) static TEMP_FILES: once_cell::sync::Lazy<Arc<Mutex<HashSet<PathBuf>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));
pub(crate) static FFMPEG_SEMAPHORE: once_cell::sync::Lazy<Arc<Mutex<Arc<Semaphore>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(Arc::new(Semaphore::new(2)))));
pub(crate) static SD_ACTIVE_PROMPT_ID: once_cell::sync::Lazy<Arc<Mutex<Option<String>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
pub(crate) static SD_ACTIVE_COMFY_URL: once_cell::sync::Lazy<Arc<Mutex<Option<String>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
pub(crate) static COMFY_CHILD_PID: once_cell::sync::Lazy<Arc<Mutex<Option<u32>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
pub(crate) static WHISPER_PID: once_cell::sync::Lazy<Arc<Mutex<Option<u32>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

// ─── Хелперы уровня приложения ───────────────────────────────────────────────

pub(crate) fn app_log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    Ok(log_dir.join("ffstudio.log"))
}

pub(crate) fn append_log(app: &tauri::AppHandle, level: &str, event: &str, details: &str) {
    let log_path = match app_log_path(app) {
        Ok(path) => path,
        Err(_) => return,
    };
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{}] [{}] [{}] {}\n", now, level, event, details);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = file.write_all(line.as_bytes());
    }
}

pub(crate) fn register_temp_file(path: PathBuf) {
    TEMP_FILES.lock().ok().map(|mut set| set.insert(path));
}

fn cleanup_temp_files() {
    if let Ok(mut set) = TEMP_FILES.lock() {
        for file in set.iter() {
            let _ = std::fs::remove_file(file);
        }
        set.clear();
    }
}

fn shutdown_background_processes() {
    use crate::utils::process::new_cmd;

    if let Ok(mut ffmpeg_jobs) = ACTIVE_FFMPEG_PIDS.lock() {
        for (_, pid) in ffmpeg_jobs.iter() {
            #[cfg(target_os = "windows")]
            { new_cmd("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output().ok(); }
            #[cfg(not(target_os = "windows"))]
            { new_cmd("kill").arg(pid.to_string()).output().ok(); }
        }
        ffmpeg_jobs.clear();
    }

    for pid_lock in [&FISH_PID, &VCCLIENT_PID, &COMFY_CHILD_PID, &WHISPER_PID] {
        if let Ok(mut guard) = pid_lock.lock() {
            if let Some(pid) = *guard {
                #[cfg(target_os = "windows")]
                { new_cmd("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output().ok(); }
                #[cfg(not(target_os = "windows"))]
                { new_cmd("kill").arg(pid.to_string()).output().ok(); }
            }
            *guard = None;
        }
    }
}

// ─── Точка входа ─────────────────────────────────────────────────────────────

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            append_log(app.handle(), "INFO", "app_start", "MediaKit started");
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                shutdown_background_processes();
                cleanup_temp_files();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ffmpeg::check_ffmpeg,
            commands::ffmpeg::get_media_info,
            commands::ffmpeg::convert,
            commands::ffmpeg::convert_concat,
            commands::ffmpeg::convert_two_pass,
            commands::ffmpeg::cancel_job,
            commands::ffmpeg::preview_frame,
            commands::ffmpeg::prepare_audio_preview,
            commands::ffmpeg::run_ytdlp,
            commands::ffmpeg::set_parallel_limit,
            commands::files::file_exists,
            commands::files::next_available_path,
            commands::files::open_in_explorer,
            commands::files::write_temp_list,
            commands::files::read_file_base64,
            commands::files::save_base64_image,
            commands::files::export_logs,
            commands::sd::scan_stable_diffusion_models,
            commands::sd::open_sd_models_folder,
            commands::sd::open_flux_models_folder,
            commands::sd::scan_flux_text_encoders,
            commands::sd::open_flux_text_encoders_folder,
            commands::sd::scan_vae_models,
            commands::sd::scan_lora_models,
            commands::sd::scan_animatediff_motion_modules,
            commands::sd::open_animatediff_motion_folder,
            commands::sd::open_vae_folder,
            commands::sd::open_lora_folder,
            commands::sd::stable_diffusion_generate,
            commands::sd::stable_diffusion_refine,
            commands::sd::upscale_image,
            commands::sd::cancel_stable_diffusion,
            commands::sd::install_animatediff_nodes,
            commands::sd::list_recommended_models,
            commands::sd::free_comfy_vram,
            commands::video_gen::video_generate,
            commands::comfy::check_comfyui,
            commands::comfy::start_comfyui,
            commands::comfy::stop_comfyui,
            commands::comfy::restart_comfyui,
            commands::comfy::auto_setup_comfyui,
            commands::comfy::install_comfyui_portable,
            commands::comfy::install_recommended_model,
            commands::comfy::get_gallery_files,
            commands::vcclient::check_fish_speech,
            commands::vcclient::check_s2_runtime,
            commands::vcclient::download_fish_speech,
            commands::vcclient::download_s2_runtime,
            commands::vcclient::fish_speech_tts,
            commands::vcclient::voice_tts,
            commands::vcclient::cancel_fish_speech,
            commands::vcclient::translate_ru_en,
            commands::vcclient::check_vcclient,
            commands::vcclient::install_vcclient,
            commands::vcclient::start_vcclient,
            commands::vcclient::stop_vcclient,
            commands::vcclient::open_vcclient_ui,
            commands::whisper::check_whisper,
            commands::whisper::install_whisper,
            commands::whisper::run_whisper,
            commands::whisper::burn_subtitles,
            commands::audiocraft::check_audiocraft,
            commands::audiocraft::install_audiocraft,
            commands::audiocraft::run_audiocraft,
            commands::prompt_gen::get_prompt_gen_status,
            commands::prompt_gen::install_prompt_gen,
            commands::prompt_gen::generate_sd_prompt,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            shutdown_background_processes();
            cleanup_temp_files();
        }
    });
}