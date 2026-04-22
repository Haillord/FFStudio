import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import {
  SliderRow, SelectRow, ProgressBar, formatUserError, useTabState, saveOutputUnique, InlineError, PageHeader,
} from './shared'

const DEVICES = [
  { label: 'CPU', value: 'cpu' },
  { label: 'CUDA (NVIDIA)', value: 'cuda' },
]

const VOICE_MODELS = [
  { label: 'Fish Speech 1.5 (stable)', value: 'fish_speech_1_5' },
  { label: 'Fish Audio S2 Pro (experimental)', value: 's2_mini' },
]

export default function VoiceTab({ settings, fishReady, setFishReady }) {
  const { state: persistedVoice, patchState: patchTabState } = useTabState('voice', {
    text: '', refAudioPath: '', refAudioName: '', speed: 1.0, temperature: 0.7, topP: 0.7,
    repetitionPenalty: 1.2, device: 'auto', voiceModel: 'fish_speech_1_5',
  }, {
    text: 'voice_tab_text',
    refAudioPath: 'voice_tab_ref_path',
    refAudioName: 'voice_tab_ref_name',
    speed: 'voice_tab_speed',
    temperature: 'voice_tab_temp',
    topP: 'voice_tab_top_p',
    repetitionPenalty: 'voice_tab_rep_penalty',
    device: 'voice_tab_device',
    voiceModel: 'voice_tab_model',
  })
  const [text, setText] = useState(persistedVoice.text)
  const [refAudioPath, setRefAudioPath] = useState(persistedVoice.refAudioPath)
  const [refAudioName, setRefAudioName] = useState(persistedVoice.refAudioName)
  const [speed, setSpeed] = useState(persistedVoice.speed)
  const [temperature, setTemperature] = useState(persistedVoice.temperature)
  const [topP, setTopP] = useState(persistedVoice.topP)
  const [repetitionPenalty, setRepetitionPenalty] = useState(persistedVoice.repetitionPenalty)
  const [device, setDevice] = useState(persistedVoice.device)
  const [voiceModel, setVoiceModel] = useState(persistedVoice.voiceModel)
  const [s2Ready, setS2Ready] = useState(null)

  const [state, setState] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [outputPath, setOutputPath] = useState(null)
  const [savedOutputPath, setSavedOutputPath] = useState('')
  const [error, setError] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)

  const audioRef = useRef(null)
  const unlistenRef = useRef(null)

  useEffect(() => {
    patchTabState({ text, refAudioPath, refAudioName, speed, temperature, topP, repetitionPenalty, device, voiceModel })
  }, [text, refAudioPath, refAudioName, speed, temperature, topP, repetitionPenalty, device, voiceModel])
  useEffect(() => {
    if (voiceModel !== 's2_mini') return
    let cancelled = false
    invoke('check_s2_runtime')
      .then(() => { if (!cancelled) setS2Ready(true) })
      .catch(() => { if (!cancelled) setS2Ready(false) })
    return () => { cancelled = true }
  }, [voiceModel])

  useEffect(() => {
    window.voiceTabDownload = handleDownload
    return () => { delete window.voiceTabDownload }
  }, [])

  async function handleDownload() {
    setState('downloading')
    setProgress(0)
    setError('')
    try {
      if (unlistenRef.current) unlistenRef.current()
      unlistenRef.current = await listen('fish-progress', ({ payload }) => {
        setProgress(payload.percent ?? 0)
      })
      await invoke('download_fish_speech')
      setFishReady(true)
      setState('idle')
    } catch (e) {
      setError(formatUserError(e, 'Не удалось скачать модель голоса'))
      setState('error')
    } finally {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    }
  }

  async function handleDownloadS2() {
    setState('downloading')
    setProgress(0)
    setError('')
    try {
      if (unlistenRef.current) unlistenRef.current()
      unlistenRef.current = await listen('fish-progress', ({ payload }) => {
        setProgress(payload.percent ?? 0)
      })
      await invoke('download_s2_runtime')
      setS2Ready(true)
      setState('idle')
    } catch (e) {
      setError(formatUserError(e, 'Не удалось установить S2 runtime и веса'))
      setState('error')
    } finally {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    }
  }

  async function handlePickRef() {
    const path = await openDialog({
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg'] }]
    })
    if (path) {
      const selected = Array.isArray(path) ? path[0] : path
      setRefAudioPath(selected)
      setRefAudioName(selected.split(/[\\/]/).pop())
    }
  }

  function handleClearRef() {
    setRefAudioPath('')
    setRefAudioName('')
  }

  async function handleGenerate() {
    if (!text.trim()) return
    if (speed < 0.5 || speed > 2.0) {
      setError('Скорость речи должна быть в диапазоне 0.5..2.0')
      setState('error')
      return
    }
    if (temperature < 0.1 || temperature > 1.0 || topP < 0.1 || topP > 1.0) {
      setError('Параметры temperature/top-p должны быть в диапазоне 0.1..1.0')
      setState('error')
      return
    }

    const outPath = await saveOutputUnique({
      defaultStem: 'voice',
      extension: 'wav',
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
      targetDir: settings.outputDir || '',
    })
    if (!outPath) return

    setState('generating')
    setProgress(0)
    setOutputPath(null)
    setError('')

    let unlistenLog = null
    try {
      if (unlistenRef.current) unlistenRef.current()

      unlistenLog = await listen('fish-log', ({ payload }) => {
        console.log('[Voice]', payload)
      })

      const unlistenProgress = await listen('fish-progress', ({ payload }) => {
        setProgress(payload.percent ?? 0)
      })
      unlistenRef.current = unlistenProgress

      await invoke('voice_tts', {
        args: {
          model: voiceModel,
          text: text.trim(),
          referenceAudio: refAudioPath,
          output: outPath,
          speed,
          temperature,
          topP,
          device,
        }
      })

      unlistenProgress()
      const audioData = await invoke('read_file_base64', { path: outPath })
      setOutputPath(`data:audio/wav;base64,${audioData}`)
      setSavedOutputPath(outPath)
      setState('done')
    } catch (e) {
      setError(formatUserError(e, 'Не удалось сгенерировать голос'))
      setState('error')
    } finally {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
      if (unlistenLog) unlistenLog()
    }
  }

  async function handleCancel() {
    await invoke('cancel_fish_speech').catch(() => {})
    setState('idle')
    setProgress(0)
  }

  function handleReset() {
    setState('idle')
    setProgress(0)
    setError('')
    setOutputPath(null)
    setSavedOutputPath('')
    setIsPlaying(false)
  }

  function handlePlayPause() {
    if (!audioRef.current || !outputPath) return
    if (isPlaying) {
      audioRef.current.pause()
      setIsPlaying(false)
    } else {
      audioRef.current.play()
      setIsPlaying(true)
    }
  }

  const isGenerating = state === 'generating' || state === 'downloading'
  const selectedModelReady =
    (voiceModel === 'fish_speech_1_5' && fishReady) ||
    (voiceModel === 's2_mini' && s2Ready)
  const canGenerate =
    selectedModelReady &&
    text.trim().length > 0 &&
    !isGenerating &&
    speed >= 0.5 && speed <= 2.0 &&
    temperature >= 0.1 && temperature <= 1.0 &&
    topP >= 0.1 && topP <= 1.0

  if (voiceModel === 'fish_speech_1_5' && fishReady === false) {
    return (
      <div className="content" style={{ opacity: 0.5, pointerEvents: 'none' }}>

        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>🎙</div>
          <div style={{ fontSize: 16 }}>Для работы нужно скачать модель FishSpeech 1.5</div>
          <div style={{ fontSize: 13, marginTop: 12 }}>Нажмите кнопку "Скачать модель" вверху справа</div>
        </div>
      </div>
    )
  }

  return (
    <div className="content">

      <div className="card">
        <div className="card-header" style={{ alignItems: 'center' }}>
          <span className="card-title">Текст для синтеза</span>
          <div className="actions-row">
            <span className="muted-note">{text.length} симв.</span>
            {isGenerating ? (
              <button className="btn btn-danger" onClick={handleCancel} style={{ padding: '6px 12px', fontSize: 13 }}>
                Отмена
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleGenerate} disabled={!canGenerate} style={{ padding: '6px 16px', fontSize: 13 }}>
                Генерировать
              </button>
            )}
          </div>
        </div>

        {isGenerating && (
          <div style={{ padding: '0 16px' }}>
            <ProgressBar percent={progress} />
          </div>
        )}

        {error && (
          <div style={{ padding: '16px', marginTop: 8 }}>
            <InlineError message={error} />
          </div>
        )}

        <div style={{ padding: '16px' }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Введите текст который нужно озвучить..."
            rows={5}
            style={{
              width: '100%',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 12px',
              color: 'var(--text)',
              fontSize: 14,
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />

          {outputPath && (
            <div className="actions-row end" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={handlePlayPause} style={{ padding: '6px 16px', fontSize: 13 }}>
                {isPlaying ? 'Пауза' : 'Слушать'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => savedOutputPath && invoke('open_in_explorer', { path: savedOutputPath })}
                disabled={!savedOutputPath}
                style={{ padding: '6px 12px', fontSize: 13 }}
              >
                Показать в папке
              </button>
              <button className="btn btn-secondary" onClick={handleReset} style={{ padding: '6px 12px', fontSize: 13 }}>
                Закрыть
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Параметры</span></div>
        <SelectRow label="Voice-модель" value={voiceModel} onChange={setVoiceModel} options={VOICE_MODELS} />
        {voiceModel === 's2_mini' && (
          <div className="row" style={{ padding: '8px 16px', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--ios-orange)' }}>
              Режим S2 работает через локальный runtime fish-speech (main) + checkpoints/s2-pro.
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {s2Ready === true ? (
                <span className="badge badge-green">S2 runtime готов</span>
              ) : (
                <>
                  <button
                    className="btn btn-secondary"
                    onClick={handleDownloadS2}
                    disabled={isGenerating}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                  >
                    Установить S2 runtime + веса
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Требуется Python 3.10+ и доступ к HuggingFace
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="row" style={{ padding: '8px 16px', marginTop: 8 }}>
          <span className="row-label">Референсный голос</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {refAudioPath ? (
              <>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {refAudioName}
                </span>
                <button className="btn btn-secondary" onClick={handleClearRef} style={{ padding: '4px 8px', fontSize: 12 }}>
                  Убрать
                </button>
              </>
            ) : (
              <button className="btn btn-secondary" onClick={handlePickRef} style={{ padding: '4px 12px', fontSize: 12 }}>
                Выбрать
              </button>
            )}
          </div>
        </div>
        <SliderRow label="Скорость речи" min={0.5} max={2.0} step={0.05} value={speed} onChange={setSpeed} unit="x" />
        <SliderRow label="Вариативность (Temperature)" min={0.1} max={1.0} step={0.05} value={temperature} onChange={setTemperature} unit="" />
        <SliderRow label="Top-P (разнообразие)" min={0.1} max={1.0} step={0.05} value={topP} onChange={setTopP} unit="" />
        <SliderRow label="Штраф за повторы" min={1.0} max={2.0} step={0.05} value={repetitionPenalty} onChange={setRepetitionPenalty} unit="x" />
        <SelectRow label="Устройство" value={device} onChange={setDevice} options={DEVICES} />
      </div>

      <audio ref={audioRef} src={outputPath} onEnded={() => setIsPlaying(false)} style={{ display: 'none' }} />
    </div>
  )
}

