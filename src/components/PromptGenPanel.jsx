// src/PromptGenPanel.jsx
// Панель генератора промптов — вставь в ImageTab рядом с textarea промпта
//
// Использование в ImageTab.jsx:
//   import PromptGenPanel from './PromptGenPanel'
//   ...
//   <PromptGenPanel
//     modelType={modelType}
//     onApply={(text) => updateActiveProfile({ prompt: text })}
//     currentPrompt={prompt}
//   />

import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// ─── Доступные стили ──────────────────────────────────────────────────────────

const STYLES = [
  { value: 'none',          label: '— без стиля —' },
  { value: 'photorealism',  label: '📷 Фотореализм' },
  { value: 'anime',         label: '🎌 Аниме' },
  { value: 'fantasy',       label: '🧝 Фэнтези' },
  { value: 'cyberpunk',     label: '🤖 Киберпанк' },
  { value: 'dark_fantasy',  label: '🦇 Тёмное фэнтези' },
  { value: 'concept_art',   label: '🎨 Концепт-арт' },
  { value: 'oil_painting',  label: '🖼️ Масляная живопись' },
  { value: 'watercolor',    label: '💧 Акварель' },
  { value: '3d_render',     label: '💠 3D рендер' },
]

// ─── Стили CSS (inline) ───────────────────────────────────────────────────────

const sx = {
  panel: {
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--bg-secondary)',
    overflow: 'hidden',
    marginBottom: 8,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '9px 14px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  body: {
    padding: '0 14px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  row: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  textarea: {
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
    minHeight: 80,
  },
  select: {
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    padding: '7px 9px',
    color: 'var(--text)',
    fontSize: 13,
    cursor: 'pointer',
    minWidth: 160,
  },
  progress: {
    height: 4,
    background: 'var(--border)',
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressBar: (pct) => ({
    height: '100%',
    width: `${Math.min(100, pct)}%`,
    background: 'var(--ios-blue)',
    transition: 'width 0.3s ease',
    borderRadius: 2,
  }),
  status: (isError) => ({
    fontSize: 12,
    color: isError ? 'var(--ios-red)' : 'var(--text-muted)',
  }),
  badgeReady: {
    fontSize: 11,
    color: 'var(--ios-green)',
    background: 'rgba(52,199,89,0.12)',
    padding: '2px 7px',
    borderRadius: 10,
  },
  badgeNeeded: {
    fontSize: 11,
    color: 'var(--ios-orange)',
    background: 'rgba(255,159,10,0.12)',
    padding: '2px 7px',
    borderRadius: 10,
  },
}

// ─── Компонент ────────────────────────────────────────────────────────────────

export default function PromptGenPanel({ modelType, onApply, currentPrompt }) {
  const [open, setOpen]             = useState(false)
  const [status, setStatus]         = useState(null)  // PromptGenStatus | null
  const [description, setDescription] = useState('')
  const [style, setStyle]           = useState('none')
  const [mode, setMode]             = useState('generate') // 'generate' | 'enhance'
  const [busy, setBusy]             = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress]     = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [error, setError]           = useState('')
  const unlistenRef = useRef(null)

  // Загружаем статус сразу при монтировании компонента
  useEffect(() => {
    loadStatus()
  }, [])

  // Переключение режима: при 'enhance' подтягиваем currentPrompt в поле
  useEffect(() => {
    if (mode === 'enhance' && currentPrompt) {
      setDescription(currentPrompt)
    }
  }, [mode])

  async function loadStatus() {
    try {
      const s = await invoke('get_prompt_gen_status')
      setStatus(s)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleInstall() {
    setInstalling(true)
    setProgress(0)
    setProgressMsg('Подготовка...')
    setError('')

    // Подписываемся на прогресс
    if (unlistenRef.current) unlistenRef.current()
    const unlisten = await listen('prompt-gen-progress', ({ payload }) => {
      setProgress(payload.percent ?? 0)
      setProgressMsg(payload.message ?? '')
      if (payload.error) {
        setError(payload.error)
        setInstalling(false)
      }
    })
    unlistenRef.current = unlisten

    try {
      const s = await invoke('install_prompt_gen')
      setStatus(s)
      setProgress(100)
      setProgressMsg('✓ Готово!')
    } catch (e) {
      setError(String(e))
    } finally {
      setInstalling(false)
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    }
  }

  async function handleGenerate() {
    if (!description.trim()) return
    setBusy(true)
    setError('')

    // Для режима 'enhance' передаём полный промпт как описание,
    // системный промпт уже знает что его надо улучшить
    const desc = mode === 'enhance'
      ? `Improve and enhance this existing SD prompt, keeping the core subject but adding more detail and quality tags: "${description}"`
      : description

    try {
      const result = await invoke('generate_sd_prompt', {
        description: desc,
        style,
        modelType: modelType ?? 'sd15',
      })
      if (result && result.trim()) {
        onApply(result.trim())
        setError('')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const isReady = status?.ready === true
  const modeLabel = mode === 'generate' ? '✨ Сгенерировать' : '✨ Улучшить'

  return (
    <div className="card" style={{ marginTop: 0 }}>

      <div style={{ padding: '16px 16px 16px' }}>

          {/* ─── Блок установки ─────────────────────────────────────────── */}
          {!isReady && (
            <div style={{
              padding: '10px 12px',
              background: 'var(--bg-primary)',
              borderRadius: 8,
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Для работы нужно скачать:<br />
                • <b>llama.cpp</b> — движок (~5MB)<br />
                • <b>Qwen2.5-3B</b> — языковая модель (~1.9GB)
              </div>

              {installing ? (
                <>
                  <div style={sx.progress}>
                    <div style={sx.progressBar(progress)} />
                  </div>
                  <div style={{ ...sx.status(false), marginTop: 6 }}>
                    {progressMsg}
                  </div>
                </>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={handleInstall}
                  style={{ padding: '7px 16px', fontSize: 13 }}
                >
                  Установить
                </button>
              )}

              {error && (
                <div style={{ ...sx.status(true), marginTop: 6 }}>{error}</div>
              )}
            </div>
          )}

          {/* ─── Рабочая панель ─────────────────────────────────────────── */}
          {isReady && (
            <>

              {/* Поле ввода */}
              <div>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={
                    mode === 'generate'
                      ? 'Опишите что хотите: девушка с кошкой у окна, закат...'
                      : 'Вставьте существующий промпт для улучшения...'
                  }
                  rows={mode === 'enhance' ? 3 : 2}
                  style={sx.textarea}
                  disabled={busy}
                />
              </div>
              <div style={{ marginTop: 12 }}>

              {/* Стиль + кнопка */}
              <div style={sx.row}>
                <select
                  value={style}
                  onChange={e => setStyle(e.target.value)}
                  style={sx.select}
                  disabled={busy}
                >
                  {STYLES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>

                <button
                  className="btn btn-primary"
                  onClick={handleGenerate}
                  disabled={busy || !description.trim()}
                  style={{ flex: 1, padding: '7px 14px', fontSize: 13 }}
                >
                  {busy ? '⏳ Генерация...' : modeLabel}
                </button>
              </div>

              {/* Подсказка */}
              {!busy && !error && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {mode === 'generate'
                    ? ''
                    : ''
                  }
                </div>
              )}

              {/* Статус генерации / ошибка */}
              {busy && (
                <div style={sx.status(false)}>
                  ⏳ Генерация промпта... (~10–30 сек)
                </div>
              )}

              {error && (
                <div style={sx.status(true)}>{error}</div>
              )}
              </div>
            </>
          )}
        </div>
    </div>
  )
}

