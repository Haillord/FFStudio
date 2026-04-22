import { useState, useMemo, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  useFile, useConvert, useTabState, saveOutputUnique,
  Chip, SelectRow, ToggleRow, SliderRow,
  ConvertFooter, CmdPreview, FileDropZone, formatUserError, showErrorToast, PageHeader,
} from './shared'

const OUTPUT_FORMATS = ['GIF', 'WebP', 'APNG']
const DITHER_MODES = [
  { label: 'bayer (быстро)', value: 'bayer' },
  { label: 'floyd_steinberg', value: 'floyd_steinberg' },
  { label: 'sierra2_4a', value: 'sierra2_4a' },
  { label: 'Нет', value: 'none' },
]

export default function GifWebpTab({ settings }) {
  const { file, pickFile, loadFileInfo, clearFile } = useFile()
  const { state, progress, speed, fps, error, run, reset, cancel } = useConvert()
  const { state: persistedGif, patchState: patchTabState } = useTabState('gif_webp', {
    fmt: 'GIF', gifFps: 15, width: 480, quality: 85, loop: true, pingPong: false,
    dither: 'bayer', startTime: 0, duration: 0, optimize: true,
  })

  const [fmt, setFmt]           = useState(persistedGif.fmt)
  const [gifFps, setGifFps]     = useState(persistedGif.gifFps)
  const [width, setWidth]       = useState(persistedGif.width)
  const [quality, setQuality]   = useState(persistedGif.quality)
  const [loop, setLoop]         = useState(persistedGif.loop)
  const [pingPong, setPingPong] = useState(persistedGif.pingPong)
  const [dither, setDither]     = useState(persistedGif.dither)
  const [startTime, setStart]   = useState(persistedGif.startTime)
  const [duration, setDuration] = useState(persistedGif.duration)
  const [optimize, setOptimize] = useState(persistedGif.optimize)
  const [previewSrc, setPreviewSrc] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  useEffect(() => {
    patchTabState({ fmt, gifFps, width, quality, loop, pingPong, dither, startTime, duration, optimize })
  }, [fmt, gifFps, width, quality, loop, pingPong, dither, startTime, duration, optimize])

  const ffArgs = useMemo(() => {
    const args = []

    const getTrimFilter = () => {
      if (pingPong && (startTime > 0 || duration > 0)) {
        const end = duration > 0 ? startTime + duration : ''
        return `trim=${startTime}:${end},setpts=PTS-STARTPTS,`
      }
      if (startTime > 0) args.push('-ss', String(startTime))
      if (duration > 0) args.push('-t', String(duration))
      return ''
    }

    if (fmt === 'GIF') {
      const trimFilter = getTrimFilter()
      const scaleFilter = `fps=${gifFps},scale=${width}:-1:flags=lanczos`
      if (pingPong) {
        args.push('-vf', `${trimFilter}${scaleFilter},split[v1][v2];[v2]reverse[rv];[v1][rv]concat=n=2:v=1,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=${dither}`)
      } else {
        args.push('-vf', `${trimFilter}${scaleFilter},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=${dither}`)
      }
      if (loop) args.push('-loop', '0')
      else args.push('-loop', '-1')
    } else if (fmt === 'WebP') {
      const trimFilter = getTrimFilter()
      const scaleFilter = `fps=${gifFps},scale=${width}:-1:flags=lanczos`
      if (pingPong) {
        args.push('-vf', `${trimFilter}${scaleFilter},split[v1][v2];[v2]reverse[rv];[v1][rv]concat=n=2:v=1`)
      } else {
        args.push('-vf', `${trimFilter}${scaleFilter}`)
      }
      args.push('-vcodec', 'libwebp')
      args.push('-q:v', String(quality))
      args.push('-preset', 'default')
      args.push('-loop', loop ? '0' : '1')
      if (optimize) args.push('-compression_level', '6')
    } else if (fmt === 'APNG') {
      const trimFilter = getTrimFilter()
      const scaleFilter = `fps=${gifFps},scale=${width}:-1:flags=lanczos`
      if (pingPong) {
        args.push('-vf', `${trimFilter}${scaleFilter},split[v1][v2];[v2]reverse[rv];[v1][rv]concat=n=2:v=1`)
      } else {
        args.push('-vf', `${trimFilter}${scaleFilter}`)
      }
      args.push('-vcodec', 'apng')
      args.push('-plays', loop ? '0' : '1')
    }

    return args
  }, [fmt, gifFps, width, quality, loop, pingPong, dither, startTime, duration, optimize])

  const handlePreview = async () => {
    if (!file) return
    setPreviewLoading(true)
    try {
      const previewTime = startTime > 0 ? startTime : 0
      const vfIndex = ffArgs.indexOf('-vf')
      // Для предпросмотра берём только scale фильтр без палитры и реверса
      const vfString = `scale=${width}:-1:flags=lanczos`
      const tmpPath = await invoke('preview_frame', {
        input: file.path,
        time: previewTime,
        vfArgs: vfString,
      })
      const base64 = await invoke('read_file_base64', { path: tmpPath })
      setPreviewSrc(`data:image/jpeg;base64,${base64}`)
    } catch (e) {
      showErrorToast(e, 'Не удалось подготовить предпросмотр')
    }
    setPreviewLoading(false)
  }

  const cmd = useMemo(() => {
    if (!file) return 'ffmpeg -i input.mp4 ...'
    return `ffmpeg -y -i "${file.name}" ${ffArgs.join(' ')} "output.${fmt.toLowerCase()}"`
  }, [file, ffArgs, fmt])

  const handleConvert = async () => {
    if (!file) return
    if (duration < 0 || startTime < 0) {
      showErrorToast('Время начала и длительность не могут быть отрицательными.')
      return
    }
    if (gifFps < 5 || gifFps > 30) {
      showErrorToast('FPS должен быть в диапазоне 5..30.')
      return
    }
    const ext = fmt.toLowerCase()
    const outPath = await saveOutputUnique({
      defaultStem: 'anim',
      extension: ext,
      filters: [{ name: fmt, extensions: [ext] }],
      targetDir: settings.outputDir || '',
    })
    if (!outPath) return
    try {
      await run(file.path, outPath, ffArgs)
    } catch (e) {
      showErrorToast(e, 'Не удалось запустить конвертацию')
    }
  }

  return (
    <div className="content video-compact gif-compact">

      <FileDropZone
        file={file}
        onPick={() => pickFile([{ name: 'Видео', extensions: ['mp4','mkv','avi','mov','webm','gif'] }])}
        onClear={clearFile}
        onDropPath={loadFileInfo}
        accept="MP4, MKV, MOV, WebM или существующий GIF для перекодирования"
      />

      {file && (
        <div className="card">
          <div className="card-header clickable" onClick={() => setPreviewOpen(v => !v)}>
            <span className="card-title">Предпросмотр кадра</span>
            <span className={`card-toggle ${previewOpen ? 'open' : ''}`}>▼</span>
          </div>
          <div className={`card-content ${previewOpen ? 'open' : ''}`}>
            <div className="row">
              <div>
                <div className="row-label">Кадр для предпросмотра</div>
                <div className="row-hint">Показывает масштаб и пример качества</div>
              </div>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12 }}
                onClick={handlePreview}
                disabled={previewLoading}
              >
                {previewLoading ? 'Загрузка...' : 'Показать'}
              </button>
            </div>
            {previewSrc && (
              <div style={{ padding: '8px 16px 16px' }}>
                <img
                  src={previewSrc}
                  alt="preview"
                  style={{
                    width: '100%',
                    maxHeight: '300px',
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
        </div>
      )}

      <div className="card">
        <div className="card-header"><span className="card-title">Формат</span></div>
        <div className="chip-row">
          {OUTPUT_FORMATS.map(f => (
            <Chip key={f} label={f} sel={fmt === f} onClick={() => setFmt(f)} />
          ))}
        </div>
      </div>

      <div className="two-col gif-main-cards">
        <div className="card">
          <div className="card-header"><span className="card-title">Параметры анимации</span></div>
          <SliderRow label="FPS" min={5} max={30} step={1} value={gifFps} onChange={setGifFps} />
          <SliderRow label="Ширина (px)" hint="Высота рассчитывается автоматически"
            min={100} max={1920} step={10} value={width} onChange={setWidth} unit="px" />
          {fmt === 'WebP' && (
            <SliderRow label="Качество" min={1} max={100} step={1} value={quality}
              onChange={setQuality} unit="%" />
          )}
          <ToggleRow label="Зациклить анимацию" on={loop} onChange={setLoop} />
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Эффекты и тайминг</span></div>
          <ToggleRow label="Ping-pong (вперёд + назад)" hint="Анимация играет вперёд затем в обратную сторону"
            on={pingPong} onChange={setPingPong} />
          <div className="row">
            <div>
              <div className="row-label">Начало (сек)</div>
              <div className="row-hint">0 = с начала</div>
            </div>
            <input type="number" className="ios-input" min={0} value={startTime}
              onChange={e => setStart(Number(e.target.value))} />
          </div>
          <div className="row">
            <div>
              <div className="row-label">Длительность (сек)</div>
              <div className="row-hint">0 = до конца</div>
            </div>
            <input type="number" className="ios-input" min={0} value={duration}
              onChange={e => setDuration(Number(e.target.value))} />
          </div>
          <div className="row clickable video-adv-toggle" onClick={() => setAdvancedOpen(v => !v)}>
            <span className="card-title">Расширенные</span>
            <span className={`card-toggle ${advancedOpen ? 'open' : ''}`}>▼</span>
          </div>
          <div className={`card-content video-adv-content ${advancedOpen ? 'open' : ''}`}>
            {fmt === 'GIF' && (
              <SelectRow label="Дизеринг (dither)" value={dither} onChange={setDither}
                options={DITHER_MODES} />
            )}
            {fmt === 'WebP' && (
              <ToggleRow label="Оптимизировать (compression 6)" on={optimize} onChange={setOptimize} />
            )}
          </div>
        </div>
      </div>

      <CmdPreview cmd={cmd} />

      <ConvertFooter
        state={state} progress={progress} speed={speed} fps={fps} error={error}
        onConvert={handleConvert} onReset={state === 'running' ? cancel : reset}
        disabled={!file || duration < 0 || startTime < 0 || gifFps < 5 || gifFps > 30}
      />
    </div>
  )
}

