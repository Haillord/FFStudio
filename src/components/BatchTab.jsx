import { useState, useCallback, useRef } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { formatSize, formatDuration } from './shared'

const STATUS_LABEL = {
  waiting: { text: 'Ожидание',   cls: 'badge-gray' },
  running: { text: 'В процессе', cls: 'badge-blue' },
  done:    { text: 'Готово',     cls: 'badge-green' },
  error:   { text: 'Ошибка',     cls: 'badge-red' },
}

const CODEC_FOR_FMT = {
  mp4: 'libx264', mkv: 'libx264', avi: 'libx264', webm: 'libvpx-vp9'
}

let jobCounter = 0
function makeId() { return `batch-${Date.now()}-${jobCounter++}` }

export default function BatchTab({ settings }) {
  const [queue, setQueue]     = useState([])
  const [outputDir, setOutputDir] = useState('')
  const [fmt, setFmt]         = useState('mp4')
  const [crf, setCrf]         = useState(23)
  const [running, setRunning] = useState(false)
  const queueRef = useRef(queue)

  // Keep ref in sync so listener always sees latest queue
  const updateQueue = (fn) => {
    setQueue(prev => {
      const next = fn(prev)
      queueRef.current = next
      return next
    })
  }

  const updateItem = useCallback((id, patch) => {
    updateQueue(q => q.map(item => item.id === id ? { ...item, ...patch } : item))
  }, [])

  const vcodec = CODEC_FOR_FMT[fmt] ?? 'libx264'

  const addFiles = async () => {
    const paths = await open({
      multiple: true,
      filters: [{ name: 'Видео', extensions: ['mp4','mkv','avi','mov','webm','ts','flv'] }],
    })
    if (!paths) return
    const newItems = (Array.isArray(paths) ? paths : [paths]).map(path => ({
      id: makeId(),
      path,
      name: path.split(/[\\/]/).pop(),
      status: 'waiting',
      progress: 0,
      error: null,
    }))
    updateQueue(q => [...q, ...newItems])
  }

  const removeItem = (id) => updateQueue(q => q.filter(i => i.id !== id))
  const clearDone  = ()  => updateQueue(q => q.filter(i => i.status !== 'done'))

  const pickOutputDir = async () => {
    const dir = await open({ directory: true, multiple: false })
    if (dir) setOutputDir(typeof dir === 'string' ? dir : dir[0])
  }

  const runAll = async () => {
    if (!outputDir) { alert('Укажите папку вывода'); return }
    setRunning(true)

    const waitingItems = queueRef.current.filter(i => i.status === 'waiting')

    const unlisten = await listen('ffmpeg-progress', ({ payload }) => {
      if (payload.done) {
        updateItem(payload.job_id, {
          status: payload.error ? 'error' : 'done',
          progress: payload.error ? 0 : 100,
          error: payload.error || null,
        })
      } else {
        updateItem(payload.job_id, { status: 'running', progress: payload.percent })
      }
    })

    for (const item of waitingItems) {
      updateItem(item.id, { status: 'running', progress: 0 })
      const baseName = item.name.replace(/\.[^.]+$/, '')
      const outPath = `${outputDir}\\${baseName}_converted.${fmt}`
      const args = vcodec === 'copy'
        ? ['-vcodec', 'copy', '-acodec', 'copy']
        : ['-vcodec', vcodec, '-crf', String(crf), '-acodec', fmt === 'webm' ? 'libopus' : 'aac', '-movflags', '+faststart']

      try {
        await invoke('convert', {
          args: { input: item.path, output: outPath, args, job_id: item.id }
        })
      } catch (e) {
        updateItem(item.id, { status: 'error', error: String(e) })
      }
    }

    unlisten()
    setRunning(false)
  }

  const waiting = queue.filter(i => i.status === 'waiting').length
  const done    = queue.filter(i => i.status === 'done').length
  const errors  = queue.filter(i => i.status === 'error').length
  const inprog  = queue.filter(i => i.status === 'running').length

  return (
    <div className="content">
      {queue.length > 0 && (
        <div style={{ display: 'flex', gap: 8 }}>
          {waiting > 0 && <span className="badge badge-gray">{waiting} ожидает</span>}
          {inprog > 0  && <span className="badge badge-blue">{inprog} в процессе</span>}
          {done > 0    && <span className="badge badge-green">{done} готово</span>}
          {errors > 0  && <span className="badge badge-red">{errors} ошибок</span>}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Очередь ({queue.length} файлов)</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {done > 0 && (
              <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={clearDone}>
                Убрать готовые
              </button>
            )}
            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={addFiles}>
              + Добавить
            </button>
          </div>
        </div>
        {queue.length === 0 ? (
          <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
            Нет файлов. Нажмите «Добавить».
          </div>
        ) : (
          queue.map(item => (
            <QueueRow key={item.id} item={item} onRemove={() => removeItem(item.id)} />
          ))
        )}
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Настройки пакета</span></div>
        <div className="row">
          <div className="row-label">Папка вывода</div>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={pickOutputDir}>
            {outputDir ? outputDir.split(/[\\/]/).pop() : 'Выбрать...'}
          </button>
        </div>
        <div className="row">
          <div className="row-label">Формат вывода</div>
          <select className="ios-select" value={fmt} onChange={e => setFmt(e.target.value)}>
            {['mp4','mkv','webm','avi'].map(f => (
              <option key={f} value={f}>{f.toUpperCase()}</option>
            ))}
          </select>
        </div>
        <div className="row">
          <div><div className="row-label">Качество (CRF)</div><div className="row-hint">Меньше = лучше</div></div>
          <div className="slider-wrap">
            <input type="range" min={0} max={51} step={1} value={crf}
              onChange={e => setCrf(Number(e.target.value))} />
            <span className="slider-val">{crf}</span>
          </div>
        </div>
      </div>

      <button
        className="btn btn-primary"
        onClick={runAll}
        disabled={running || waiting === 0}
        style={{ width: '100%', justifyContent: 'center', padding: '12px', fontSize: 15 }}
      >
        {running ? '⏳ Конвертация...' : `▶ Запустить (${waiting} файлов)`}
      </button>
    </div>
  )
}

function QueueRow({ item, onRemove }) {
  const { text, cls } = STATUS_LABEL[item.status] ?? STATUS_LABEL.waiting
  return (
    <div className="queue-item">
      <div className="queue-thumb">🎬</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="queue-name">{item.name}</div>
        {item.error
          ? <div className="queue-meta" style={{ color: 'var(--ios-red)' }}>{item.error}</div>
          : <div className="queue-meta">{item.path}</div>
        }
        {(item.status === 'running' || item.status === 'done') && (
          <div className="progress-bar">
            <div className={`progress-fill${item.status === 'done' ? ' done' : ''}`}
              style={{ width: `${item.progress}%` }} />
          </div>
        )}
      </div>
      <span className={`badge ${cls}`}>{text}</span>
      {item.status !== 'running' && (
        <button className="btn-icon" onClick={onRemove} style={{ fontSize: 13 }}>✕</button>
      )}
    </div>
  )
}