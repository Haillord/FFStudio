import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { SliderRow, SelectRow, ProgressBar, formatUserError, useTabState, InlineError, PageHeader } from './shared'

const PROFILE_DEFAULTS = {
  prompt: '',
  negativePrompt: 'blurry, watermark, low quality, bad anatomy',
  checkpoint: '',
  motionModule: 'mm_sd_v15_v2.ckpt',
  mode: 'txt2vid',
  inputImage: '',
  denoise: 0.8,
  frames: 16,
  fps: 8,
  steps: 20,
  cfgScale: 7.0,
  seed: -1,
  width: 512,
  height: 512,
  outputFormat: 'video/h264-mp4',
}

function ImageInputRow({ label, value, onChange }) {
  async function handleBrowse() {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (selected) onChange(Array.isArray(selected) ? selected[0] : selected)
  }

  return (
    <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
      <span className="row-label">{label}</span>
      <div style={{ flex: 1, display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Путь к изображению..."
          style={{
            flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)', fontSize: 13,
          }}
        />
        <button className="btn btn-secondary" onClick={handleBrowse} style={{ padding: '6px 10px', fontSize: 13 }}>
          Обзор
        </button>
      </div>
    </div>
  )
}

// ─── Основной компонент ───────────────────────────────────────────────────────

export default function VideoGenTab({ settings, comfyOk, setTab }) {
  const { state: persisted, patchState } = useTabState('videogen', PROFILE_DEFAULTS)
  const [profile, setProfile] = useState({ ...PROFILE_DEFAULTS, ...persisted })

  const [availableCheckpoints, setAvailableCheckpoints] = useState([])
  const [availableMotionModules, setAvailableMotionModules] = useState([])
  const [state, setState] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [currentStep, setCurrentStep] = useState(0)
  const [totalSteps, setTotalSteps] = useState(0)
  const [error, setError] = useState('')
  const [errorRaw, setErrorRaw] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [ffmpegCheck, setFfmpegCheck] = useState('')
  const [adInstallStatus, setAdInstallStatus] = useState('')
  const [comfyCtlStatus, setComfyCtlStatus] = useState('')
  const [recommendedStatus, setRecommendedStatus] = useState('')
  const [recommendedBusy, setRecommendedBusy] = useState(false)
  const [seedStr, setSeedStr] = useState(String((persisted?.seed ?? PROFILE_DEFAULTS.seed)))

  const unlistenRef = useRef(null)

  useEffect(() => {
    patchState(profile)
  }, [profile])

  useEffect(() => {
    setSeedStr(String(profile.seed ?? -1))
  }, [profile.seed])

  useEffect(() => {
    setFfmpegCheck('')
  }, [profile.outputFormat])

  function patch(obj) {
    setProfile(prev => ({ ...prev, ...obj }))
  }

  async function checkFfmpegForMp4() {
    setFfmpegCheck('checking')
    try {
      const result = await invoke('check_ffmpeg', { ffmpegPath: settings.ffmpegPath || '' })
      setFfmpegCheck(`✓ FFmpeg ${result.version} — ${result.path}`)
    } catch (e) {
      setFfmpegCheck(`✗ ${formatUserError(e, 'FFmpeg не найден')}`)
    }
  }

  async function refreshCheckpoints() {
    try {
      const models = await invoke('scan_stable_diffusion_models', { comfyDir: settings.comfyDir || '' })
      setAvailableCheckpoints(models.filter(m => !m.name.toLowerCase().includes('xl')))
      if (models.length > 0 && !profile.checkpoint) {
        patch({ checkpoint: models[0].path })
      }
    } catch {
      setAvailableCheckpoints([])
    }
  }

  async function refreshMotionModules() {
    try {
      const modules = await invoke('scan_animatediff_motion_modules', { comfyDir: settings.comfyDir || '' })
      const normalized = Array.isArray(modules) ? modules.map(m => String(m.name || '').trim()).filter(Boolean) : []
      setAvailableMotionModules(normalized)

      if (normalized.length === 0) {
        patch({ motionModule: '' })
        return
      }
      if (!normalized.includes(profile.motionModule)) {
        patch({ motionModule: normalized[0] })
      }
    } catch {
      setAvailableMotionModules([])
      patch({ motionModule: '' })
    }
  }

  async function handleOpenCheckpointsFolder() {
    await invoke('open_sd_models_folder', { comfyDir: settings.comfyDir || '' }).catch(() => {})
  }

  async function handleOpenMotionFolder() {
    await invoke('open_animatediff_motion_folder', { comfyDir: settings.comfyDir || '' }).catch(() => {})
  }

  useEffect(() => {
    refreshCheckpoints()
    refreshMotionModules()
  }, [settings.comfyDir])

  function handleRandomSeed() {
    const r = Math.floor(Math.random() * 2147483647)
    patch({ seed: r })
    setSeedStr(String(r))
  }

  function handleAutoSeed() {
    patch({ seed: -1 })
    setSeedStr('-1')
  }

  async function handleGenerate() {
    setError('')
    setErrorRaw('')
    setOutputPath('')
    setState('generating')
    setProgress(0)
    setCurrentStep(0)

    setTotalSteps(profile.steps)

    try {
      if (unlistenRef.current) unlistenRef.current()
      const unlisten = await listen('sd-progress', ({ payload }) => {
        setProgress(payload.percent ?? 0)
        setCurrentStep(payload.step ?? 0)
      })
      unlistenRef.current = unlisten

      const result = await invoke('video_generate', {
        args: buildArgs(),
        comfyApiUrl: settings.comfyApiUrl || '',
      })

      unlisten()
      setOutputPath(result.output_path || '')
      setState('done')
    } catch (e) {
      const msg = String(e)
      if (msg === 'CANCELLED') {
        setState('idle')
        setProgress(0)
      } else {
        setErrorRaw(msg)
        setError(formatUserError(msg, 'Не удалось сгенерировать видео'))
        setState('error')
      }
    } finally {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    }
  }

  const missingNodes = (() => {
    const raw = String(errorRaw || '')
    const idx = raw.indexOf('MISSING_COMFY_NODES:')
    if (idx === -1) return null
    return raw.slice(idx).trim()
  })()

  async function handleInstallAnimateDiff() {
    setAdInstallStatus('installing')
    try {
      const msg = await invoke('install_animatediff_nodes', { comfyDir: settings.comfyDir || '' })
      setAdInstallStatus(`✓ ${msg}`)
      // Optional: show settings so user can restart ComfyUI quickly.
      // (We can't restart ComfyUI server process reliably from here.)
    } catch (e) {
      setAdInstallStatus(`✗ ${formatUserError(e, 'Не удалось установить AnimateDiff')}`)
    }
  }

  async function handleStartComfy() {
    setComfyCtlStatus('starting')
    try {
      const msg = await invoke('start_comfyui', {
        comfyUrl: settings.comfyApiUrl || '',
        comfyDir: settings.comfyDir || '',
        pythonBin: settings.comfyPython || 'python',
      })
      setComfyCtlStatus(`✓ ${msg}`)
    } catch (e) {
      setComfyCtlStatus(`✗ ${formatUserError(e, 'Не удалось запустить ComfyUI')}`)
    }
  }

  async function handleRestartComfy() {
    setComfyCtlStatus('restarting')
    try {
      const msg = await invoke('restart_comfyui', {
        comfyUrl: settings.comfyApiUrl || '',
        comfyDir: settings.comfyDir || '',
        pythonBin: settings.comfyPython || 'python',
      })
      setComfyCtlStatus(`✓ ${msg}`)
    } catch (e) {
      setComfyCtlStatus(`✗ ${formatUserError(e, 'Не удалось перезапустить ComfyUI')}`)
    }
  }

  async function handleInstallRecommendedMotion() {
    setRecommendedBusy(true)
    setRecommendedStatus('Установка рекомендуемой модели...')
    try {
      const out = await invoke('install_recommended_model', {
        modelId: 'ad_mm_sd_v15_v2',
        comfyDir: settings.comfyDir || '',
      })
      setRecommendedStatus(`✓ Установлено: ${out}`)
      await refreshMotionModules()
    } catch (e) {
      setRecommendedStatus(`✗ ${formatUserError(e, 'Не удалось установить модель')}`)
    } finally {
      setRecommendedBusy(false)
    }
  }

  function buildArgs() {
    return {
      model: 'animatediff',
      seed: profile.seed ?? -1,
      mode: profile.mode,
      inputImage: profile.mode === 'img2vid' ? profile.inputImage : '',
      denoise: profile.denoise,
      prompt: profile.prompt.trim(),
      negativePrompt: profile.negativePrompt.trim(),
      checkpoint: profile.checkpoint,
      motionModule: profile.motionModule,
      frames: profile.frames,
      fps: profile.fps,
      steps: profile.steps,
      cfgScale: profile.cfgScale,
      width: profile.width,
      height: profile.height,
      outputFormat: profile.outputFormat,
    }
  }

  async function handleCancel() {
    await invoke('cancel_stable_diffusion').catch(() => {})
  }

  function handleReset() {
    setState('idle')
    setProgress(0)
    setCurrentStep(0)
    setError('')
    setOutputPath('')
  }

  async function handleOpenOutput() {
    if (outputPath) await invoke('open_in_explorer', { path: outputPath }).catch(() => {})
  }

  const isGenerating = state === 'generating'
  const comfyReady = comfyOk === true
  const hasRecommendedMotion = availableMotionModules.includes('mm_sd_v15_v2.ckpt')

  const canGenerate = comfyReady && !isGenerating && (() => {
    if (!profile.motionModule) return false
    if (profile.mode === 'img2vid') return profile.prompt.trim().length > 0 && !!profile.checkpoint && !!profile.inputImage
    return profile.prompt.trim().length > 0 && !!profile.checkpoint
  })()

  return (
    <div className="content">

      {/* ComfyUI не найден */}
      {!comfyReady && (
        <div className="card" style={{ border: '1px solid var(--ios-orange)' }}>
          <div className="card-header" style={{ alignItems: 'center' }}>
            <span className="card-title">AI Backend не настроен</span>
            <span className="badge badge-orange">Требуется ComfyUI</span>
          </div>
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Генерация видео работает через ComfyUI. Установите его или откройте настройки.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => setTab?.('settings')}>
                Открыть настройки
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header" style={{ alignItems: 'center' }}>
          <span className="card-title">AnimateDiff</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {isGenerating ? (
              <button className="btn btn-danger" onClick={handleCancel} style={{ padding: '6px 12px', fontSize: 13 }}>
                Отмена
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleGenerate}
                disabled={!canGenerate}
                style={{ padding: '6px 16px', fontSize: 13 }}
              >
                Генерировать
              </button>
            )}
          </div>
        </div>

        {/* Прогресс */}
        {isGenerating && (
          <div style={{ padding: '0 16px 12px' }}>
            <ProgressBar percent={progress} />
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, textAlign: 'right' }}>
              {totalSteps > 0
                ? `Шаг ${currentStep} / ${totalSteps} · ${Math.round(progress)}%`
                : `${Math.round(progress)}%`}
            </div>
          </div>
        )}

        {/* Ошибка */}
        {error && (
          <div style={{ padding: '0 16px 16px' }}>
            <InlineError message={error} />
          </div>
        )}

        {/* One-click install for AnimateDiff custom nodes */}
        {missingNodes && (
          <div style={{ padding: '0 16px 16px' }}>
            <div className="card" style={{ padding: 12, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                AnimateDiff ноды не установлены
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Нажмите “Установить AnimateDiff” — мы клонируем `comfyui-animatediff` в папку ComfyUI/custom_nodes.
                После установки нужно перезапустить ComfyUI.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={handleInstallAnimateDiff} disabled={adInstallStatus === 'installing'}>
                  Установить AnimateDiff
                </button>
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={handleRestartComfy} disabled={comfyCtlStatus === 'starting' || comfyCtlStatus === 'restarting'}>
                  Перезапустить ComfyUI
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={handleStartComfy} disabled={comfyCtlStatus === 'starting' || comfyCtlStatus === 'restarting'}>
                  Запустить ComfyUI
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setTab?.('settings')}>
                  Открыть настройки
                </button>
                {(adInstallStatus || comfyCtlStatus) && (
                  <span style={{
                    fontSize: 12,
                    color: (String(adInstallStatus || comfyCtlStatus).startsWith('✓')) ? 'var(--ios-green)'
                      : ((adInstallStatus === 'installing' || comfyCtlStatus === 'starting' || comfyCtlStatus === 'restarting') ? 'var(--text-muted)' : 'var(--ios-red)'),
                    wordBreak: 'break-word',
                  }}>
                    {adInstallStatus === 'installing'
                      ? 'Установка AnimateDiff…'
                      : (comfyCtlStatus === 'starting'
                        ? 'Запуск ComfyUI…'
                        : (comfyCtlStatus === 'restarting'
                          ? 'Перезапуск ComfyUI…'
                          : (adInstallStatus || comfyCtlStatus)))}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Результат */}
        {state === 'done' && (
          <div style={{ padding: '0 16px 16px' }}>
            <div style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '12px 14px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>
                  ✅ Видео готово
                </div>
                {outputPath && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {outputPath}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {outputPath && (
                  <button className="btn btn-secondary" onClick={handleOpenOutput} style={{ padding: '6px 10px', fontSize: 13 }}>
                    Показать
                  </button>
                )}
                <button className="btn btn-secondary" onClick={handleReset} style={{ padding: '6px 10px', fontSize: 13 }}>
                  Закрыть
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ padding: '0 16px 16px' }}>
          <textarea
            value={profile.prompt}
            onChange={e => patch({ prompt: e.target.value })}
            placeholder="a cat walking in a sunny garden, cinematic, 4k..."
            rows={3}
            style={{
              width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 12px', color: 'var(--text-primary)', fontSize: 14,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
          <textarea
            value={profile.negativePrompt}
            onChange={e => patch({ negativePrompt: e.target.value })}
            placeholder="Негативный промпт..."
            rows={2}
            style={{
              width: '100%', marginTop: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 12px', color: 'var(--text-secondary)', fontSize: 13,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Параметры</span>
        </div>
        <SelectRow
          label="Источник"
          value={profile.mode}
          onChange={v => patch({ mode: v })}
          options={[
            { label: 'Text-to-video', value: 'txt2vid' },
            { label: 'Оживить фото (img2vid)', value: 'img2vid' },
          ]}
        />

        {profile.mode === 'img2vid' && (
          <ImageInputRow
            label="Входная картинка"
            value={profile.inputImage}
            onChange={v => patch({ inputImage: v })}
          />
        )}

        <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
          <span className="row-label">Checkpoint</span>
          <div style={{ flex: 1, display: 'flex', gap: 8 }}>
            {availableCheckpoints.length > 0 ? (
              <select
                value={profile.checkpoint}
                onChange={e => patch({ checkpoint: e.target.value })}
                style={{
                  flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 13,
                }}
              >
                {availableCheckpoints.map(m => (
                  <option key={m.path} value={m.path}>{m.name}</option>
                ))}
              </select>
            ) : (
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
                Положите SD 1.5 .safetensors в models/checkpoints
              </span>
            )}
            <button className="btn btn-secondary" onClick={handleOpenCheckpointsFolder} title="Открыть папку" style={{ padding: '6px 10px', fontSize: 13 }}>Папка</button>
            <button className="btn btn-secondary" onClick={refreshCheckpoints} title="Обновить" style={{ padding: '6px 10px', fontSize: 13 }}>Обновить</button>
          </div>
        </div>

        <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
          <span className="row-label">Motion module</span>
          <div style={{ flex: 1, display: 'flex', gap: 8 }}>
            {availableMotionModules.length > 0 ? (
              <select
                value={profile.motionModule}
                onChange={e => patch({ motionModule: e.target.value })}
                style={{
                  flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 13,
                }}
              >
                {availableMotionModules.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : (
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
                Motion module не установлен. Используйте плашку ниже.
              </span>
            )}
            <button className="btn btn-secondary" onClick={handleOpenMotionFolder} title="Открыть папку" style={{ padding: '6px 10px', fontSize: 13 }}>Папка</button>
            <button className="btn btn-secondary" onClick={refreshMotionModules} title="Обновить" style={{ padding: '6px 10px', fontSize: 13 }}>Обновить</button>
          </div>
        </div>
        {!hasRecommendedMotion && (
          <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
            <span className="row-label">Рекомендуемая модель</span>
            <div style={{
              flex: 1,
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              padding: '8px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  AnimateDiff Motion Module v2 (SD1.5)
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  Сбалансированный и самый универсальный вариант.
                </div>
                {!!recommendedStatus && (
                  <div style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: recommendedStatus.startsWith('✓')
                      ? 'var(--ios-green)'
                      : (recommendedStatus.startsWith('✗') ? 'var(--ios-red)' : 'var(--text-secondary)'),
                    wordBreak: 'break-word',
                  }}>
                    {recommendedStatus}
                  </div>
                )}
              </div>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={handleInstallRecommendedMotion}
                disabled={recommendedBusy}
              >
                {recommendedBusy ? 'Установка...' : 'Установить'}
              </button>
            </div>
          </div>
        )}

        <div className="row" style={{ padding: '8px 16px' }}>
          <span className="row-label">Разрешение</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <select
              value={profile.width}
              onChange={e => patch({ width: parseInt(e.target.value, 10) })}
              style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 13,
              }}
            >
              {[256, 384, 512, 640, 768].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>×</span>
            <select
              value={profile.height}
              onChange={e => patch({ height: parseInt(e.target.value, 10) })}
              style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 13,
              }}
            >
              {[256, 384, 512, 640, 768].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>

        <SliderRow label="Кадров" min={8} max={32} step={4} value={profile.frames} onChange={v => patch({ frames: v })} unit="" />
        <SliderRow label="FPS" min={4} max={24} step={1} value={profile.fps} onChange={v => patch({ fps: v })} unit="" />
        <SliderRow label="Шаги" min={10} max={50} step={1} value={profile.steps} onChange={v => patch({ steps: v })} unit="" />
        <SliderRow label="CFG Scale" min={1.0} max={20.0} step={0.5} value={profile.cfgScale} onChange={v => patch({ cfgScale: v })} unit="" />
        {profile.mode === 'img2vid' && (
          <SliderRow label="Denoise" min={0.1} max={1.0} step={0.05} value={profile.denoise} onChange={v => patch({ denoise: v })} unit="" />
        )}
        <SelectRow
          label="Формат вывода"
          value={profile.outputFormat}
          onChange={v => patch({ outputFormat: v })}
          options={[
            { label: 'MP4 (H.264)', value: 'video/h264-mp4' },
            { label: 'WebP', value: 'image/webp' },
            { label: 'GIF', value: 'image/gif' },
          ]}
        />
        {String(profile.outputFormat || '').startsWith('video/') && (
          <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div className="row-hint">
                Для MP4 нужен установленный <span style={{ fontFamily: 'monospace' }}>ffmpeg</span> (в PATH или путь в Настройках).
              </div>
              {ffmpegCheck && (
                <div style={{
                  marginTop: 6,
                  fontSize: 12,
                  color: ffmpegCheck.startsWith('✓') ? 'var(--ios-green)' : (ffmpegCheck === 'checking' ? 'var(--text-muted)' : 'var(--ios-red)'),
                  wordBreak: 'break-word',
                }}>
                  {ffmpegCheck === 'checking' ? 'Проверка FFmpeg…' : ffmpegCheck}
                </div>
              )}
            </div>
            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={checkFfmpegForMp4}>
              Проверить FFmpeg
            </button>
          </div>
        )}

        <div className="row" style={{ padding: '8px 16px' }}>
          <span className="row-label">Seed</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              value={seedStr}
              onChange={e => setSeedStr(e.target.value)}
              onBlur={e => {
                const v = parseInt(e.target.value, 10)
                const clamped = isNaN(v) ? -1 : v
                patch({ seed: clamped })
                setSeedStr(String(clamped))
              }}
              onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
              style={{
                width: 110, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 8px', color: 'var(--text-primary)', fontSize: 13,
              }}
            />
            <button className="btn btn-secondary" onClick={handleRandomSeed} title="Случайный seed" style={{ padding: '5px 10px', fontSize: 12 }}>Случайный</button>
            <button
              className="btn btn-secondary"
              onClick={handleAutoSeed}
              title="Авто seed (−1)"
              style={{ padding: '5px 10px', fontSize: 12, opacity: profile.seed === -1 ? 1 : 0.6 }}
            >
              Авто
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}

