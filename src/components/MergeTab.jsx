import { useState } from 'react'
import {
  Chip, SelectRow,
  ConvertFooter, CmdPreview, FileDropZone,
} from './shared'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const MERGE_FORMATS = ['MP4', 'MKV', 'MOV', 'TS']

export default function MergeTab({ settings }) {
  const [state, setState] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [speed, setSpeed] = useState(0)
  const [fps, setFps] = useState(0)
  const [error, setError] = useState(null)

  const [files, setFiles] = useState([])
  const [fmt, setFmt] = useState('MP4')
  const [vcodec, setVcodec] = useState('copy')
  const [acodec, setAcodec] = useState('copy')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const reset = () => {
    setState('idle')
    setProgress(0)
    setError(null)
  }

  const pickFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: 'Видео файлы', extensions: ['mp4','mkv','avi','mov','webm','ts','flv'] }]
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    const newItems = paths.map(path => ({ path, name: path.split(/[\\/]/).pop() }))
    setFiles(prev => [...prev, ...newItems])
  }

  const handleDropPath = (path) => {
    const name = path.split(/[\\/]/).pop()
    setFiles(prev => [...prev, { path, name }])
  }

  const removeFile = (index) => {
    const newFiles = files.filter((_, i) => i !== index)
    setFiles(newFiles)
    if (newFiles.length === 0) reset()
  }

  const moveFile = (index, dir) => {
    const newFiles = [...files]
    const newIndex = index + dir
    if (newIndex < 0 || newIndex >= files.length) return
    ;[newFiles[index], newFiles[newIndex]] = [newFiles[newIndex], newFiles[index]]
    setFiles(newFiles)
  }

  const clearAll = () => {
    setFiles([])
    reset()
  }

  const handleMerge = async () => {
    if (files.length < 2) return

    const ext = fmt.toLowerCase()
    const { save } = await import('@tauri-apps/plugin-dialog')
    const outPath = await save({
      defaultPath: `merged.${ext}`,
      filters: [{ name: fmt, extensions: [ext] }]
    })
    if (!outPath) return

    const listContent = files.map(f => `file '${f.path.replace(/\\/g, '/').replace(/'/g, "\\'")}'`).join('\n')

    let listPath
    try {
      listPath = await invoke('write_temp_list', { contents: listContent })
      console.log('listPath:', listPath)
    } catch (e) {
      setError(`Ошибка создания списка: ${e}`)
      setState('error')
      return
    }

    const jobId = `merge-${Date.now()}`
    setState('running')
    setProgress(0)
    setError(null)

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
      await invoke('convert_concat', {
        listPath: listPath,
        output: outPath,
        args: ['-vcodec', vcodec, '-acodec', acodec],
        jobId: jobId,
      })
    } catch (e) {
      setState('error')
      setError(String(e))
      unlisten()
    }
  }

  const cmd = `ffmpeg -f concat -safe 0 -i list.txt -vcodec ${vcodec} -acodec ${acodec} output.${fmt.toLowerCase()}`
  const fakeFile = files.length > 0 ? { name: `${files.length} файл(ов) выбрано`, path: '' } : null

  return (
    <div className="content">
      <FileDropZone
        file={fakeFile}
        onPick={pickFiles}
        onClear={clearAll}
        onDropPath={handleDropPath}
        accept="Выберите видео файлы (можно несколько)"
      />

      {files.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Файлы для склейки ({files.length})</span>
            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={pickFiles}>
              + Добавить
            </button>
          </div>
          {files.map((f, i) => (
            <div key={i} className="queue-item">
              <div className="queue-thumb">🎬</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="queue-name">{f.name}</div>
                <div className="queue-meta">{f.path}</div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn-icon" onClick={() => moveFile(i, -1)} disabled={i === 0}>↑</button>
                <button className="btn-icon" onClick={() => moveFile(i, 1)} disabled={i === files.length - 1}>↓</button>
                <button className="btn-icon" onClick={() => removeFile(i)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-header"><span className="card-title">Формат вывода</span></div>
        <div className="chip-row">
          {MERGE_FORMATS.map(f => (
            <Chip key={f} label={f} sel={fmt === f} onClick={() => setFmt(f)} />
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header clickable" onClick={() => setShowAdvanced(prev => !prev)} style={{ cursor: 'pointer' }}>
          <span className="card-title">⚙️ Дополнительные параметры</span>
          <span style={{ opacity: 0.6 }}>{showAdvanced ? '▲' : '▼'}</span>
        </div>
        {showAdvanced && (
          <div style={{ paddingTop: 8 }}>
            <SelectRow label="Режим кодирования" value={vcodec} onChange={setVcodec}
              options={[
                { label: '🚀 Быстрая склейка (без перекодирования)', value: 'copy' },
                { label: '🎥 Перекодировать H.264', value: 'libx264' },
                { label: '🎞️ Перекодировать H.265', value: 'libx265' },
              ]} />
            <SelectRow label="Аудио" value={acodec} onChange={setAcodec}
              options={[
                { label: 'Копировать', value: 'copy' },
                { label: 'AAC', value: 'aac' },
                { label: 'MP3', value: 'libmp3lame' },
              ]} />
          </div>
        )}
      </div>

      <CmdPreview cmd={cmd} />

      <ConvertFooter
        state={state} progress={progress} speed={speed} fps={fps} error={error}
        onConvert={handleMerge} onReset={reset}
        disabled={files.length < 2}
      />
    </div>
  )
}