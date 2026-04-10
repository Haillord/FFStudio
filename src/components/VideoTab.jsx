import { useState, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  useFile, useConvert, saveOutput,
  Toggle, Chip, SliderRow, SelectRow, ToggleRow,
  ConvertFooter, CmdPreview, FileDropZone,
} from './shared'

const VIDEO_FORMATS = ['MP4', 'MKV', 'WebM', 'MOV', 'AVI', 'TS', 'FLV']
const RESOLUTIONS = [
  { label: '4K', value: '3840:2160' },
  { label: '1080p', value: '1920:1080' },
  { label: '720p', value: '1280:720' },
  { label: '480p', value: '854:480' },
  { label: '360p', value: '640:360' },
  { label: 'Оригинал', value: 'original' },
]
const VIDEO_CODECS = [
  { label: 'H.264',      value: 'libx264',    tag: 'MP4/MKV' },
  { label: 'H.265',      value: 'libx265',    tag: 'HEVC' },
  { label: 'VP9',        value: 'libvpx-vp9', tag: 'WebM' },
  { label: 'AV1',        value: 'libaom-av1', tag: 'AV1' },
  { label: 'ProRes',     value: 'prores_ks',  tag: 'Apple' },
  { label: 'Без сжатия', value: 'rawvideo',   tag: 'raw' },
  { label: 'Копия',      value: 'copy',       tag: '-vcodec copy' },
]
const AUDIO_CODECS = [
  { label: 'AAC',    value: 'aac',        tag: 'default' },
  { label: 'MP3',    value: 'libmp3lame', tag: 'compat' },
  { label: 'Opus',   value: 'libopus',    tag: 'WebM' },
  { label: 'FLAC',   value: 'flac',       tag: 'lossless' },
  { label: 'Копия',  value: 'copy',       tag: '-acodec copy' },
  { label: 'Убрать', value: 'none',       tag: '-an' },
]
const PRESETS = ['ultrafast','superfast','veryfast','faster','fast','medium','slow','veryslow']
const HW_ACCEL = [
  { label: 'Нет (CPU)',          value: 'none' },
  { label: 'NVENC (NVIDIA)',     value: 'nvenc' },
  { label: 'VideoToolbox (Mac)', value: 'videotoolbox' },
  { label: 'VAAPI (Linux)',      value: 'vaapi' },
  { label: 'AMF (AMD)',          value: 'amf' },
]

