import React, { useState, useCallback, useEffect } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

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

  const run = useCallback(async (inputPath, outputPath, args) => {
    setState('running')
    setProgress(0)
    setError(null)
    const jobId = `job-${Date.now()}`

    const unlisten = await listen('ffmpeg-progress', ({ payload }) => {
      if (payload.job_id !== jobId) return
      setProgress(payload.percent)
      setSpeed(payload.speed)
      setFps(payload.fps)
      if (payload.done) {
        unlisten()
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
        args: { input: inputPath, output: outputPath, args, job_id: jobId }
      })
    } catch (e) {
      setState('error')
      setError(String(e))
      unlisten()
    }
  }, [])

  const reset = useCallback(() => {
    setState('idle')
    setProgress(0)
    setError(null)
  }, [])

  return { state, progress, speed, fps, error, run, reset }
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────
export async function saveOutput(defaultName, filters) {
  return save({ defaultPath: defaultName, filters })
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
          <span style={{ color: 'var(--ios-red)', fontSize: 12 }}>{error}</span>
          <button className="btn btn-secondary" onClick={onReset}>Сброс</button>
        </div>
      )}
      {state === 'idle' && (
        <button className="btn btn-primary" onClick={onConvert} disabled={disabled} style={{ width: '100%' }}>
          ▶ Конвертировать
        </button>
      )}
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
          <div className="drop-zone-icon">📂</div>
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

export function SliderRow({ label, hint, min, max, step = 1, value, onChange, unit = '' }) {
  return (
    <div className="row">
      <div>
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="slider-wrap">
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))} />
        <span className="slider-val">{value}{unit}</span>
      </div>
    </div>
  )
}