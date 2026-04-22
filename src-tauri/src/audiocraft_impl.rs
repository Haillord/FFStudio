use std::io::{BufRead, BufReader};
use std::process::Stdio;
use tauri::Emitter;
use tauri::Manager;

use crate::utils::process::new_cmd;
use crate::vcclient_impl::find_python;
use crate::{append_log, register_temp_file};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioCraftProgressEvent {
    pub percent: f64,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioCraftResult {
    pub output_path: String,
    pub duration: f64,
}

fn audiocraft_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("audiocraft");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn emit_progress(window: &tauri::Window, percent: f64, message: impl Into<String>) {
    window.emit("audiocraft-progress", AudioCraftProgressEvent {
        percent,
        message: message.into(),
    }).ok();
}

// Построчный repair — не зависит от line endings (\r\n vs \n).
// audiocraft 1.3.0 на PyPI содержит try: без тела в нескольких файлах.
// Алгоритм: ищем строку "try:" после которой идёт строка без отступа
// содержащая нужный импорт. Заменяем весь блок (включая мусорные
// дублирующиеся except) на один чистый try/except.
const REPAIR_SCRIPT: &str = r#"
import site, pathlib, sys

def find_ac_dir():
    for sp in site.getsitepackages():
        c = pathlib.Path(sp) / 'audiocraft'
        if c.exists():
            return c
    return None

ac_dir = find_ac_dir()
if not ac_dir:
    print('ERROR: audiocraft dir not found')
    sys.exit(1)

def repair(filepath, trigger_import, var_name):
    f = pathlib.Path(filepath)
    if not f.exists():
        print(f'missing: {f.name}')
        return

    # Читаем как bytes, нормализуем CRLF -> LF для обработки, потом вернём
    raw = f.read_bytes()
    crlf = b'\r\n' in raw
    text = raw.replace(b'\r\n', b'\n').decode('utf-8')
    lines = text.split('\n')

    out = []
    i = 0
    changed = False
    while i < len(lines):
        stripped = lines[i].strip()

        # Обнаружили голый try: (без ничего в той же строке кроме :)
        if stripped == 'try:':
            # Собираем весь подозрительный блок вперёд
            block_start = i
            j = i + 1
            # Пропускаем все подряд идущие try: (накопленные прошлыми патчами)
            while j < len(lines) and lines[j].strip() == 'try:':
                j += 1
            # Следующая строка — это импорт?
            if j < len(lines) and trigger_import in lines[j]:
                # Это наш сломанный блок. Пропускаем всё до конца всех except/pass
                k = j + 1
                while k < len(lines):
                    s = lines[k].strip()
                    if s in ('except ImportError:', 'except Exception:', 'pass',
                             f'{var_name} = None', 'ops = None', 'flashy = None'):
                        k += 1
                    else:
                        break
                # Вставляем чистый блок
                out.append(f'try:')
                out.append(f'    {trigger_import}')
                out.append(f'except ImportError:')
                out.append(f'    {var_name} = None')
                i = k
                changed = True
                continue

        out.append(lines[i])
        i += 1

    if changed:
        result = '\n'.join(out)
        if crlf:
            result = result.replace('\n', '\r\n')
        f.write_bytes(result.encode('utf-8'))
        print(f'repaired: {f.name}')
    else:
        print(f'ok: {f.name}')

repair(ac_dir / 'modules/transformer.py',   'from xformers import ops', 'ops')
repair(ac_dir / 'quantization/core_vq.py',  'import flashy',            'flashy')
repair(ac_dir / 'modules/conditioners.py',  'import flashy',            'flashy')
"#;

pub(crate) async fn check_audiocraft(app: tauri::AppHandle) -> Result<String, String> {
    let python = find_python()?;
    let check = new_cmd(&python)
        .args(["-c", "import audiocraft; print(audiocraft.__version__)"])
        .output()
        .map_err(|e| format!("Python: {}", e))?;
    if check.status.success() {
        let version = String::from_utf8_lossy(&check.stdout).trim().to_string();
        append_log(&app, "INFO", "check_audiocraft_ok", &format!("version={}", version));
        Ok(format!("AudioCraft {} готов", version))
    } else {
        Err("AudioCraft не установлен".to_string())
    }
}

pub(crate) async fn install_audiocraft(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    let python = find_python()?;
    append_log(&app, "INFO", "install_audiocraft_start", "");

    emit_progress(&window, 3.0, "Проверка Python...");
    let pip_ok = new_cmd(&python)
        .args(["-m", "pip", "--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !pip_ok {
        return Err("pip недоступен. Установите Python 3.10+.".to_string());
    }

    emit_progress(&window, 8.0, "Установка PyTorch 2.1.0...");
    let cuda_ok = new_cmd("nvidia-smi").output().is_ok();
    if cuda_ok {
        new_cmd(&python)
            .args(["-m", "pip", "install",
                   "torch==2.1.0", "torchaudio==2.1.0", "torchvision==0.16.0",
                   "--index-url", "https://download.pytorch.org/whl/cu121"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .output().ok();
    } else {
        new_cmd(&python)
            .args(["-m", "pip", "install",
                   "torch==2.1.0", "torchaudio==2.1.0", "torchvision==0.16.0"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .output().ok();
    }

    emit_progress(&window, 35.0, "Установка AudioCraft...");
    new_cmd(&python)
        .args(["-m", "pip", "install", "audiocraft==1.3.0", "--no-deps"])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .output().ok();

    // xformers строго под torch 2.1.0 + cu121
    new_cmd(&python)
        .args(["-m", "pip", "install",
               "xformers==0.0.22.post7",
               "--index-url", "https://download.pytorch.org/whl/cu121"])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .output().ok();

    emit_progress(&window, 50.0, "Установка зависимостей (1/3)...");
    new_cmd(&python)
        .args(["-m", "pip", "install",
               "encodec", "demucs", "hydra-core", "hydra-colorlog",
               "omegaconf", "einops", "num2words",
               "transformers==4.35.2",
               "huggingface_hub", "sentencepiece",
        ])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .output().ok();

    emit_progress(&window, 63.0, "Установка зависимостей (2/3)...");
    new_cmd(&python)
        .args(["-m", "pip", "install", "av==11.0.0", "--only-binary", ":all:"])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .output().ok();

    emit_progress(&window, 73.0, "Установка зависимостей (3/3)...");
    let flashy_ok = new_cmd(&python)
        .args(["-m", "pip", "install",
               "git+https://github.com/facebookresearch/flashy.git"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !flashy_ok {
        return Err(
            "Не удалось установить flashy. Проверьте интернет и что git установлен (https://git-scm.com).".to_string()
        );
    }

    // Repair: audiocraft 1.3.0 на PyPI содержит невалидный Python.
    // Запускаем ВСЕГДА после установки. Скрипт идемпотентен.
    emit_progress(&window, 85.0, "Исправление совместимости...");
    let repair = new_cmd(&python)
        .args(["-c", REPAIR_SCRIPT])
        .output()
        .map_err(|e| format!("repair: {}", e))?;

    let repair_out = String::from_utf8_lossy(&repair.stdout).to_string();
    let repair_err = String::from_utf8_lossy(&repair.stderr).to_string();
    append_log(&app, "INFO", "audiocraft_repair_out", &repair_out);
    if !repair_err.is_empty() {
        append_log(&app, "WARN", "audiocraft_repair_err", &repair_err);
    }
    if repair_out.contains("ERROR:") {
        return Err(format!("Ошибка при исправлении файлов: {}", repair_out));
    }

    emit_progress(&window, 94.0, "Проверка установки...");
    let verify = new_cmd(&python)
        .args(["-c", "from audiocraft.models import MusicGen; print('ok')"])
        .output()
        .map_err(|e| format!("Проверка: {}", e))?;

    if !verify.status.success() {
        let err = String::from_utf8_lossy(&verify.stderr).to_string();
        append_log(&app, "ERROR", "install_audiocraft_verify", &err);
        return Err(format!("AudioCraft не импортируется: {}", err));
    }

    append_log(&app, "INFO", "install_audiocraft_done", "");
    emit_progress(&window, 100.0, "AudioCraft установлен!");
    Ok(())
}

pub(crate) async fn run_audiocraft(
    app: tauri::AppHandle,
    window: tauri::Window,
    prompt: String,
    model: String,
    duration: f64,
    reference_audio: String,
    job_id: String,
) -> Result<AudioCraftResult, String> {
    append_log(&app, "INFO", "audiocraft_start",
        &format!("job_id={} model={} duration={} prompt={}", job_id, model, duration, prompt));

    let python = find_python()?;

    let out_path = audiocraft_dir(&app)?
        .join(format!("music_{}.wav", job_id));
    register_temp_file(out_path.clone());
    let out_path_str = out_path.to_string_lossy().to_string();

    let ref_arg = if !reference_audio.is_empty() && model == "melody" {
        format!("r'{}'", reference_audio)
    } else {
        "None".to_string()
    };

    let script = format!(r#"
import sys, os, warnings
warnings.filterwarnings("ignore")

print("PROGRESS:5:Загрузка модели {model}...", flush=True)

try:
    from audiocraft.models import MusicGen
    import torchaudio, torch
except ImportError as e:
    print(f"ERROR:Импорт: {{e}}", flush=True)
    sys.exit(1)

model_name = "facebook/musicgen-{model}"
try:
    model = MusicGen.get_pretrained(model_name)
except Exception as e:
    print(f"ERROR:Загрузка модели: {{e}}", flush=True)
    sys.exit(1)

print("PROGRESS:40:Модель загружена, генерация...", flush=True)
model.set_generation_params(duration={duration})

ref_path = {ref_arg}
try:
    if ref_path and os.path.exists(ref_path):
        melody, sr = torchaudio.load(ref_path)
        wav = model.generate_with_chroma(["{prompt}"], melody[None], sr)
    else:
        wav = model.generate(["{prompt}"])
except Exception as e:
    print(f"ERROR:Генерация: {{e}}", flush=True)
    sys.exit(1)

print("PROGRESS:85:Сохранение файла...", flush=True)

try:
    audio = wav[0].cpu()
    torchaudio.save("{output}", audio, model.sample_rate)
except Exception as e:
    print(f"ERROR:Сохранение: {{e}}", flush=True)
    sys.exit(1)

actual_duration = audio.shape[-1] / model.sample_rate
print(f"DURATION:{{actual_duration:.2f}}", flush=True)
print("PROGRESS:100:Готово!", flush=True)
"#,
        model    = model,
        duration = duration,
        prompt   = prompt.replace('"', "'"),
        ref_arg  = ref_arg,
        output   = out_path_str.replace('\\', "/"),
    );

    emit_progress(&window, 2.0, "Запуск AudioCraft...");

    let mut child = new_cmd(&python)
        .args(["-c", &script])
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Не удалось запустить Python: {}", e))?;

    let stdout = child.stdout.take().expect("no stdout");
    let stderr = child.stderr.take().expect("no stderr");

    // Читаем stderr в отдельном потоке чтобы не блокировал процесс
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        reader.lines()
            .filter_map(|l| l.ok())
            .collect::<Vec<_>>()
            .join("\n")
    });

    let reader = BufReader::new(stdout);
    let mut actual_duration = duration;
    let mut last_error = String::new();

    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        if let Some(rest) = line.strip_prefix("PROGRESS:") {
            let parts: Vec<&str> = rest.splitn(2, ':').collect();
            if parts.len() == 2 {
                let pct: f64 = parts[0].parse().unwrap_or(0.0);
                emit_progress(&window, pct, parts[1]);
            }
        } else if let Some(d) = line.strip_prefix("DURATION:") {
            actual_duration = d.trim().parse().unwrap_or(duration);
        } else if let Some(err) = line.strip_prefix("ERROR:") {
            last_error = err.to_string();
            append_log(&app, "ERROR", "audiocraft_script", err);
        }
    }

    let stderr_output = stderr_thread.join().unwrap_or_default();
    if !stderr_output.is_empty() {
        append_log(&app, "ERROR", "audiocraft_stderr", &stderr_output);
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        // Показываем наиболее полезный контекст ошибки
        let detail = if !last_error.is_empty() {
            last_error
        } else if !stderr_output.is_empty() {
            // Последние 3 строки stderr — обычно там суть
            stderr_output.lines()
                .filter(|l| !l.trim().is_empty())
                .collect::<Vec<_>>()
                .iter().rev().take(3).rev()
                .cloned().collect::<Vec<_>>()
                .join(" | ")
        } else {
            format!("код {}", status.code().unwrap_or(-1))
        };
        return Err(format!("AudioCraft: {}", detail));
    }

    if !out_path.exists() {
        return Err("AudioCraft не создал аудио файл".to_string());
    }

    append_log(&app, "INFO", "audiocraft_done",
        &format!("job_id={} output={}", job_id, out_path_str));

    Ok(AudioCraftResult {
        output_path: out_path_str,
        duration: actual_duration,
    })
}