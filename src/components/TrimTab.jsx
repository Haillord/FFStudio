import { useState, useMemo, useEffect } from 'react'
import {
  useFile, useConvert, useTabState, saveOutputUnique,
  ToggleRow, ConvertFooter, CmdPreview, FileDropZone,
  formatDuration, PageHeader,
} from './shared'

export default function TrimTab({ settings }) {
  const { file, pickFile, loadFileInfo, clearFile } = useFile()
  const { state, progress, speed, fps, error, run, reset, cancel } = useConvert()
  const { state: persistedTrim, patchState: patchTabState } = useTabState('trim', {
    startTime: 0, endTime: 0, noReencode: true,
  })

  const [startTime, setStart] = useState(persistedTrim.startTime)
  const [endTime, setEnd]     = useState(persistedTrim.endTime)
  const [noReencode, setNoRe] = useState(persistedTrim.noReencode)
  useEffect(() => {
    patchTabState({ startTime, endTime, noReencode })
  }, [startTime, endTime, noReencode])

  const duration = file?.info?.duration ?? 0

  const ffArgs = useMemo(() => {
    const args = []
    if (startTime > 0) args.push('-ss', startTime.toFixed(2))
    if (endTime > 0 && endTime > startTime) {
      args.push('-to', endTime.toFixed(2))
    }
    if (noReencode) {
      args.push('-c', 'copy')
    }
    return args
  }, [startTime, endTime, noReencode])

  const cmd = useMemo(() => {
    if (!file) return 'ffmpeg -i input.mp4 ...'
    return `ffmpeg -y ${ffArgs.join(' ')} -i "${file.name}" output_trimmed.mp4`
  }, [file, ffArgs])

  const handleConvert = async () => {
    if (!file) return
    const outPath = await saveOutputUnique({
      defaultStem: 'trim',
      extension: 'mp4',
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
      targetDir: settings.outputDir || '',
    })
    if (!outPath) return
    const trimArgs = [...ffArgs]
    run(file.path, outPath, trimArgs)
  }

  const TimeInput = ({ label, value, onChange }) => {
    return (
      <div className="row">
        <div>
          <div className="row-label">{label}</div>
          <div className="row-hint">{formatDuration(value)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.1}
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            style={{ width: 200 }}
          />
          <input
            type="number"
            className="ios-input"
            min={0}
            max={duration || undefined}
            step={0.1}
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            style={{ width: 80 }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="content">

      <FileDropZone
        file={file}
        onPick={() => pickFile([{ name: 'Видео', extensions: ['mp4','mkv','avi','mov','webm'] }])}
        onClear={clearFile}
        onDropPath={loadFileInfo}
        accept="MP4, MKV, AVI, MOV, WebM"
      />

      <div className="card">
        <div className="card-header">
          <span className="card-title">Диапазон обрезки</span>
          {duration > 0 && (
            <span className="badge badge-blue">Длина: {formatDuration(duration)}</span>
          )}
        </div>

        <TimeInput label="Начало (сек)" value={startTime} onChange={setStart} />
        <TimeInput label="Конец (сек)" value={endTime || duration}
          onChange={v => setEnd(v)} />

        <div className="row">
          <div>
            <div className="row-label">Выбранный фрагмент</div>
          </div>
          <span className="badge badge-green">
            {formatDuration((endTime || duration) - startTime)}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Опции</span></div>
        <ToggleRow
          label="Быстрая обрезка (без перекодирования)"
          hint="Использует -c copy. Быстро, но возможно несколько лишних кадров на краях."
          on={noReencode}
          onChange={setNoRe}
        />
      </div>

      <CmdPreview cmd={cmd} />

      <ConvertFooter
        state={state} progress={progress} speed={speed} fps={fps} error={error}
        onConvert={handleConvert} onReset={state === 'running' ? cancel : reset}
        disabled={!file}
      />
    </div>
  )
}

