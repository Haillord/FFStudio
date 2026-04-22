import React, { useState, useCallback, useEffect } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const APP_TOAST_EVENT = 'ffstudio:toast'
const APP_CONFIRM_EVENT = 'ffstudio:confirm'
const APP_CONFIRM_RESPONSE_EVENT = 'ffstudio:confirm-response'
let toastCounter = 0
let confirmCounter = 0

export function formatUserError(err, fallback = 'Произошла ошибка') {
  const text = String(err ?? '').trim()
  if (!text) return fallback
  const cleaned = text
    .replace(/^Error:\s*/i, '')
    .replace(/\s*\(.*?stack.*?\)\s*/gi, ' ')
    .trim()
  const lower = cleaned.toLowerCase()

  if (lower.includes('video_generation_not_implemented')) {
    return 'Генерация видео пока не реализована в этой сборке. Сейчас работает только генерация изображений через ComfyUI.'
  }
  if (lower.includes('missing_comfy_nodes:')) {
    const list = cleaned.split(':').slice(1).join(':').trim()
    return `В ComfyUI не найдены нужные ноды: ${list}.\n\nУстановите кастом-ноды AnimateDiff (ArtVentureX/comfyui-animatediff) через ComfyUI Manager и перезапустите ComfyUI.`
  }
  if (lower.includes('missing_motion_modules:')) {
    return 'AnimateDiff установлен, но motion-модули не найдены. Скачайте motion module (например `mm_sd_v15_v2.ckpt`) и положите в папку моделей AnimateDiff, затем перезапустите ComfyUI.'
  }
  if (lower.includes('motion_module_not_found:')) {
    return `Выбранный motion module не найден в ComfyUI.\n\n${cleaned}`
  }
  if (lower.includes('comfyui завершил задачу, но не вернул файл')) {
    return 'ComfyUI завершил задачу, но не вернул видеофайл. Проверьте, что установлен AnimateDiff для ComfyUI и что нода AnimateDiffCombine доступна (а также ffmpeg в PATH для mp4).'
  }
  if (lower.includes('animatediff') && lower.includes('not found')) {
    return 'Не найдены ноды AnimateDiff в ComfyUI. Установите кастом-ноды `comfyui-animatediff` (через ComfyUI Manager) и перезапустите ComfyUI.'
  }
  if (lower.includes('ffmpeg не найден') || lower.includes('ffmpeg not found')) {
    return 'FFmpeg не найден. Укажите путь в Настройках или установите FFmpeg в PATH.'
  }
  if (lower.includes('comfyui недоступен') || lower.includes('failed to fetch')) {
    return 'ComfyUI недоступен. Проверьте, что ComfyUI запущен и API URL указан верно в Настройках.'
  }
  if (lower.includes('python не найден')) {
    return 'Python не найден. Установите Python 3.10+ и проверьте путь в Настройках.'
  }
  if (lower.includes('модель не выбрана')) {
    return 'Модель не выбрана. Выберите модель в разделе параметров.'
  }
  if (lower.includes('файл модели не найден')) {
    return 'Файл модели не найден. Обновите список моделей и проверьте папку models.'
  }
  if (lower.includes('main.py не найден')) {
    return 'Папка ComfyUI указана неверно: файл main.py не найден.'
  }

  return cleaned
}

export function PageHeader({ title, subtitle }) {
  return (
    <header className="page-header">
      <h1 className="page-header-title">{title}</h1>
      {subtitle ? <p className="page-header-subtitle">{subtitle}</p> : null}
    </header>
  )
}

function emitAppEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function showToast(message, options = {}) {
  const text = String(message ?? '').trim()
  if (!text) return
  emitAppEvent(APP_TOAST_EVENT, {
    id: `toast-${Date.now()}-${toastCounter++}`,
    message: text,
    tone: options.tone ?? 'info',
    duration: options.duration ?? 4200,
  })
}

export function showErrorToast(err, fallback = 'Произошла ошибка') {
  showToast(formatUserError(err, fallback), { tone: 'error', duration: 5200 })
}

export function requestConfirmation({
  title = 'Подтверждение',
  message,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  tone = 'danger',
} = {}) {
  return new Promise((resolve) => {
    const id = `confirm-${Date.now()}-${confirmCounter++}`
    const onResponse = (event) => {
      if (event.detail?.id !== id) return
      window.removeEventListener(APP_CONFIRM_RESPONSE_EVENT, onResponse)
      resolve(Boolean(event.detail?.confirmed))
    }
    window.addEventListener(APP_CONFIRM_RESPONSE_EVENT, onResponse)
    emitAppEvent(APP_CONFIRM_EVENT, {
      id,
      title,
      message: String(message ?? '').trim(),
      confirmLabel,
      cancelLabel,
      tone,
    })
  })
}

