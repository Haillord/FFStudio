import { useState, useMemo, useEffect, useRef } from 'react'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import {
  useFile, useConvert, useTabState, saveOutputUnique,
  Chip, SelectRow, ToggleRow, SliderRow,
  ConvertFooter, CmdPreview, FileDropZone, PageHeader,
} from './shared'

const AUDIO_FORMATS = ['MP3', 'AAC', 'FLAC', 'WAV', 'OGG', 'M4A', 'OPUS', 'WMA']
const CODEC_MAP = {
  MP3: 'libmp3lame', AAC: 'aac', FLAC: 'flac',
  WAV: 'pcm_s16le', OGG: 'libvorbis', M4A: 'aac',
  OPUS: 'libopus', WMA: 'wmav2',
}
const SAMPLE_RATES = ['8000', '22050', '44100', '48000', '96000', '192000']
const BITRATES = ['64k','96k','128k','160k','192k','256k','320k','Auto']
const CUT_SKIP_LOOKAHEAD_SEC = 0.06
const CHANNELS = [
  { label: 'Моно', value: '1' },
  { label: 'Стерео', value: '2' },
  { label: '5.1', value: '6' },
]

function roundTimeValue(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

export default function AudioTab({ settings }) {
  const { file, pickFile, loadFileInfo, clearFile } = useFile()
  const { state, progress, speed, fps, error, run, reset, cancel } = useConvert()
  const { state: persistedAudio, patchState: patchTabState } = useTabState('audio', {
    fmt: 'MP3', bitrate: '192k', sampleRate: '44100', channels: '2',
    normalize: false, volume: 100, trimSilence: false,
    cutEnabled: false, cutStart: 0, cutEnd: 0,
    rangeEnabled: false, rangeStart: 0, rangeEnd: 0,
  })

  const [fmt, setFmt]           = useState(persistedAudio.fmt)
  const [bitrate, setBitrate]   = useState(persistedAudio.bitrate)
  const [sampleRate, setSR]     = useState(persistedAudio.sampleRate)
  const [channels, setChannels] = useState(persistedAudio.channels)
  const [normalize, setNormalize] = useState(persistedAudio.normalize)
  const [volume, setVolume]     = useState(persistedAudio.volume)
  const [trimSilence, setTrimSilence] = useState(persistedAudio.trimSilence)
  // draft selection (just highlight + sliders)
  const [cutEnabled, setCutEnabled] = useState(persistedAudio.cutEnabled)
  const [cutStart, setCutStart] = useState(roundTimeValue(persistedAudio.cutStart || 0))
  const [cutEnd, setCutEnd] = useState(roundTimeValue(persistedAudio.cutEnd || 0))
  const [rangeEnabled, setRangeEnabled] = useState(Boolean(persistedAudio.rangeEnabled))
  const [rangeStart, setRangeStart] = useState(roundTimeValue(persistedAudio.rangeStart || 0))
  const [rangeEnd, setRangeEnd] = useState(roundTimeValue(persistedAudio.rangeEnd || 0))

  // applied cut (affects preview + conversion)
  const [appliedCutEnabled, setAppliedCutEnabled] = useState(false)
  const [appliedCutStart, setAppliedCutStart] = useState(0)
  const [appliedCutEnd, setAppliedCutEnd] = useState(0)
  const [waveform, setWaveform] = useState([])
  const [waveLoading, setWaveLoading] = useState(false)
  const [waveError, setWaveError] = useState('')
  const [previewDuration, setPreviewDuration] = useState(0)
  const [previewTime, setPreviewTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [previewAudioPath, setPreviewAudioPath] = useState('')
  const [previewAudioSrc, setPreviewAudioSrc] = useState('')
  const audioRef = useRef(null)
  const rafRef = useRef(null)

  useEffect(() => {
    patchTabState({
      fmt,
      bitrate,
      sampleRate,
      channels,
      normalize,
      volume,
      trimSilence,
      cutEnabled,
      cutStart,
      cutEnd,
      rangeEnabled,
      rangeStart,
      rangeEnd,
    })
  }, [fmt, bitrate, sampleRate, channels, normalize, volume, trimSilence, cutEnabled, cutStart, cutEnd, rangeEnabled, rangeStart, rangeEnd])

  const hasCutSegment = appliedCutEnabled && previewDuration > 0 && appliedCutEnd > appliedCutStart + 0.01
  const hasRangeTrim = rangeEnabled && previewDuration > 0 && rangeEnd > rangeStart + 0.01
  const rangeStartSafe = hasRangeTrim ? Math.max(0, Math.min(previewDuration, rangeStart)) : 0
  const rangeEndSafe = hasRangeTrim ? Math.max(rangeStartSafe + 0.01, Math.min(previewDuration, rangeEnd)) : 0
  const hasActiveCutSegment = hasCutSegment && !hasRangeTrim
  const cutStartSafe = hasActiveCutSegment ? Math.max(0, Math.min(previewDuration, appliedCutStart)) : 0
  const cutEndSafe = hasActiveCutSegment ? Math.max(cutStartSafe + 0.01, Math.min(previewDuration, appliedCutEnd)) : 0
  const cutLength = hasActiveCutSegment ? Math.max(0, cutEndSafe - cutStartSafe) : 0
  const previewEffectiveDuration = hasRangeTrim
    ? Math.max(0.1, rangeEndSafe - rangeStartSafe)
    : Math.max(0.1, (previewDuration || 0.1) - cutLength)
  const cutRemovesTail = hasActiveCutSegment && cutEndSafe >= (previewDuration - 0.02)

  useEffect(() => {
    if (!file?.path) {
      setWaveform([])
      setWaveLoading(false)
      setWaveError('')
      setPreviewDuration(0)
      setPreviewTime(0)
      setIsPlaying(false)
      setPreviewAudioPath('')
      setPreviewAudioSrc('')
      return
    }

    let cancelled = false
    setWaveLoading(true)
    setWaveError('')
    setWaveform([])
    setPreviewTime(0)
    setIsPlaying(false)
    setPreviewAudioPath('')
    setPreviewAudioSrc('')

    const fallbackDuration = Number(file?.info?.duration || 0)
    if (fallbackDuration > 0) setPreviewDuration(fallbackDuration)

    const decodeWaveformFromPath = async (pathToDecode) => {
      const base64 = await invoke('read_file_base64', { path: pathToDecode })
      const bytes = Uint8Array.from(atob(String(base64)), c => c.charCodeAt(0))
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      try {
        const decoded = await audioCtx.decodeAudioData(bytes.buffer.slice(0))
        if (cancelled) return
        const channel = decoded.getChannelData(0)
        const points = 180
        const step = Math.max(1, Math.floor(channel.length / points))
        const data = new Array(points).fill(0).map((_, i) => {
          const start = i * step
          const end = Math.min(channel.length, start + step)
          let peak = 0
          for (let j = start; j < end; j++) {
            const v = Math.abs(channel[j])
            if (v > peak) peak = v
          }
          return peak
        })
        setWaveform(data)
        setPreviewDuration(decoded.duration || fallbackDuration || 0)
      } finally {
        audioCtx.close().catch(() => {})
      }
    }

    const loadWaveform = async () => {
      try {
        const prepared = await invoke('prepare_audio_preview', { input: file.path })
        if (cancelled) return
        const preparedPath = String(prepared || '')
        if (!preparedPath) throw new Error('empty preview path')
        setPreviewAudioPath(preparedPath)
        setPreviewAudioSrc(convertFileSrc(preparedPath))
        await decodeWaveformFromPath(preparedPath)
      } catch (wavErr) {
        try {
          await decodeWaveformFromPath(file.path)
          if (!cancelled) {
            setPreviewAudioPath(file.path)
            setPreviewAudioSrc(convertFileSrc(file.path))
            setWaveError('Предпрослушка может быть недоступна для исходного формата')
          }
        } catch (directErr) {
          if (!cancelled) {
            const wavMsg = String(wavErr || '')
            const directMsg = String(directErr || '')
            if (wavMsg.includes('unknown command')) {
              setWaveError('Нужен перезапуск приложения, чтобы включить новый аудио-предпросмотр')
            } else {
              setWaveError(`Не удалось построить waveform (wav: ${wavMsg || 'n/a'}; direct: ${directMsg || 'n/a'})`)
            }
          }
        }
      } finally {
        if (!cancelled) setWaveLoading(false)
      }
    }

    loadWaveform()
    return () => {
      cancelled = true
    }
  }, [file?.path])

  useEffect(() => {
    const enforceCutSkip = () => {
      if (!audioRef.current) return
      const t = audioRef.current.currentTime || 0

      if (hasRangeTrim) {
        if (t < rangeStartSafe) {
          audioRef.current.currentTime = rangeStartSafe
          return
        }
        if (t >= rangeEndSafe - CUT_SKIP_LOOKAHEAD_SEC) {
          audioRef.current.pause()
          audioRef.current.currentTime = rangeEndSafe
          setPreviewTime(previewEffectiveDuration)
          setIsPlaying(false)
          return
        }
      }

      if (!hasActiveCutSegment) return
      const skipStart = Math.max(0, cutStartSafe - CUT_SKIP_LOOKAHEAD_SEC)
      // If cut removes tail, stop exactly at cut start in preview.
      if (cutRemovesTail && t >= skipStart) {
        audioRef.current.pause()
        audioRef.current.currentTime = cutStartSafe
        setPreviewTime(cutStartSafe)
        setIsPlaying(false)
        return
      }
      if (t >= skipStart && t < cutEndSafe) {
        audioRef.current.currentTime = cutEndSafe
      }
    }

    const tick = () => {
      if (!audioRef.current) return
      enforceCutSkip()
      setPreviewTime(sourceToDisplayTime(audioRef.current.currentTime || 0))
      if (!audioRef.current.paused) {
        rafRef.current = window.requestAnimationFrame(tick)
      }
    }

    const audio = audioRef.current
    if (audio) {
      audio.addEventListener('timeupdate', enforceCutSkip)
      audio.addEventListener('seeking', enforceCutSkip)
    }

    if (isPlaying) {
      if (hasRangeTrim && audioRef.current && audioRef.current.currentTime < rangeStartSafe) {
        audioRef.current.currentTime = rangeStartSafe
      }
      rafRef.current = window.requestAnimationFrame(tick)
    }
    return () => {
      if (audio) {
        audio.removeEventListener('timeupdate', enforceCutSkip)
        audio.removeEventListener('seeking', enforceCutSkip)
      }
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isPlaying, hasActiveCutSegment, cutStartSafe, cutEndSafe, cutRemovesTail, hasRangeTrim, rangeStartSafe, rangeEndSafe, previewEffectiveDuration])

  function formatTime(sec) {
    const safe = Math.max(0, Number(sec || 0))
    const m = Math.floor(safe / 60)
    const s = Math.floor(safe % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }

  function sourceToDisplayTime(sourceTime) {
    const t = Math.max(0, Number(sourceTime || 0))
    if (hasRangeTrim) {
      if (t <= rangeStartSafe) return 0
      if (t >= rangeEndSafe) return previewEffectiveDuration
      return t - rangeStartSafe
    }
    if (!hasActiveCutSegment) return t
    if (t <= cutStartSafe) return t
    if (t >= cutEndSafe) return t - cutLength
    return cutStartSafe
  }

  function displayToSourceTime(displayTime) {
    const t = Math.max(0, Number(displayTime || 0))
    if (hasRangeTrim) {
      return Math.max(rangeStartSafe, Math.min(rangeEndSafe, rangeStartSafe + t))
    }
    if (!hasActiveCutSegment) return t
    if (t <= cutStartSafe) return t
    return t + cutLength
  }

  function handleSeek(next) {
    const clampedDisplay = Math.max(0, Math.min(previewEffectiveDuration || 0, next))
    const sourceTime = displayToSourceTime(clampedDisplay)
    if (audioRef.current) audioRef.current.currentTime = sourceTime
    setPreviewTime(clampedDisplay)
  }

  function handleSeekSource(sourceTime) {
    const clampedSource = Math.max(0, Math.min(previewDuration || 0, Number(sourceTime || 0)))
    if (audioRef.current) audioRef.current.currentTime = clampedSource
    setPreviewTime(sourceToDisplayTime(clampedSource))
  }

  function handleWaveClick(event) {
    if (!previewDuration) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    const sourceTarget = Math.max(0, Math.min(previewDuration, ratio * previewDuration))
    if (hasRangeTrim) {
      handleSeekSource(Math.max(rangeStartSafe, Math.min(rangeEndSafe, sourceTarget)))
      return
    }
    handleSeekSource(sourceTarget)
  }

  useEffect(() => {
    if (!cutEnabled) return
    const max = Math.max(0.1, previewDuration || 0.1)
    if (cutStart > max) setCutStart(max)
    if (cutEnd > max) setCutEnd(max)
    if (cutEnd <= cutStart + 0.01) {
      setCutEnd(Math.min(max, cutStart + 0.01))
    }
  }, [cutEnabled, cutStart, cutEnd, previewDuration])

  useEffect(() => {
    if (!rangeEnabled) return
    const max = Math.max(0.1, previewDuration || 0.1)
    if (rangeStart > max) setRangeStart(max)
    if (rangeEnd > max) setRangeEnd(max)
    if (rangeEnd <= rangeStart + 0.01) {
      setRangeEnd(Math.min(max, rangeStart + 0.01))
    }
  }, [rangeEnabled, rangeStart, rangeEnd, previewDuration])

  useEffect(() => {
    if (!file?.path) {
      setAppliedCutEnabled(false)
      setAppliedCutStart(0)
      setAppliedCutEnd(0)
    }
  }, [file?.path])

  const draftHasSegment = cutEnabled && previewDuration > 0 && cutEnd > cutStart + 0.01
  const draftStartSafe = draftHasSegment ? Math.max(0, Math.min(previewDuration, cutStart)) : 0
  const draftEndSafe = draftHasSegment ? Math.max(draftStartSafe + 0.01, Math.min(previewDuration, cutEnd)) : 0

  const canApplyCut = draftHasSegment && (!appliedCutEnabled || draftStartSafe !== appliedCutStart || draftEndSafe !== appliedCutEnd)
  const canRollbackCut = appliedCutEnabled

  function applyCutNow() {
    if (rangeEnabled) return
    if (!draftHasSegment) return
    setAppliedCutEnabled(true)
    setAppliedCutStart(draftStartSafe)
    setAppliedCutEnd(draftEndSafe)
    setWaveError('')
  }

  function rollbackCut() {
    setAppliedCutEnabled(false)
    setAppliedCutStart(0)
    setAppliedCutEnd(0)
    setWaveError('')
  }

  async function buildDataAudioUrl(path) {
    const base64 = await invoke('read_file_base64', { path })
    const ext = String(path.split('.').pop() || '').toLowerCase()
    const mimeByExt = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      opus: 'audio/opus',
      flac: 'audio/flac',
      webm: 'audio/webm',
    }
    const mime = mimeByExt[ext] || 'audio/wav'
    return `data:${mime};base64,${String(base64)}`
  }

  async function playWithErrorDetails() {
    if (!audioRef.current) return { ok: false, details: 'audio element missing' }
    return audioRef.current.play()
      .then(() => ({ ok: true, details: '' }))
      .catch((err) => ({ ok: false, details: String(err?.message || err || '') }))
  }

  function waitUntilAudioCanPlay(timeoutMs = 1500) {
    if (!audioRef.current) return Promise.resolve(false)
    const audio = audioRef.current
    if (audio.readyState >= 2) return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        audio.removeEventListener('loadedmetadata', onReady)
        audio.removeEventListener('canplay', onReady)
        audio.removeEventListener('error', onFail)
        window.clearTimeout(timer)
        resolve(ok)
      }
      const onReady = () => finish(true)
      const onFail = () => finish(false)
      const timer = window.setTimeout(() => finish(audio.readyState >= 2), timeoutMs)
      audio.addEventListener('loadedmetadata', onReady, { once: true })
      audio.addEventListener('canplay', onReady, { once: true })
      audio.addEventListener('error', onFail, { once: true })
    })
  }

  async function handleTogglePreview() {
    if (!audioRef.current) return
    if (audioRef.current.paused) {
      if (hasRangeTrim) {
        const t = audioRef.current.currentTime || 0
        if (t < rangeStartSafe || t >= rangeEndSafe - CUT_SKIP_LOOKAHEAD_SEC) {
          audioRef.current.currentTime = rangeStartSafe
          setPreviewTime(0)
        }
      }
      if (!audioRef.current.src && previewAudioPath) {
        const initialSrc = convertFileSrc(previewAudioPath)
        setPreviewAudioSrc(initialSrc)
        audioRef.current.src = initialSrc
        audioRef.current.load()
        await waitUntilAudioCanPlay()
      }
      const started = await playWithErrorDetails()
      if (!started.ok) {
        const details = started.details
        const noSupportedSource = /notsupportederror|no supported source/i.test(details)
        if (noSupportedSource && previewAudioPath) {
          const recovered = await buildDataAudioUrl(previewAudioPath)
            .then(async (dataUrl) => {
              if (!audioRef.current) return false
              setPreviewAudioSrc(dataUrl)
              audioRef.current.src = dataUrl
              audioRef.current.load()
              const ready = await waitUntilAudioCanPlay()
              if (!ready) return false
              const retried = await playWithErrorDetails()
              return retried.ok
            })
            .catch(() => false)
          if (recovered) {
            setWaveError('')
            return
          }
        }
        setWaveError(`Предпрослушка не запустилась: ${details || 'неизвестная ошибка'}`)
        setIsPlaying(false)
      }
    } else {
      audioRef.current.pause()
      setIsPlaying(false)
    }
  }

  const ffArgs = useMemo(() => {
    const args = []
    const codec = CODEC_MAP[fmt] ?? 'aac'
    args.push('-vn')
    args.push('-acodec', codec)
    if (bitrate !== 'Auto' && !['flac','pcm_s16le'].includes(codec)) {
      args.push('-b:a', bitrate)
    }
    args.push('-ar', sampleRate)
    args.push('-ac', channels)

    const filters = []
    if (hasRangeTrim) {
      const start = rangeStartSafe.toFixed(3)
      const end = rangeEndSafe.toFixed(3)
      filters.push(`atrim=start=${start}:end=${end}`)
      filters.push('asetpts=N/SR/TB')
    } else if (hasActiveCutSegment) {
      const start = cutStartSafe.toFixed(3)
      const end = cutEndSafe.toFixed(3)
      filters.push(`aselect='not(between(t\\,${start}\\,${end}))'`)
      filters.push('asetpts=N/SR/TB')
    }
    if (normalize) filters.push('loudnorm=I=-14:TP=-1.5:LRA=11')
    if (trimSilence) filters.push('silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB')
    if (volume !== 100) {
      const gainDb = (20 * Math.log10(Math.max(0.01, volume / 100))).toFixed(2)
      // Apply gain at the very end so previous filters do not negate it.
      filters.push(`volume=${gainDb}dB`)
    }
    if (filters.length) args.push('-af', filters.join(','))

    return args
  }, [fmt, bitrate, sampleRate, channels, normalize, volume, trimSilence, hasRangeTrim, rangeStartSafe, rangeEndSafe, hasActiveCutSegment, cutStartSafe, cutEndSafe])

  const cmd = useMemo(() => {
    if (!file) return 'ffmpeg -i input.mp3 ...'
    return `ffmpeg -y -i "${file.name}" ${ffArgs.join(' ')} "output.${fmt.toLowerCase()}"`
  }, [file, ffArgs, fmt])

  const sourceCursorTime = displayToSourceTime(previewTime)
  const cursorLeftPercent = previewDuration > 0
    ? Math.max(0, Math.min(100, (sourceCursorTime / previewDuration) * 100))
    : 0

  const handleConvert = async () => {
    if (!file) return
    const ext = fmt.toLowerCase()
    const outPath = await saveOutputUnique({
      defaultStem: 'audio',
      extension: ext,
      filters: [{ name: fmt, extensions: [ext] }],
      targetDir: settings.outputDir || '',
    })
    if (!outPath) return
    run(file.path, outPath, ffArgs)
  }

  return (
    <div className="content video-compact audio-compact">

      <FileDropZone
        file={file}
        onPick={() => pickFile([
          { name: 'Аудио', extensions: ['mp3','aac','flac','wav','ogg','m4a','opus','wma'] },
          { name: 'Видео (извлечь звук)', extensions: ['mp4','mkv','avi','mov','webm'] },
        ])}
        onClear={clearFile}
        onDropPath={loadFileInfo}
        accept="MP3, AAC, FLAC, WAV, OGG, M4A, OPUS — или видео для извлечения звука"
      />

      <div className="card">
        <div className="card-header"><span className="card-title">Формат вывода</span></div>
        <div className="chip-row">
          {AUDIO_FORMATS.map(f => (
            <Chip key={f} label={f} sel={fmt === f} onClick={() => setFmt(f)} />
          ))}
        </div>
      </div>

      <div className="two-col audio-main-cards">
        <div className="card">
          <div className="card-header"><span className="card-title">Параметры</span></div>
          <div className="audio-card-main">
            <SelectRow label="Битрейт" value={bitrate} onChange={setBitrate} options={BITRATES} />
            <SelectRow label="Частота дискретизации (Hz)" value={sampleRate} onChange={setSR}
              options={SAMPLE_RATES.map(v => ({ label: `${v} Hz`, value: v }))} />
            <SelectRow label="Каналы" value={channels} onChange={setChannels} options={CHANNELS} />
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Обработка</span></div>
          <div className="audio-card-main">
            <ToggleRow label="Нормализация громкости" hint="loudnorm -14 LUFS"
              on={normalize} onChange={setNormalize} />
            <SliderRow label="Громкость" min={0} max={200} step={1} value={volume}
              onChange={setVolume} unit="%" />
            <ToggleRow label="Удалить тишину в начале/конце" on={trimSilence} onChange={setTrimSilence} />
          </div>
        </div>
      </div>

      <div className="card audio-tool-card">
        <div className="card-header"><span className="card-title">Обрезка по длине</span></div>
        <div className="audio-tool-main">
          <ToggleRow
            label="Оставить только диапазон"
            hint="Обрезка начала/конца: сохранится участок от «С» до «По»"
            on={rangeEnabled}
            onChange={(next) => {
              const turnOn = !!next
              setRangeEnabled(turnOn)
              if (turnOn) {
                setAppliedCutEnabled(false)
                if (previewDuration > 0 && rangeEnd <= rangeStart + 0.01) {
                  const suggestedEnd = Math.min(previewDuration, rangeStart + Math.max(1, previewDuration * 0.25))
                  setRangeEnd(Math.max(rangeStart + 0.01, suggestedEnd))
                }
              }
            }}
          />
        </div>
        {rangeEnabled && (
          <div className="audio-tool-expanded">
            <SliderRow
              label="С"
              min={0}
              max={Math.max(0.1, previewDuration || 0.1)}
              step={0.01}
              value={Math.max(0, Math.min(rangeStart, Math.max(0, rangeEnd - 0.01)))}
              onChange={(v) => {
                const nextStart = roundTimeValue(v)
                setRangeStart(nextStart)
                if (rangeEnd <= nextStart + 0.01) {
                  setRangeEnd(roundTimeValue(Math.min(Math.max(0.1, previewDuration || 0.1), nextStart + 0.01)))
                }
              }}
              unit="с"
            />
            <SliderRow
              label="По"
              min={0}
              max={Math.max(0.1, previewDuration || 0.1)}
              step={0.01}
              value={Math.max(rangeStart + 0.01, Math.min(rangeEnd || 0, Math.max(0.1, previewDuration || 0.1)))}
              onChange={(v) => {
                const max = Math.max(0.1, previewDuration || 0.1)
                const nextEnd = Math.max(rangeStart + 0.01, Math.min(max, roundTimeValue(v)))
                setRangeEnd(roundTimeValue(nextEnd))
              }}
              unit="с"
            />
            <span className="muted-note">
              Итоговая длина: {formatTime(Math.max(0, rangeEnd - rangeStart))}
            </span>
          </div>
        )}
      </div>

      <div className="card audio-tool-card">
        <div className="card-header"><span className="card-title">Вырезать фрагмент</span></div>
        <div className="audio-tool-main">
          <ToggleRow
            label="Удалить участок из середины"
            hint={rangeEnabled
              ? 'Отключите «Обрезка по длине», чтобы применить точечный вырез'
              : 'Участок между точками «С» и «По» будет вырезан из результата'}
            on={cutEnabled}
            onChange={(next) => {
              const turnOn = !!next
              setCutEnabled(turnOn)
              if (turnOn && previewDuration > 0 && cutEnd <= cutStart + 0.01) {
                const suggestedEnd = Math.min(previewDuration, cutStart + Math.max(0.25, previewDuration * 0.1))
                setCutEnd(Math.max(cutStart + 0.01, suggestedEnd))
              }
            }}
          />
        </div>
        {cutEnabled && (
          <div className="audio-tool-expanded">
            <div className="audio-cut-actions">
              <button
                className="btn btn-secondary"
                onClick={applyCutNow}
                disabled={!canApplyCut || rangeEnabled}
                style={{ fontSize: 12, padding: '6px 10px' }}
              >
                Применить
              </button>
              <button
                className="btn btn-secondary"
                onClick={rollbackCut}
                disabled={!canRollbackCut}
                style={{ fontSize: 12, padding: '6px 10px' }}
              >
                Откатить
              </button>
              {appliedCutEnabled && (
                <span className="badge badge-blue" style={{ marginLeft: 'auto', fontSize: 10 }}>
                  применено
                </span>
              )}
              {!appliedCutEnabled && (
                <span className="muted-note" style={{ marginLeft: 'auto' }}>
                  черновик
                </span>
              )}
            </div>
            <SliderRow
              label="С"
              min={0}
              max={Math.max(0.1, previewDuration || 0.1)}
              step={0.01}
              value={Math.max(0, Math.min(cutStart, Math.max(0, cutEnd - 0.01)))}
              onChange={(v) => {
                const nextStart = roundTimeValue(v)
                setCutStart(nextStart)
                if (cutEnd <= nextStart + 0.01) {
                  setCutEnd(roundTimeValue(Math.min(Math.max(0.1, previewDuration || 0.1), nextStart + 0.01)))
                }
              }}
              unit="с"
            />
            <SliderRow
              label="По"
              min={0}
              max={Math.max(0.1, previewDuration || 0.1)}
              step={0.01}
              value={Math.max(cutStart + 0.01, Math.min(cutEnd || 0, Math.max(0.1, previewDuration || 0.1)))}
              onChange={(v) => {
                const max = Math.max(0.1, previewDuration || 0.1)
                const nextEnd = Math.max(cutStart + 0.01, Math.min(max, roundTimeValue(v)))
                setCutEnd(roundTimeValue(nextEnd))
              }}
              unit="с"
            />
            <span className="muted-note">
              Будет удалено: {formatTime(Math.max(0, cutEnd - cutStart))}
            </span>
          </div>
        )}
      </div>

      {file && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Таймлайн</span>
            <div className="actions-row">
              <span className="muted-note">{formatTime(previewTime)} / {formatTime(previewEffectiveDuration)}</span>
              <button className="btn btn-secondary" onClick={handleTogglePreview} style={{ fontSize: 12 }}>
                {isPlaying ? 'Пауза' : 'Слушать'}
              </button>
            </div>
          </div>
          <div style={{ padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {waveLoading && <span className="muted-note">Строим waveform...</span>}
            {!waveLoading && !!waveError && <span style={{ fontSize: 12, color: 'var(--ios-red)' }}>{waveError}</span>}
            <div
              onClick={handleWaveClick}
              title="Кликните, чтобы перейти к точке"
              style={{
                position: 'relative',
                height: 76,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
                display: 'flex',
                alignItems: 'flex-end',
                gap: 1,
                padding: '8px 8px 6px',
                cursor: previewDuration > 0 ? 'pointer' : 'default',
                overflow: 'hidden',
              }}
            >
              {waveform.length > 0 ? waveform.map((v, i) => {
                const h = Math.max(5, Math.round(v * 60))
                return (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      minWidth: 1,
                      height: h,
                      borderRadius: 2,
                      background: 'color-mix(in srgb, var(--accent) 82%, var(--bg-fill))',
                      opacity: 0.9,
                    }}
                  />
                )
              }) : (
                <div style={{ width: '100%', textAlign: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {waveLoading ? '' : 'Waveform будет доступен после загрузки файла'}
                </div>
              )}
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${cursorLeftPercent}%`,
                  width: 2,
                  background: 'var(--ios-red)',
                  transform: 'translateX(-1px)',
                }}
              />
              {hasRangeTrim && previewDuration > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `${(rangeStartSafe / previewDuration) * 100}%`,
                    width: `${Math.max(0, ((rangeEndSafe - rangeStartSafe) / previewDuration) * 100)}%`,
                    background: 'color-mix(in srgb, var(--ios-green) 24%, transparent)',
                    pointerEvents: 'none',
                  }}
                />
              )}
              {draftHasSegment && previewDuration > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `${(draftStartSafe / previewDuration) * 100}%`,
                    width: `${Math.max(0, ((draftEndSafe - draftStartSafe) / previewDuration) * 100)}%`,
                    background: appliedCutEnabled
                      ? 'color-mix(in srgb, var(--ios-red) 35%, transparent)'
                      : 'color-mix(in srgb, var(--ios-red) 22%, transparent)',
                    pointerEvents: 'none',
                  }}
                />
              )}
            </div>
            <input
              type="range"
              min={0}
              max={previewEffectiveDuration}
              step={0.01}
              value={Math.min(previewTime, previewEffectiveDuration || previewTime || 0)}
              onChange={e => handleSeek(Number(e.target.value))}
            />
          </div>
          <audio
            ref={audioRef}
            src={previewAudioSrc}
            preload="metadata"
            onPause={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            onEnded={() => {
              setIsPlaying(false)
              setPreviewTime(0)
            }}
            onLoadedMetadata={e => {
              const d = Number(e.currentTarget.duration || 0)
              if (d > 0) setPreviewDuration(d)
            }}
            style={{ display: 'none' }}
          />
        </div>
      )}

      <CmdPreview cmd={cmd} />

      <ConvertFooter
        state={state} progress={progress} speed={speed} fps={fps} error={error}
        onConvert={handleConvert} onReset={state === 'running' ? cancel : reset}
        disabled={!file}
      />
    </div>
  )
}