export default function VideoTab({ settings }) {
  const { file, pickFile, loadFileInfo, clearFile } = useFile()
  const { state, progress, speed, fps, error, run, reset } = useConvert()

  const [openSections, setOpenSections] = useState({
    resolution: true,
    codecs: true,
    advanced: false,
    effects: false
  })

  const [fmt, setFmt]               = useState('MP4')
  const [res, setRes]               = useState('1920:1080')
  const [fpsVal, setFps]            = useState(30)
  const [crf, setCrf]               = useState(23)
  const [vcodec, setVcodec]         = useState('libx264')
  const [acodec, setAcodec]         = useState('aac')
  const [abitrate, setAbitrate]     = useState('192k')
  const [preset, setPreset]         = useState('medium')
  const [hw, setHw]                 = useState('none')
  const [twoPass, setTwoPass]       = useState(false)
  const [keepAr, setKeepAr]         = useState(true)
  const [normalize, setNormalize]   = useState(false)
  const [faststart, setFaststart]   = useState(true)
  const [stripMeta, setStripMeta]   = useState(false)
  const [subsMode, setSubsMode]     = useState('keep')
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [rotate, setRotate]         = useState(0)
  const [hflip, setHflip]           = useState(false)
  const [vflip, setVflip]           = useState(false)
  const [vertical, setVertical]     = useState(false)
  const [cropOffset, setCropOffset] = useState(0)
  const [previewSrc, setPreviewSrc] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewTime, setPreviewTime] = useState(0)

  const toggleSection = (section) => {
    setOpenSections(prev => {
      const newState = { resolution: false, advanced: false, effects: false }
      if (!prev[section]) newState[section] = true
      return newState
    })
  }

  const handleFmtChange = (newFmt) => {
    setFmt(newFmt)
    if (newFmt === 'WebM') {
      setVcodec('libvpx-vp9')
      setAcodec('libopus')
    } else if (newFmt === 'MOV') {
      setVcodec('prores_ks')
      setAcodec('aac')
    } else if (newFmt === 'AVI') {
      setVcodec('libx264')
      setAcodec('libmp3lame')
    } else {
      setVcodec('libx264')
      setAcodec('aac')
    }
  }

  const ffArgs = useMemo(() => {
    const args = []
    if (vcodec === 'copy') {
      args.push('-vcodec', 'copy')
    } else if (vcodec !== 'none') {
      args.push('-vcodec', vcodec)
      if (vcodec !== 'rawvideo') args.push('-crf', String(crf))
      if (['libx264','libx265'].includes(vcodec)) args.push('-preset', preset)
    }
    const vf = []
    if (res !== 'original') {
      const [w, h] = res.split(':')
      vf.push(keepAr ? `scale=${w}:${h}:force_original_aspect_ratio=decrease` : `scale=${w}:${h}`)
    }
    if (playbackSpeed !== 1.0) {
      vf.push(`setpts=${1/playbackSpeed}*PTS`)
      args.push('-af', `atempo=${playbackSpeed}`)
    }
    if (rotate !== 0) vf.push(`transpose=${rotate}`)
    if (hflip) vf.push('hflip')
    if (vflip) vf.push('vflip')
    if (vertical) {
      const offset = `(iw-ih*9/16)/2+iw*${cropOffset}/100`
      vf.push(`crop=ih*9/16:ih:${offset}:0`)
    }
    if (vf.length > 0) args.push('-vf', vf.join(','))
    args.push('-r', String(fpsVal))
    if (acodec === 'none') {
      args.push('-an')
    } else if (acodec === 'copy') {
      args.push('-acodec', 'copy')
    } else {
      args.push('-acodec', acodec, '-b:a', abitrate)
      if (normalize) args.push('-af', 'loudnorm=I=-14:TP=-1.5:LRA=11')
    }
    if (subsMode === 'strip') args.push('-sn')
    if (stripMeta) args.push('-map_metadata', '-1')
    if (fmt === 'MP4' && faststart) args.push('-movflags', '+faststart')
    return args
  }, [vcodec, crf, preset, res, keepAr, fpsVal, acodec, abitrate, normalize,
      subsMode, stripMeta, fmt, faststart, playbackSpeed, rotate, hflip, vflip, vertical, cropOffset])

  const cmd = useMemo(() => {
    if (!file) return 'ffmpeg -i input.mp4 ...'
    const ext = fmt.toLowerCase()
    return `ffmpeg -y -i "${file.name}" ${ffArgs.join(' ')} "output.${ext}"`
  }, [file, ffArgs, fmt])

  const handlePreview = async () => {
    if (!file) return
    setPreviewLoading(true)
    try {
      // Берём vf фильтры из ffArgs
      const vfIndex = ffArgs.indexOf('-vf')
      const vfString = vfIndex !== -1 ? ffArgs[vfIndex + 1] : ''
      
      const tmpPath = await invoke('preview_frame', {
        input: file.path,
        time: previewTime,
        vfArgs: vfString,
      })
      const base64 = await invoke('read_file_base64', { path: tmpPath })
      setPreviewSrc(`data:image/jpeg;base64,${base64}`)
    } catch (e) {
      console.error(e)
    }
    setPreviewLoading(false)
  }

  const handleConvert = async () => {
    if (!file) return
    const ext = fmt.toLowerCase()
    const outPath = await saveOutput(`output.${ext}`, [{ name: fmt, extensions: [ext] }])
    if (!outPath) return
    run(file.path, outPath, ffArgs)
  }

  return (
    <div className="content">
      <FileDropZone
        file={file}
        onPick={() => pickFile([{ name: 'Видео', extensions: ['mp4','mkv','avi','mov','webm','ts','flv','m4v'] }])}
        onClear={clearFile}
        onDropPath={loadFileInfo}
        accept="MP4, MKV, AVI, MOV, WebM и другие"
      />

      {file && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Предпросмотр кадра</span>
            <button 
              className="btn btn-secondary" 
              style={{ fontSize: 12 }}
              onClick={handlePreview}
              disabled={previewLoading}
            >
              {previewLoading ? '⏳ Загрузка...' : '👁 Показать'}
            </button>
          </div>
          <div className="row">
            <div>
              <div className="row-label">Время (сек)</div>
              {file?.info?.duration > 0 && (
                <div className="row-hint">до {file.info.duration.toFixed(1)} сек</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="range"
                min={0}
                max={file?.info?.duration || 100}
                step={0.5}
                value={previewTime}
                onChange={e => setPreviewTime(Number(e.target.value))}
                style={{ width: 150 }}
              />
              <input
                type="number"
                className="ios-input"
                min={0}
                step={0.5}
                value={previewTime}
                onChange={e => setPreviewTime(Number(e.target.value))}
                style={{ width: 60 }}
              />
            </div>
          </div>
          {previewSrc && (
            <div style={{ padding: '0 16px 16px' }}>
        <img 
          src={previewSrc} 
          alt="preview" 
          style={{ 
            width: vertical ? 'auto' : '100%',
            height: vertical ? '400px' : 'auto',
            maxHeight: '400px',
            maxWidth: '100%',
            borderRadius: 8,
            border: '1px solid var(--border)',
            display: 'block',
            margin: '0 auto',
            objectFit: 'contain'
          }} 
        />
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header"><span className="card-title">Формат вывода</span></div>
        <div className="chip-row">
          {VIDEO_FORMATS.map(f => (
            <Chip key={f} label={f} sel={fmt === f} onClick={() => handleFmtChange(f)} />
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header clickable" onClick={() => toggleSection('resolution')}>
          <span className="card-title">Разрешение</span>
          <span className={`card-toggle ${openSections.resolution ? 'open' : ''}`}>▼</span>
        </div>
        <div className={`card-content ${openSections.resolution ? 'open' : ''}`}>
          <div className="chip-row">
            {RESOLUTIONS.map(r => (
              <Chip key={r.value} label={r.label} sel={res === r.value} onClick={() => setRes(r.value)} />
            ))}
          </div>
          <SliderRow label="FPS" min={10} max={120} step={1} value={fpsVal} onChange={setFps} />
          <ToggleRow label="Сохранить соотношение сторон" on={keepAr} onChange={setKeepAr} />
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-header"><span className="card-title">Видеокодек</span></div>
          <div className="codec-grid">
            {VIDEO_CODECS.map(c => (
              <button key={c.value} className={`codec-btn${vcodec === c.value ? ' sel' : ''}`}
                onClick={() => setVcodec(c.value)}>
                {c.label}<span>{c.tag}</span>
              </button>
            ))}
          </div>
          <SliderRow label="Качество (CRF)" hint="Меньше = лучше качество"
            min={0} max={51} value={crf} onChange={setCrf} />
          <SelectRow label="Скорость (preset)" value={preset} onChange={setPreset} options={PRESETS} />
          <SelectRow label="Аппаратное ускорение" value={hw} onChange={setHw} options={HW_ACCEL} />
          <ToggleRow label="Двухпроходное кодирование" on={twoPass} onChange={setTwoPass} />
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Аудиокодек</span></div>
          <div className="codec-grid">
            {AUDIO_CODECS.map(c => (
              <button key={c.value} className={`codec-btn${acodec === c.value ? ' sel' : ''}`}
                onClick={() => setAcodec(c.value)}>
                {c.label}<span>{c.tag}</span>
              </button>
            ))}
          </div>
          <SelectRow label="Битрейт" value={abitrate} onChange={setAbitrate}
            options={['64k','96k','128k','192k','256k','320k']} />
          <ToggleRow label="Нормализация громкости" hint="loudnorm -14 LUFS"
            on={normalize} onChange={setNormalize} />
        </div>
      </div>

      <div className="card">
        <div className="card-header clickable" onClick={() => toggleSection('advanced')}>
          <span className="card-title">Дополнительно</span>
          <span className={`card-toggle ${openSections.advanced ? 'open' : ''}`}>▼</span>
        </div>
        <div className={`card-content ${openSections.advanced ? 'open' : ''}`}>
          <SelectRow label="Субтитры" value={subsMode} onChange={setSubsMode}
            options={[
              { label: 'Сохранить', value: 'keep' },
              { label: 'Встроить (hardsub)', value: 'hardsub' },
              { label: 'Удалить', value: 'strip' },
            ]} />
          <ToggleRow label="Удалить метаданные" on={stripMeta} onChange={setStripMeta} />
          <ToggleRow label="Faststart (для стриминга)" hint="Только MP4"
            on={faststart} onChange={setFaststart} />
        </div>
      </div>

      <div className="card">
        <div className="card-header clickable" onClick={() => toggleSection('effects')}>
          <span className="card-title">Эффекты видео</span>
          <span className={`card-toggle ${openSections.effects ? 'open' : ''}`}>▼</span>
        </div>
        <div className={`card-content ${openSections.effects ? 'open' : ''}`}>
          <SliderRow label="Скорость воспроизведения" min={0.25} max={16} step={0.25}
            value={playbackSpeed} onChange={setPlaybackSpeed} />
          <SelectRow label="Поворот" value={rotate} onChange={setRotate}
            options={[
              { label: 'Без поворота', value: 0 },
              { label: '90° по часовой', value: 1 },
              { label: '180°', value: 2 },
              { label: '90° против часовой', value: 3 },
            ]} />
          <ToggleRow label="Отразить по горизонтали" on={hflip} onChange={setHflip} />
          <ToggleRow label="Отразить по вертикали" on={vflip} onChange={setVflip} />
          
          <ToggleRow 
            label="Вертикальное видео (9:16)" 
            hint="Кадрирует для TikTok/Reels/Shorts"
            on={vertical} 
            onChange={setVertical} 
          />
          {vertical && (
            <SliderRow 
              label="Смещение по горизонтали"
              hint="0 = центр, минус = левее, плюс = правее"
              min={-50} max={50} step={1}
              value={cropOffset} onChange={setCropOffset}
              unit="%"
            />
          )}
        </div>
      </div>

      <CmdPreview cmd={cmd} />

      <ConvertFooter
        state={state} progress={progress} speed={speed} fps={fps} error={error}
        onConvert={handleConvert} onReset={reset}
        disabled={!file}
      />
    </div>
  )
}