function parseByDefault(raw, defaultValue) {
  if (raw == null) return defaultValue
  if (typeof defaultValue === 'number') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : defaultValue
  }
  if (typeof defaultValue === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return defaultValue
  }
  if (typeof defaultValue === 'string') return raw
  if (Array.isArray(defaultValue) || (defaultValue && typeof defaultValue === 'object')) {
    try {
      const parsed = JSON.parse(raw)
      return parsed ?? defaultValue
    } catch {
      return defaultValue
    }
  }
  return defaultValue
}

export function useTabState(tabKey, defaults, legacyKeys = {}) {
  const storageKey = `tab_state:${tabKey}`
  const [state, setState] = useState(() => {
    const base = { ...defaults }
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed && typeof parsed === 'object') {
          return { ...base, ...parsed }
        }
      }
    } catch {}

    const migrated = { ...base }
    for (const [field, legacyKey] of Object.entries(legacyKeys)) {
      const raw = localStorage.getItem(legacyKey)
      if (raw == null) continue
      migrated[field] = parseByDefault(raw, base[field])
    }
    return migrated
  })

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(state))
  }, [storageKey, state])

  const patchState = useCallback((partial) => {
    setState(prev => ({ ...prev, ...partial }))
  }, [])

  return { state, setState, patchState }
}

// ─── useFile: логика выбора файла и инфо ─────────────────────────────────────
export function useFile() {
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)

  const loadFileInfo = useCallback(async (path) => {
    setLoading(true)
    const name = path.split(/[\\/]/).pop()
    try {
      const info = await invoke('get_media_info', { input: path, ffprobePath: '' })
      setFile({ path, name, info })
    } catch (e) {
      console.error("FFprobe error:", e)
      showErrorToast(e, 'Не удалось прочитать информацию о файле')
      setFile({ path, name, info: null })
    }
    setLoading(false)
  }, [])

  const pickFile = useCallback(async (filters = []) => {
    const path = await open({ filters, multiple: false })
    if (path) await loadFileInfo(path)
  }, [loadFileInfo])

  const clearFile = useCallback(() => setFile(null), [])

  return { file, pickFile, loadFileInfo, clearFile, loading }
}

