import { useState, useEffect } from 'react'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { formatUserError, showErrorToast, SelectRow, SliderRow, useTabState, PageHeader } from './shared'

export default function MusicTab() {
  const [audiocraftReady, setAudiocraftReady] = useState(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, message: '' })
  const [result, setResult] = useState(null)

  const { state, patchState } = useTabState('music', {
    prompt: '',
    duration: 10,
    model: 'medium'
  })
  const { prompt, duration, model } = state

  useEffect(() => { checkAudiocraft() }, [])

  useEffect(() => {
    const unlisten = listen('audiocraft-progress', ({ payload }) => {
      setProgress(payload)
    })
    return () => unlisten.then(fn => fn())
  }, [])

  async function checkAudiocraft() {
    try {
      await invoke('check_audiocraft')
      setAudiocraftReady(true)
    } catch {
      setAudiocraftReady(false)
    }
  }

  async function installAudiocraft() {
    setInstalling(true)
    setProgress({ percent: 0, message: 'Подготовка установки...' })
    try {
      await invoke('install_audiocraft')
      setAudiocraftReady(true)
    } catch (e) {
      showErrorToast(formatUserError(e))
    } finally {
      setInstalling(false)
      setProgress({ percent: 0, message: '' })
    }
  }

  async function generateMusic() {
    if (!prompt.trim()) return
    const jobId = Math.random().toString(36).substring(7)
    setProgress({ percent: 5, message: 'Загрузка модели...' })
    setResult(null)
    try {
      const res = await invoke('run_audiocraft', {
        prompt,
        model,
        duration,
        referenceAudio: '',
        jobId,
      })
      setResult(res)
      setProgress({ percent: 100, message: 'Готово!' })
    } catch (e) {
      setProgress({ percent: 0, message: '' })
      showErrorToast(formatUserError(e))
    }
  }

  async function openFolder(filePath) {
    try {
      await invoke('open_in_explorer', { path: filePath })
    } catch (e) {
      showErrorToast('Не удалось открыть папку: ' + e)
    }
  }

  if (audiocraftReady === false) {
    return (
      <div className="content" style={{ alignItems: 'center', justifyContent: 'center' }}>

        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎵</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>AudioCraft не установлен</div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
            Для генерации музыки нужно установить AudioCraft от Meta. Установка произойдёт автоматически.
          </div>
          {installing && (
            <div style={{ marginBottom: 24 }}>
              <div className="progress-bar" style={{ marginBottom: 8 }}>
                <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{progress.message}</div>
            </div>
          )}
          <button
            className="btn btn-primary"
            disabled={installing}
            onClick={installAudiocraft}
          >
            {installing ? 'Установка...' : 'Установить AudioCraft'}
          </button>
        </div>
      </div>
    )
  }

  const isGenerating = progress.percent > 0 && progress.percent < 100

  return (
    <div className="content">

      <div className="card">
        <div className="card-header">
          <span className="card-title">🎵 Генерация музыки</span>
        </div>
        <div style={{ padding: 16 }}>
          <textarea
            value={prompt}
            onChange={e => patchState({ prompt: e.target.value })}
            placeholder="Опиши музыку которую хочешь сгенерировать..."
            rows={4}
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
              marginBottom: 16,
              minHeight: 80
            }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <SelectRow
              label="Модель"
              value={model}
              onChange={value => patchState({ model: value })}
              options={[
                { value: 'small',  label: 'Small (быстро)' },
                { value: 'medium', label: 'Medium' },
                { value: 'large',  label: 'Large (качество)' },
                { value: 'melody', label: 'Melody' },
              ]}
            />
            <SliderRow
              label="Длительность"
              min={1}
              max={60}
              step={1}
              value={duration}
              onChange={value => patchState({ duration: value })}
              unit="сек"
            />
          </div>

          {isGenerating && (
            <div style={{ marginTop: 12, marginBottom: 16 }}>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                {progress.message}
              </div>
            </div>
          )}

          <button
            className="btn btn-primary"
            disabled={!audiocraftReady || isGenerating || !prompt.trim()}
            onClick={generateMusic}
            style={{ width: '100%', marginTop: 8 }}
          >
            {isGenerating ? 'Генерация...' : 'Сгенерировать'}
          </button>

          {result && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontWeight: 500, marginBottom: 8 }}>✅ Результат:</div>
              <audio
                controls
                style={{
                  width: '100%',
                  display: 'block',
                  colorScheme: 'dark',
                  borderRadius: 8,
                  marginBottom: 12,
                }}
                src={convertFileSrc(result.output_path)}
              />
              <div style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}>
                <span style={{ wordBreak: 'break-all', flex: 1 }}>{result.output_path}</span>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 12, flexShrink: 0 }}
                  onClick={() => openFolder(result.output_path)}
                >
                  Открыть папку
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

