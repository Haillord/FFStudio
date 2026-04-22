import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import {
  FileDropZone, SelectRow, ToggleRow,
  formatUserError, showErrorToast, useFile, PageHeader,
} from './shared'

export default function SubtitlesTab() {
  const [whisperReady, setWhisperReady] = useState(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, message: '' })
  const { file, pickFile, clearFile, loadFileInfo } = useFile()
  const [model, setModel] = useState('base')
  const [language, setLanguage] = useState('auto')
  const [saveNextToOriginal, setSaveNextToOriginal] = useState(true)
  const [customOutputDir, setCustomOutputDir] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    checkWhisper()
  }, [])

  useEffect(() => {
    const unlisten = listen('whisper-progress', ({ payload }) => {
      setProgress(payload)
    })
    return () => unlisten.then(fn => fn())
  }, [])

  async function checkWhisper() {
    try {
      await invoke('check_whisper')
      setWhisperReady(true)
    } catch {
      setWhisperReady(false)
    }
  }

  async function installWhisper() {
    setInstalling(true)
    setProgress({ percent: 0, message: 'Подготовка...' })
    try {
      await invoke('install_whisper')
      setWhisperReady(true)
    } catch (e) {
      showErrorToast(formatUserError(e))
    } finally {
      setInstalling(false)
      setProgress({ percent: 0, message: '' })
    }
  }

  async function pickOutputDir() {
    const dir = await open({ directory: true, multiple: false })
    if (dir) {
      setCustomOutputDir(dir)
      setSaveNextToOriginal(false)
    }
  }

  function getOutputPath() {
    if (!file) return ''
    if (saveNextToOriginal) {
      return file.path.replace(/\.[^/.]+$/, '.srt')
    } else if (customOutputDir) {
      const filename = file.name.replace(/\.[^/.]+$/, '.srt')
      return `${customOutputDir}/${filename}`
    }
    return ''
  }

  async function runTranscribe() {
    if (!file) return

    const jobId = Math.random().toString(36).substring(7)
    setProgress({ percent: 5, message: 'Запуск транскрибации...' })

    try {
      const result = await invoke('run_whisper', {
        input: file.path,
        model,
        language,
        jobId,
        outputPath: getOutputPath() || null
      })
      setResult(result)
      setProgress({ percent: 100, message: 'Готово!' })
    } catch (e) {
      showErrorToast(formatUserError(e))
    }
  }

  if (whisperReady === false) {
    return (
      <div className="content" style={{ alignItems: 'center', justifyContent: 'center' }}>

        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎙️</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Faster Whisper не установлен</div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
            Для генерации субтитров нужно установить faster-whisper. Установка произойдёт автоматически.
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
            onClick={installWhisper}
          >
            {installing ? 'Установка...' : 'Установить Whisper'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="content">

      <FileDropZone
        file={file}
        onPick={pickFile}
        onClear={() => {
          clearFile()
          setResult(null)
          setProgress({ percent: 0, message: '' })
        }}
        onDropPath={loadFileInfo}
        accept="Видео, Аудио"
        hint="Перетащите аудио или видео файл сюда"
      />

      {file && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <span className="card-title">Настройки субтитров</span>
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <SelectRow
                label="Модель"
                value={model}
                onChange={setModel}
                options={[
                  { value: 'tiny', label: 'Tiny (быстро)' },
                  { value: 'base', label: 'Base' },
                  { value: 'small', label: 'Small' },
                  { value: 'medium', label: 'Medium (качество)' },
                  { value: 'large-v3', label: 'Large v3 (лучшее качество)' },
                ]}
              />
              <SelectRow
                label="Язык"
                value={language}
                onChange={setLanguage}
                options={[
                  { value: 'auto', label: 'Автоопределение' },
                  { value: 'ru', label: 'Русский' },
                  { value: 'en', label: 'Английский' },
                ]}
              />
            </div>

            <ToggleRow
              label="Сохранять рядом с оригиналом"
              on={saveNextToOriginal}
              onChange={setSaveNextToOriginal}
            />

            {!saveNextToOriginal && (
              <div style={{ marginTop: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={customOutputDir}
                    readOnly
                    placeholder="Выберите папку"
                  />
                  <button className="btn btn-secondary" onClick={pickOutputDir}>
                    Обзор
                  </button>
                </div>
              </div>
            )}

            {getOutputPath() && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, padding: 8, background: 'var(--bg-fill)', borderRadius: 6 }}>
                📄 SRT будет сохранён: {getOutputPath()}
              </div>
            )}

            {progress.percent > 0 && progress.percent < 100 && (
              <div style={{ marginBottom: 16 }}>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{progress.message}</div>
              </div>
            )}

            <button 
              className="btn btn-primary"
              disabled={!whisperReady || progress.percent > 0 && progress.percent < 100 || (!saveNextToOriginal && !customOutputDir)}
              onClick={runTranscribe}
              style={{ width: '100%' }}
            >
              Начать транскрибацию
            </button>

            {result && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontWeight: 500, marginBottom: 8 }}>Результат:</div>
                <div style={{ padding: 12, background: 'var(--bg-fill)', borderRadius: 8, fontSize: 13, maxHeight: 200, overflow: 'auto' }}>
                  {result.text}
                </div>
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>SRT файл сохранён: {result.srt_path}</span>
                  <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => shell.open(result.srt_path)}>
                    Открыть папку
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