// ─── useConvert: прогресс и запуск FFmpeg ────────────────────────────────────
export function useConvert() {
  const [state, setState] = useState('idle') 
  const [progress, setProgress] = useState(0)
  const [speed, setSpeed] = useState(0)
  const [fps, setFps] = useState(0)
  const [error, setError] = useState(null)
  const [jobId, setJobId] = useState(null)

  const run = useCallback(async (inputPath, outputPath, args) => {
    setState('running')
    setProgress(0)
    setError(null)
    const nextJobId = `job-${Date.now()}`
    setJobId(nextJobId)

    const unlisten = await listen('ffmpeg-progress', ({ payload }) => {
      if (payload.job_id !== nextJobId) return
      setProgress(payload.percent)
      setSpeed(payload.speed)
      setFps(payload.fps)
      if (payload.done) {
        unlisten()
        setJobId(null)
        if (payload.error) {
          setState('error')
          setError(payload.error)
        } else {
          setState('done')
          setProgress(100)
        }
      }
    })

    try {
      await invoke('convert', {
        args: { input: inputPath, output: outputPath, args, job_id: nextJobId }
      })
    } catch (e) {
      setState('error')
      setError(formatUserError(e, 'Не удалось запустить конвертацию'))
      setJobId(null)
      unlisten()
    }
  }, [])

  const cancel = useCallback(async () => {
    if (jobId) {
      await invoke('cancel_job', { jobId }).catch(() => {})
    }
    setJobId(null)
    setState('idle')
    setProgress(0)
    setError(null)
    setSpeed(0)
    setFps(0)
  }, [jobId])

  const reset = useCallback(() => {
    setJobId(null)
    setState('idle')
    setProgress(0)
    setError(null)
    setSpeed(0)
    setFps(0)
  }, [])

  return { state, progress, speed, fps, error, run, reset, cancel }
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────
export async function saveOutput(defaultName, filters) {
  return save({ defaultPath: defaultName, filters })
}

function splitStemAndExt(fileName) {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return { stem: fileName, ext: '' }
  return {
    stem: fileName.slice(0, dot),
    ext: fileName.slice(dot + 1),
  }
}

function joinPath(dir, fileName) {
  if (!dir) return fileName
  const normalized = dir.replace(/[\\/]+$/, '')
  return `${normalized}\\${fileName}`
}

export async function saveOutputUnique({ defaultStem, extension, filters, targetDir = '' }) {
  const ext = String(extension || '').replace(/^\./, '')
  const suggested = joinPath(targetDir, `${defaultStem}_001.${ext}`)
  const defaultPath = await invoke('next_available_path', { path: suggested }).catch(() => suggested)
  const selected = await save({ defaultPath, filters })
  if (!selected) return null

  let outPath = Array.isArray(selected) ? selected[0] : selected
  if (!outPath) return null
  if (ext && !outPath.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    outPath = `${outPath}.${ext}`
  }

  const exists = await invoke('file_exists', { path: outPath }).catch(() => false)
  if (!exists) return outPath

  const overwrite = await requestConfirmation({
    title: 'Файл уже существует',
    message: 'Перезаписать существующий файл?',
    confirmLabel: 'Перезаписать',
    cancelLabel: 'Создать новый',
  })
  if (overwrite) return outPath

  const fileName = outPath.split(/[\\/]/).pop() || `output.${ext}`
  const dir = outPath.slice(0, Math.max(0, outPath.length - fileName.length)).replace(/[\\/]$/, '')
  const { stem } = splitStemAndExt(fileName)
  const fallback = joinPath(dir, `${stem}.${ext}`)
  return invoke('next_available_path', { path: fallback }).catch(() => null)
}

export function formatSize(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`
}

export function formatDuration(sec) {
  if (!sec) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  return `${m}:${String(s).padStart(2,'0')}`
}

// ─── UI Компоненты ───────────────────────────────────────────────────────────

export function Toggle({ on, onChange }) {
  return <button className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)} type="button" />
}

export function Chip({ label, sel, onClick }) {
  return <div className={`chip${sel ? ' sel' : ''}`} onClick={onClick}>{label}</div>
}

export function ToggleRow({ label, hint, on, onChange }) {
  return (
    <div className="row">
      <div>
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  )
}

export function ProgressBar({ percent, state }) {
  return (
    <div className="progress-bar">
      <div className={`progress-fill ${state === 'error' ? 'error' : ''}`} style={{ width: `${percent}%` }} />
    </div>
  )
}

export function ConvertFooter({ state, progress, speed, fps, error, onConvert, onReset, disabled }) {
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {state === 'running' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {Math.round(progress)}% · {fps > 0 ? `${fps.toFixed(0)} fps` : ''} · {speed > 0 ? `${speed.toFixed(1)}x` : ''}
            </span>
            <button className="btn btn-danger" onClick={onReset}>Отмена</button>
          </div>
          <ProgressBar percent={progress} state={state} />
        </>
      )}
      {state === 'done' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--ios-green)', fontSize: 13, fontWeight: 500 }}>✓ Готово!</span>
          <button className="btn btn-secondary" onClick={onReset}>Ещё раз</button>
        </div>
      )}
      {state === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <InlineError message={error} compact />
          <button className="btn btn-secondary" onClick={onReset}>Сброс</button>
        </div>
      )}
      {state === 'idle' && (
        <button className="btn btn-primary" onClick={onConvert} disabled={disabled} style={{ width: '100%' }}>
          Конвертировать
        </button>
      )}
    </div>
  )
}

export function InlineError({ message, compact = false }) {
  const [copied, setCopied] = useState(false)
  if (!message) return null

  const copy = async () => {
    await navigator.clipboard.writeText(String(message))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`inline-error${compact ? ' compact' : ''}`}>
      <div className="inline-error-head">
        <span className="inline-error-title">Ошибка</span>
        <button className="btn btn-secondary" onClick={copy} style={{ padding: '4px 8px', fontSize: 11 }}>
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <div className="inline-error-body">{message}</div>
    </div>
  )
}

export function CmdPreview({ cmd }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Команда FFmpeg</span>
        <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={copy}>
          {copied ? '✓ Скопировано' : 'Скопировать'}
        </button>
      </div>
      <div style={{ padding: '12px 16px' }}><div className="cmd-preview">{cmd}</div></div>
    </div>
  )
}

export function ToastViewport() {
  const [toasts, setToasts] = useState([])
  const [copiedId, setCopiedId] = useState(null)

  useEffect(() => {
    const onToast = (event) => {
      const toast = event.detail
      if (!toast?.id) return
      setToasts(prev => [...prev, toast])
      const duration = toast.tone === 'error' ? 12000 : (toast.duration ?? 4200)
      const timeout = window.setTimeout(() => {
        setToasts(prev => prev.filter(item => item.id !== toast.id))
      }, duration)
      return () => window.clearTimeout(timeout)
    }

    window.addEventListener(APP_TOAST_EVENT, onToast)
    return () => window.removeEventListener(APP_TOAST_EVENT, onToast)
  }, [])

  const copyToast = async (id, message) => {
    await navigator.clipboard.writeText(String(message))
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast-item toast-${toast.tone ?? 'info'}`} style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div className="toast-message" style={{ userSelect: 'text', whiteSpace: 'pre-line', maxHeight: '40vh', overflow: 'auto' }}>
              {toast.message}
            </div>
            <button
              className="toast-close"
              type="button"
              onClick={() => setToasts(prev => prev.filter(item => item.id !== toast.id))}
              aria-label="Закрыть уведомление"
              style={{ flexShrink: 0 }}
            >
              ×
            </button>
          </div>
          {toast.tone === 'error' && (
            <div style={{ textAlign: 'right' }}>
              <button
                className="btn btn-secondary"
                style={{ padding: '4px 8px', fontSize: 11 }}
                onClick={(e) => { e.stopPropagation(); copyToast(toast.id, toast.message) }}
              >
                {copiedId === toast.id ? 'Скопировано' : 'Копировать ошибку'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function ConfirmDialogHost() {
  const [dialog, setDialog] = useState(null)

  useEffect(() => {
    const onConfirm = (event) => {
      if (!event.detail?.id) return
      setDialog(event.detail)
    }
    window.addEventListener(APP_CONFIRM_EVENT, onConfirm)
    return () => window.removeEventListener(APP_CONFIRM_EVENT, onConfirm)
  }, [])

  const respond = (confirmed) => {
    if (!dialog?.id) return
    emitAppEvent(APP_CONFIRM_RESPONSE_EVENT, { id: dialog.id, confirmed })
    setDialog(null)
  }

  if (!dialog) return null

  return (
    <div className="confirm-overlay" role="presentation" onClick={() => respond(false)}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="confirm-title" id="confirm-dialog-title">{dialog.title}</div>
        <div className="confirm-message">{dialog.message}</div>
        <div className="confirm-actions">
          <button className="btn btn-secondary" type="button" onClick={() => respond(false)}>
            {dialog.cancelLabel || 'Отмена'}
          </button>
          <button
            className={`btn ${dialog.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            type="button"
            onClick={() => respond(true)}
          >
            {dialog.confirmLabel || 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function FileDropZone({ file, onPick, onClear, onDropPath, accept }) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let unlistenDrop, unlistenEnter, unlistenLeave;
    const setup = async () => {
      unlistenDrop = await listen("tauri://drop", (event) => {
        console.log('DROP EVENT FULL:', JSON.stringify(event))
        setDragging(false);
        const paths = event.payload?.paths ?? event.payload;
        if (Array.isArray(paths) && paths[0]) onDropPath(paths[0]);
        else if (typeof paths === 'string') onDropPath(paths);
      });
      unlistenEnter = await listen("tauri://drop-hover", (event) => {
        console.log('HOVER FULL:', JSON.stringify(event))
        setDragging(true)
      })
      unlistenLeave = await listen("tauri://drop-cancelled", () => setDragging(false));
    };
    setup();
    return () => {
      if (unlistenDrop) unlistenDrop();
      if (unlistenEnter) unlistenEnter();
      if (unlistenLeave) unlistenLeave();
    };
  }, [onDropPath]);

  return (
    <div 
      className={`drop-zone ${dragging ? 'drag-over' : ''} ${file ? 'has-file' : ''}`}
      onClick={() => !file && onPick()}
    >
      {file ? (
        <div className="file-info-zone">
          <div className="drop-zone-icon">🎬</div>
          <div className="drop-zone-title">{file.name}</div>
          <button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); onClear(); }}>Удалить</button>
        </div>
      ) : (
        <>
          <div className="drop-zone-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 16V6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M8.5 9.5L12 6l3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 18.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </div>
          <div className="drop-zone-title">Выберите файл</div>
          <div className="drop-zone-sub">{accept}</div>
        </>
      )}
    </div>
  );
}
// ─── Недостающие компоненты для VideoTab ─────────────────────────────────────

export function SelectRow({ label, hint, value, onChange, options }) {
  return (
    <div className="row">
      <div>
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <select className="ios-select" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => (
          <option key={o.value ?? o} value={o.value ?? o}>
            {o.label ?? o}
          </option>
        ))}
      </select>
    </div>
  )
}

function formatSliderValue(value, step) {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value ?? '')
  const stepText = String(step ?? 1)
  const decimalPart = stepText.includes('.') ? stepText.split('.')[1] : ''
  const decimals = Math.min(6, decimalPart.length)
  if (decimals <= 0) return String(Math.round(n))
  return n.toFixed(decimals).replace(/\.?0+$/, '')
}

export function SliderRow({ label, hint, min, max, step = 1, value, onChange, unit = '' }) {
  const shownValue = formatSliderValue(value, step)
  return (
    <div className="row">
      <div>
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="slider-wrap">
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))} />
        <span className="slider-val">{shownValue}{unit}</span>
      </div>
    </div>
  )
}

