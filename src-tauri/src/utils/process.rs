use std::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub(crate) fn new_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub(crate) fn command_error(step: &str, output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let mut details = format!("{} (exit code {:?})", step, output.status.code());
    if !stderr.is_empty() {
        details.push_str(&format!("\n[stderr]\n{}", stderr));
    }
    if !stdout.is_empty() {
        details.push_str(&format!("\n[stdout]\n{}", stdout));
    }
    details
}

pub(crate) fn get_duration_with(ffprobe: &str, input: &str) -> Option<f64> {
    new_cmd(ffprobe)
        .args([
            "-v",
            "quiet",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            input,
        ])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
}
