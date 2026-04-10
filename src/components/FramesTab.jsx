import { useState, useMemo } from 'react'
import {
  useFile, saveOutput,
  Chip, SliderRow, SelectRow, ToggleRow,
  CmdPreview, FileDropZone,
} from './shared'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const FRAME_FORMATS = ['PNG', 'JPG', 'WebP']
const EXTRACT_MODES = [
  { label: 'Один кадр', value: 'single' },
  { label: 'Каждые N секунд', value: 'interval' },
  { label: 'Все кадры', value: 'all' },
]

export default function FramesTab({ settings }) {
  const { file, pickFile, loadFileInfo, clearFile } = useFile()

  const [state, setState]       = useState('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError]       = useState(null)

  const [fmt, setFmt]           = useState('PNG')
  const [mode, setMode]         = useState('single')
  const [timeAt, setTimeAt]     = useState(0)
  const [interval, setInterval] = useState(1)
  const [quality, setQuality]   = useState(90)
  const [outputDir, setOutputDir] = useState('')
  const [scale, setScale]       = useState('original')
  const [previewSrc, setPreviewSrc] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const duration = file?.info?.duration ?? 0

  const reset = () => {
    setState('idle')
    setProgress(0)
    setError(null)
  }

  const pickOutputDir = async () => {
    const dir = await open({ directory: true, multiple: false })
    if (dir) setOutputDir(typeof dir === 'string' ? dir : dir[0])
  }

  const handlePreview = async () => {
    if (!file) return
    setPreviewLoading(true)
    try {
      const vfString = scale !== 'original' ? `scale=${scale}:-1` : ''
      const tmpPath = await invoke('preview_frame', {
        input: file.path,
        time: timeAt,
        vfArgs: vfString,
      })
      const base64 = await invoke('read_file_base64', { path: tmpPath })
      setPreviewSrc(`data:image/jpeg;base64,${base64}`)
    } catch (e) {
      console.error(e)
    }
    setPreviewLoading(false)
  }

  const ffArgs = useMemo(() => {
    const args = []

    if (mode === 'single') {
      args.push('-ss', timeAt.toFixed(2))
      args.push('-vframes', '1')
    } else if (mode === 'interval') {
      args.push('-vf', `fps=1/${interval}`)
    } else {
      args.push('-vf', 'fps=source_fps')
    }

    if (scale !== 'original') {
      const existing = args.findIndex(a => a === '-vf')
      if (existing !== -1) {
        args[existing + 1] = args[existing + 1] + `,scale=${scale}:-1`
      } else {
        args.push('-vf', `scale=${scale}:-1`)
      }
    }

    if (fmt === 'JPG') {
      args.push('-q:v', String(Math.round((100 - quality) / 100 * 31 + 1)))
    } else if (fmt === 'WebP') {
      args.push('-q:v', String(quality))
    }

    return args
  }, [mode, timeAt, interval, fmt, quality, scale])

  const outputPattern = useMemo(() => {
    const dir = outputDir || 'выбранная_папка'
    const ext = fmt.toLowerCase()
    if (mode === 'single') return `${dir}\\frame.${ext}`
    return `${dir}\\frame_%04d.${ext}`
  }, [outputDir, fmt, mode])

  const cmd = useMemo(() => {
    if (!file) return 'ffmpeg -i input.mp4 ...'
    const ext = fmt.toLowerCase()
    const pattern = mode === 'single' ? `frame.${ext}` : `frame_%04d.${ext}`
    return `ffmpeg -y -i "${file.name}" ${ffArgs.join(' ')} "${pattern}"`
  }, [file, ffArgs, fmt, mode])

  const handleExtract = async () => {
    if (!file) return
    if (!outputDir) { alert('Укажите папку вывода'); return }

    const ext = fmt.toLowerCase()
    const pattern = mode === 'single'
      ? `${outputDir}\\frame.${ext}`
      : `${outputDir}\\frame_%04d.${ext}`

    const jobId = `frames-${Date.now()}`
    setState('running')
    setProgress(0)
    setError(null)

    const unlisten = await listen('ffmpeg-progress', ({ payload }) => {
      if (payload.job_id !== jobId) return
      setProgress(payload.percent)
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
        args: {
          input: file.path,
          output: pattern,
          args: ffArgs,
          job_id: jobId,
        }
      })
    } catch (e) {
      setState('error')
      setError(String(e))
      unlisten()
    }
  }

  return (
    <div className="content">
      <FileDropZone
        file={file}
        onPick={() => pickFile([{ name: 'Видео', extensions: ['mp4','mkv','avi','mov','webm','ts','flv'] }])}
        onClear={clearFile}
        onDropPath={loadFileInfo}
        accept="MP4, MKV, AVI, MOV, WebM"
      />

      <div className="card">
        <div className="card-header"><span className="card-title">Режим извлечения</span></div>
        <div className="chip-row">
          {EXTRACT_MODES.map(m => (
            <Chip key={m.value} label={m.label} sel={mode === m.value} onClick={() => setMode(m.value)} />
          ))}
        </div>
      </div>

      {mode === 'single' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Момент времени</span>
            {file && (
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12 }}
                onClick={handlePreview}
                disabled={previewLoading}
              >
                {previewLoading ? '⏳ Загрузка...' : '👁 Предпросмотр'}
              </button>
            )}
          </div>
          <div className="row">
            <div>
              <div className="row-label">Время (сек)</div>
              {duration > 0 && <div className="row-hint">Длина: {duration.toFixed(1)} сек</div>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={timeAt}
                onChange={e => setTimeAt(Number(e.target.value))}
                style={{ width: 200 }}
              />
              <input
                type="number"
                className="ios-input"
                min={0}
                step={0.1}
                value={timeAt}
                onChange={e => setTimeAt(Number(e.target.value))}
                style={{ width: 80 }}
              />
            </div>
          </div>
          {previewSrc && (
            <div style={{ padding: '0 16px 16px' }}>
              <img
                src={previewSrc}
                alt="preview"
                style={{
                  width: '100%',
                  maxHeight: '350px',
                  objectFit: 'contain',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  display: 'block',
                  margin: '0 auto'
                }}
              />
            </div>
          )}
        </div>
      )}

      {mode === 'interval' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Интервал</span></div>
          <SliderRow label="Каждые N секунд" min={1} max={60} step={1}
            value={interval} onChange={setInterval} unit=" сек" />
          {duration > 0 && (
            <div className="row">
              <div className="row-label">Примерно кадров</div>
              <span className="badge badge-blue">{Math.floor(duration / interval)}</span>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header"><span className="card-title">Формат</span></div>
        <div className="chip-row">
          {FRAME_FORMATS.map(f => (
            <Chip key={f} label={f} sel={fmt === f} onClick={() => setFmt(f)} />
          ))}
        </div>
        {(fmt === 'JPG' || fmt === 'WebP') && (
          <SliderRow label="Качество" min={1} max={100} step={1}
            value={quality} onChange={setQuality} unit="%" />
        )}
        <SelectRow label="Масштаб" value={scale} onChange={setScale}
          options={[
            { label: 'Оригинал', value: 'original' },
            { label: '1920px', value: '1920' },
            { label: '1280px', value: '1280' },
            { label: '854px', value: '854' },
            { label: '640px', value: '640' },
          ]} />
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Вывод</span></div>
        <div className="row">
          <div className="row-label">Папка</div>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={pickOutputDir}>
            {outputDir ? outputDir.split(/[\\/]/).pop() : 'Выбрать...'}
          </button>
        </div>
        {outputDir && (
          <div className="row">
            <div className="row-label">Файлы</div>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{outputPattern}</span>
          </div>
        )}
      </div>

      <CmdPreview cmd={cmd} />

      <div className="card" style={{ padding: 16 }}>
        {state === 'running' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Извлечение...</div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        {state === 'done' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--ios-green)', fontSize: 13, fontWeight: 500 }}>✓ Готово!</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={() => invoke('open_in_explorer', { path: outputDir })}>
                Открыть папку
              </button>
              <button className="btn btn-secondary" onClick={reset}>Ещё раз</button>
            </div>
          </div>
        )}
        {state === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ color: 'var(--ios-red)', fontSize: 12 }}>{error}</span>
            <button className="btn btn-secondary" onClick={reset}>Сброс</button>
          </div>
        )}
        {state === 'idle' && (
          <button className="btn btn-primary" onClick={handleExtract}
            disabled={!file || !outputDir} style={{ width: '100%', justifyContent: 'center', padding: 12 }}>
            ▶ Извлечь кадры
          </button>
        )}
      </div>
    </div>
  )
}