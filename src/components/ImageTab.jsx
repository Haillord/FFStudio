import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import {
  SliderRow, SelectRow, ProgressBar, formatUserError, useTabState, saveOutputUnique, InlineError, PageHeader,
} from './shared'

const SD15_SAMPLERS = [
  { label: 'Euler A (Normal)', value: 'euler_a' },
  { label: 'Euler (Normal)', value: 'euler' },
  { label: 'DPM++ 2M (Karras)', value: 'dpmpp_2m_karras' },
  { label: 'DPM++ 2M (Normal)', value: 'dpmpp_2m_normal' },
  { label: 'DPM++ SDE (Karras)', value: 'dpmpp_sde_karras' },
  { label: 'DPM++ SDE (Normal)', value: 'dpmpp_sde_normal' },
  { label: 'DPM2 (Normal)', value: 'dpm2' },
]

const SDXL_SAMPLERS = [
  { label: 'Euler A (Normal)', value: 'euler_a' },
  { label: 'Euler (Normal)', value: 'euler' },
  { label: 'DPM++ 2M (Karras)', value: 'dpmpp_2m_karras' },
  { label: 'DPM++ 2M (Normal)', value: 'dpmpp_2m_normal' },
  { label: 'DPM++ SDE (Karras)', value: 'dpmpp_sde_karras' },
  { label: 'DPM++ SDE (Normal)', value: 'dpmpp_sde_normal' },
  { label: 'DPM2 (Normal)', value: 'dpm2' },
]

const IMAGE_MODEL_TYPES = [
  { label: 'SD 1.5', value: 'sd15' },
  { label: 'SDXL', value: 'sdxl' },
  { label: 'FLUX', value: 'flux' },
  { label: 'FLUX GGUF', value: 'flux_gguf' },
]

const DEFAULT_SD15_NEGATIVE = "worst quality, low quality, blurry, deformed, ugly, bad anatomy, bad hands, missing fingers, extra fingers, watermark, signature, text, cropped"

const PROFILE_DEFAULTS = {
    sd15: {
        prompt: '',
        negativePrompt: DEFAULT_SD15_NEGATIVE,
    width: 512,
    height: 512,
    steps: 20,
    cfgScale: 7.0,
    seed: -1,
    sampler: 'dpmpp_2m_karras',
    model: '',
    vaePath: '',
    selectedLoras: [],
  },
  sdxl: {
    prompt: '',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 28,
    cfgScale: 6.0,
    seed: -1,
    sampler: 'dpmpp_2m',
    model: '',
    vaePath: '',
    selectedLoras: [],
  },
  flux: {
    prompt: '',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 28,
    cfgScale: 3.5,
    seed: -1,
    sampler: 'euler',
    model: '',
    vaePath: '',
    fluxTextEncoder1: '',
    fluxTextEncoder2: '',
    fluxVaePath: '',
    fluxWeightDtype: 'default',
    selectedLoras: [],
  },
  flux_gguf: {
    prompt: '',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 28,
    cfgScale: 3.5,
    seed: -1,
    sampler: 'euler',
    model: '',
    vaePath: '',
    fluxTextEncoder1: '',
    fluxTextEncoder2: '',
    fluxVaePath: '',
    fluxWeightDtype: 'default',
    selectedLoras: [],
  },
}

function detectModelType(model = {}) {
  const name = String(model?.name || '').toLowerCase()
  const path = String(model?.path || '').replaceAll('\\', '/').toLowerCase()

  if (path.includes('/models/unet/') || path.includes('/models/diffusion_models/')) {
    if (name.endsWith('.gguf')) return 'flux_gguf'
    return 'flux'
  }
  if (name.includes('flux')) return 'flux'
  return (
    name.includes('sdxl') ||
    name.includes('xl_') ||
    name.includes('_xl') ||
    name.endsWith('xl.safetensors') ||
    name.includes('pony')
  ) ? 'sdxl' : 'sd15'
}

function normalizeLoraEntries(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((item) => {
      const path = typeof item?.path === 'string' ? item.path : ''
      const parsed = Number(item?.weight)
      const weight = Number.isFinite(parsed) ? parsed : 0.8
      if (!path) return null
      return { path, weight: Math.min(2, Math.max(0, weight)) }
    })
    .filter(Boolean)
}

function toSafeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function toSafeNumber(value, fallback, min = -Infinity, max = Infinity) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function toSafeInt(value, fallback, min = -Infinity, max = Infinity) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeProfile(type, profile) {
  const base = PROFILE_DEFAULTS[type] || PROFILE_DEFAULTS.sd15
  const p = profile && typeof profile === 'object' ? profile : {}
  return {
    ...base,
    prompt: toSafeString(p.prompt, base.prompt),
    negativePrompt: toSafeString(p.negativePrompt, base.negativePrompt),
    width: toSafeInt(p.width, base.width, 256, 2048),
    height: toSafeInt(p.height, base.height, 256, 2048),
    steps: toSafeInt(p.steps, base.steps, 1, 100),
    cfgScale: toSafeNumber(p.cfgScale, base.cfgScale, 1, 50),
    seed: toSafeInt(p.seed, base.seed, -1, 2147483647),
    sampler: toSafeString(p.sampler, base.sampler),
    model: toSafeString(p.model, base.model),
    vaePath: toSafeString(p.vaePath, base.vaePath || ''),
    fluxTextEncoder1: toSafeString(p.fluxTextEncoder1, base.fluxTextEncoder1 || ''),
    fluxTextEncoder2: toSafeString(p.fluxTextEncoder2, base.fluxTextEncoder2 || ''),
    fluxVaePath: toSafeString(p.fluxVaePath, base.fluxVaePath || ''),
    fluxWeightDtype: toSafeString(p.fluxWeightDtype, base.fluxWeightDtype || 'default'),
    selectedLoras: normalizeLoraEntries(p.selectedLoras),
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function NumericInput({ value, onChange, min, max, step = 1, unit = 'px', snapTo = 1 }) {
  const [inputStr, setInputStr] = useState(String(value))

  useEffect(() => {
    setInputStr(String(value))
  }, [value])

  function handleChange(e) {
    setInputStr(e.target.value)
  }

  function handleBlur() {
    let parsed = parseInt(inputStr, 10)
    if (isNaN(parsed)) parsed = value
    parsed = Math.max(min, Math.min(max, Math.round(parsed / snapTo) * snapTo))
    setInputStr(String(parsed))
    onChange(parsed)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') e.target.blur()
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={inputStr}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={{
          width: 70,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '6px 8px',
          color: 'var(--text)',
          fontSize: 13,
          textAlign: 'center',
        }}
      />
      {unit && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{unit}</span>}
    </div>
  )
}

import PromptGenPanel from './PromptGenPanel'

export default function ImageTab({ settings, setSettings, comfyOk, setTab }) {
  const { state: persistedImage, patchState: patchTabState } = useTabState('image', {
    modelType: 'sd15',
    profiles: PROFILE_DEFAULTS,
  }, {
    modelType: 'image_tab_model_type',
  })
  const initialModelType = IMAGE_MODEL_TYPES.some(t => t.value === persistedImage?.modelType)
    ? persistedImage.modelType
    : 'sd15'
  const [modelType, setModelType] = useState(initialModelType)
  const [profiles, setProfiles] = useState(() => {
    const raw = persistedImage?.profiles && typeof persistedImage.profiles === 'object'
      ? persistedImage.profiles
      : {}
    return {
      sd15: normalizeProfile('sd15', raw.sd15),
      sdxl: normalizeProfile('sdxl', raw.sdxl),
      flux: normalizeProfile('flux', raw.flux),
      flux_gguf: normalizeProfile('flux_gguf', raw.flux_gguf),
    }
  })
  const activeProfile = profiles[modelType] || PROFILE_DEFAULTS.sd15
  const prompt = activeProfile.prompt
  const negativePrompt = activeProfile.negativePrompt
  const width = activeProfile.width
  const height = activeProfile.height
  const steps = activeProfile.steps
  const cfgScale = activeProfile.cfgScale
  const seed = activeProfile.seed
  const sampler = activeProfile.sampler
  const model = activeProfile.model
  const vaePath = activeProfile.vaePath || ''
  const fluxTextEncoder1 = activeProfile.fluxTextEncoder1 || ''
  const fluxTextEncoder2 = activeProfile.fluxTextEncoder2 || ''
  const fluxVaePath = activeProfile.fluxVaePath || ''
  const fluxWeightDtype = activeProfile.fluxWeightDtype || 'default'
  const selectedLoras = Array.isArray(activeProfile.selectedLoras) ? activeProfile.selectedLoras : []
  const [seedStr, setSeedStr] = useState(String(activeProfile.seed))
  const [activeSubTab, setActiveSubTab] = useState(0)

  const [state, setState] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [currentStep, setCurrentStep] = useState(0)
  const [totalSteps, setTotalSteps] = useState(0)
  const [previewImage, setPreviewImage] = useState(null)
  const [outputImage, setOutputImage] = useState(null)
  const [usedSeed, setUsedSeed] = useState(null)
  const [lastSavedPath, setLastSavedPath] = useState('')
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [batchCount, setBatchCount] = useState(1)
  const [batchCurrent, setBatchCurrent] = useState(0)
  const [batchTotal, setBatchTotal] = useState(0)
  const [error, setError] = useState('')
  const [availableModels, setAvailableModels] = useState([])
  const [availableVaes, setAvailableVaes] = useState([])
  const [availableLoras, setAvailableLoras] = useState([])
  const [availableFluxTextEncoders, setAvailableFluxTextEncoders] = useState([])
  const [quickSetupStatus, setQuickSetupStatus] = useState('')
  const [quickSetupBusy, setQuickSetupBusy] = useState(false)
  const [translatingPrompt, setTranslatingPrompt] = useState(false)
  const [translatingNegativePrompt, setTranslatingNegativePrompt] = useState(false)
  const [enhancingPrompt, setEnhancingPrompt] = useState(false)
  const [viewer, setViewer] = useState({ open: false, src: '', title: '', zoom: 1 })
  const [viewerPan, setViewerPan] = useState({ x: 0, y: 0 })
  const [viewerDragging, setViewerDragging] = useState(false)
  const [viewerFitMode, setViewerFitMode] = useState(true)
  const viewerDragRef = useRef({ active: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 })
  const navigatingRef = useRef(false)

  // Галерея
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [galleryFiles, setGalleryFiles] = useState([])
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [galleryViewerIndex, setGalleryViewerIndex] = useState(-1)

  // Экспортируем глобально открытие галереи для кнопки в хедере
  useEffect(() => {
    window.openImageGallery = async () => {
      if (galleryOpen) return
      setGalleryOpen(true)
      setGalleryLoading(true)
      try {
        const files = await invoke('get_gallery_files', { outputDir: settings.outputDir || '' })
        setGalleryFiles(files)
      } catch {
        setGalleryFiles([])
      } finally {
        setGalleryLoading(false)
      }
    }
    return () => { delete window.openImageGallery }
  }, [galleryOpen, settings.outputDir])

  const unlistenRef = useRef(null)

  useEffect(() => {
    patchTabState({ modelType, profiles })
  }, [modelType, profiles])

  useEffect(() => {
    setSeedStr(String(seed))
  }, [seed, modelType])

  // При монтировании и если есть история - восстанавливаем последнюю картинку
  useEffect(() => {
    if (historyIndex >= 0 && historyIndex < history.length) {
      const item = history[historyIndex]
      setOutputImage(item.image)
      setUsedSeed(item.seed)
      setLastSavedPath(item.savedPath || '')
    }
  }, [])

  useEffect(() => {
    if (!viewer.open) return
    function onKeyDown(e) {
      if (e.key === 'Escape') setViewer(v => ({ ...v, open: false }))
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (galleryViewerIndex === -1) {
          if (historyIndex > 0) {
            handleHistoryPrev();
            if (historyIndex > 0) {
              const prevItem = history[historyIndex - 1];
              setViewer(v => ({ ...v, src: prevItem.image, title: `История ${historyIndex}/${history.length}` }));
            }
          }
        } else {
          navigateGalleryViewer(-1);
        }
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (galleryViewerIndex === -1) {
          if (historyIndex < history.length - 1) {
            handleHistoryNext();
            if (historyIndex < history.length - 1) {
              const nextItem = history[historyIndex + 1];
              setViewer(v => ({ ...v, src: nextItem.image, title: `История ${historyIndex + 2}/${history.length}` }));
            }
          }
        } else {
          navigateGalleryViewer(1);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewer.open, galleryViewerIndex, historyIndex, history])

  function updateActiveProfile(patch) {
    setProfiles(prev => ({
      ...prev,
      [modelType]: normalizeProfile(modelType, {
        ...(prev[modelType] || PROFILE_DEFAULTS[modelType]),
        ...patch,
      }),
    }))
  }

  function handleHeightChange(val) {
    const snapped = Math.round(val / 64) * 64
    updateActiveProfile({ height: snapped })
  }

  function handleRandomSeed() {
    const r = Math.floor(Math.random() * 2147483647)
    updateActiveProfile({ seed: r })
    setSeedStr(String(r))
  }

  function handleAutoSeed() {
    updateActiveProfile({ seed: -1 })
    setSeedStr('-1')
  }

  async function refreshModels() {
    try {
      const allModels = await invoke('scan_stable_diffusion_models', { comfyDir: settings.comfyDir || '' })
      const filtered = asArray(allModels).filter(m => {
        return detectModelType(m) === modelType
      })
      setAvailableModels(filtered)
      if (filtered.length > 0 && !filtered.some(m => m.path === model)) {
        updateActiveProfile({ model: filtered[0].path })
      }
      if (filtered.length === 0) {
        updateActiveProfile({ model: '' })
      }
    } catch {
      setAvailableModels([])
    }
  }

  async function refreshLoras() {
    try {
      const loras = asArray(await invoke('scan_lora_models', { comfyDir: settings.comfyDir || '' }))
      setAvailableLoras(loras)
      updateActiveProfile({
        selectedLoras: selectedLoras.filter(item => loras.some(l => l.path === item.path)),
      })
    } catch {
      setAvailableLoras([])
    }
  }

  async function refreshVaes() {
    try {
      const vaes = asArray(await invoke('scan_vae_models', { comfyDir: settings.comfyDir || '' }))
      setAvailableVaes(vaes)
      if (vaePath && !vaes.some(v => v.path === vaePath)) {
        updateActiveProfile({ vaePath: '' })
      }
    } catch {
      setAvailableVaes([])
    }
  }

  async function refreshFluxTextEncoders() {
    try {
      const textEncoders = asArray(await invoke('scan_flux_text_encoders', { comfyDir: settings.comfyDir || '' }))
      setAvailableFluxTextEncoders(textEncoders)
      if (modelType === 'flux' || modelType === 'flux_gguf') {
        if (fluxTextEncoder1 && !textEncoders.some(v => v.path === fluxTextEncoder1)) {
          updateActiveProfile({ fluxTextEncoder1: '' })
        }
        if (fluxTextEncoder2 && !textEncoders.some(v => v.path === fluxTextEncoder2)) {
          updateActiveProfile({ fluxTextEncoder2: '' })
        }
      }
    } catch {
      setAvailableFluxTextEncoders([])
    }
  }

  useEffect(() => {
    refreshModels()
    refreshVaes()
    refreshLoras()
    if (modelType === 'flux' || modelType === 'flux_gguf') refreshFluxTextEncoders()
  }, [settings.comfyDir, modelType])

  function handleModelTypeChange(nextType) {
    if (nextType === modelType) return
    setModelType(nextType)
  }

  function addLora() {
    if (asArray(availableLoras).length === 0) return
    const alreadyPaths = selectedLoras.map(l => l.path)
    const next = asArray(availableLoras).find(l => !alreadyPaths.includes(l.path))
    if (!next) return
    updateActiveProfile({ selectedLoras: [...selectedLoras, { path: next.path, weight: 0.8 }] })
  }

  function removeLora(idx) {
    updateActiveProfile({ selectedLoras: selectedLoras.filter((_, i) => i !== idx) })
  }

  function setLoraPath(idx, path) {
    updateActiveProfile({ selectedLoras: selectedLoras.map((l, i) => i === idx ? { ...l, path } : l) })
  }

  function setLoraWeight(idx, weight) {
    updateActiveProfile({ selectedLoras: selectedLoras.map((l, i) => i === idx ? { ...l, weight } : l) })
  }

  async function handleGenerate() {
    if (!prompt.trim() || !model) return
    if (steps < 1 || steps > 50) {
      setError('Шаги должны быть в диапазоне 1..50')
      setState('error')
      return
    }
    if (cfgScale < 1 || cfgScale > 30) {
      setError('CFG Scale должен быть в диапазоне 1..30')
      setState('error')
      return
    }
    if (width < 256 || width > 2048 || height < 256 || height > 2048) {
      setError('Размер изображения должен быть в пределах 256..2048')
      setState('error')
      return
    }
    if (modelType === 'flux' || modelType === 'flux_gguf') {
      if (!fluxTextEncoder1 || !fluxTextEncoder2 || !fluxVaePath) {
        setError('Для FLUX нужно выбрать Text Encoder 1, Text Encoder 2 и FLUX VAE')
        setState('error')
        return
      }
    }
    setState('generating')
    setProgress(0)
    setCurrentStep(0)
    setTotalSteps(steps)
    setError('')

    try {
      if (unlistenRef.current) unlistenRef.current()

      const unlistenProgress = await listen('sd-progress', ({ payload }) => {
        setProgress(payload.percent ?? 0)
        setCurrentStep(payload.step ?? 0)
        setTotalSteps(payload.totalSteps ?? steps)
        if (payload.preview) {
          setPreviewImage(`data:image/png;base64,${payload.preview}`)
        }
      })
      unlistenRef.current = unlistenProgress

      const result = await invoke('stable_diffusion_generate', {
        args: {
      prompt: prompt.trim(),
      negativePrompt: modelType === 'flux' || modelType === 'flux_gguf'
        ? ''
        : modelType === 'sd15'
        ? (negativePrompt.trim() || DEFAULT_SD15_NEGATIVE)
        : negativePrompt.trim(),
          width,
          height,
          steps,
          cfgScale,
          seed,
          sampler,
          modelPath: model,
          vaePath,
          loras: selectedLoras,
          comfyApiUrl: settings.comfyApiUrl || '',
          comfyDir: settings.comfyDir || '',
          outputDir: settings.outputDir || '',
          keepComfyCopy: !!settings.keepComfyCopy,
          modelType,
          fluxTextEncoder1,
          fluxTextEncoder2,
          fluxVaePath,
          fluxWeightDtype,
        }
      })

      unlistenProgress()
      const generated = {
        image: `data:image/png;base64,${result.image}`,
        seed: result.seed ?? null,
        prompt: prompt.trim(),
        savedPath: result.savedPath || '',
        ts: Date.now(),
      }
      setHistory(prev => {
        const next = [...prev, generated].slice(-20)
        const newHistoryIndex = next.length - 1
        
        setHistoryIndex(newHistoryIndex)
        
        // В памяти остаются полные объекты с картинками для текущей сессии
        return next
      })
      setPreviewImage(null)
      setOutputImage(generated.image)
      if (generated.seed !== null) setUsedSeed(generated.seed)
      setLastSavedPath(generated.savedPath || '')
      setState('done')

      // ✅ ОЧЕРЕДЬ: если остались ещё картинки - запускаем следующую
      if (batchTotal > 0 && batchCurrent < batchTotal - 1) {
        setTimeout(() => {
          setBatchCurrent(prev => prev + 1)
          handleGenerate()
        }, 300)
      } else {
        // Очередь закончена
        setBatchTotal(0)
        setBatchCurrent(0)
      }
    } catch (e) {
      const msg = String(e)
      if (msg === 'CANCELLED') {
        setState('idle')
        setProgress(0)
        setCurrentStep(0)
        setTotalSteps(0)
        setPreviewImage(null)
      } else {
        setError(formatUserError(msg, 'Не удалось сгенерировать изображение'))
        setState('error')
      }
    } finally {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
    }
  }

  async function translateField(sourceText, field, setLoading) {
    if (!sourceText.trim()) return
    setLoading(true)
    try {
      const translated = await invoke('translate_ru_en', { text: sourceText.trim() })
      const result = String(translated || '').trim()
      const minLen = Math.max(4, Math.floor(sourceText.trim().length * 0.35))
      if (!result || result.length < minLen) {
        setError('Перевод выглядит неполным. Исходный текст сохранён, попробуйте переформулировать промпт.')
        return
      }
      if (field === 'prompt') updateActiveProfile({ prompt: result })
      if (field === 'negativePrompt') updateActiveProfile({ negativePrompt: result })
    } catch (e) {
      setError(formatUserError(e, 'Не удалось перевести промпт RU -> EN локально'))
      setState('error')
    } finally {
      setLoading(false)
    }
  }

  async function handleTranslatePrompt() {
    if (translatingPrompt) return
    await translateField(prompt, 'prompt', setTranslatingPrompt)
  }

  async function handleTranslateNegativePrompt() {
    if (translatingNegativePrompt) return
    await translateField(negativePrompt, 'negativePrompt', setTranslatingNegativePrompt)
  }

  async function handleEnhancePrompt() {
    if (enhancingPrompt || !prompt.trim()) return
    setEnhancingPrompt(true)
    setError('')
    try {
      const result = await invoke('generate_sd_prompt', {
        description: prompt,
        style: 'none',
        modelType: modelType,
      })
      if (result && result.trim()) {
        updateActiveProfile({ prompt: result.trim() })
      }
    } catch (e) {
      setError(formatUserError(e, 'Не удалось улучшить промпт'))
    } finally {
      setEnhancingPrompt(false)
    }
  }

  async function handleQuickAutoSetup() {
    setQuickSetupBusy(true)
    setQuickSetupStatus('Автонастройка...')
    try {
      const result = await invoke('auto_setup_comfyui')
      setSettings(s => ({
        ...s,
        comfyApiUrl: result.comfyApiUrl || s.comfyApiUrl,
        comfyDir: result.comfyDir || s.comfyDir,
        comfyPython: result.comfyPython || s.comfyPython,
      }))
      setQuickSetupStatus(`✓ ${result.message}`)
      await refreshModels()
      await refreshLoras()
    } catch (e) {
      setQuickSetupStatus(`✗ ${formatUserError(e, 'Не удалось автонастроить ComfyUI')}`)
    } finally {
      setQuickSetupBusy(false)
    }
  }

  async function handleQuickInstall() {
    setQuickSetupBusy(true)
    setQuickSetupStatus('Установка...')
    try {
      let installDir = settings.comfyInstallDir || ''
      if (!installDir) {
        const selected = await openDialog({ directory: true, multiple: false })
        installDir = Array.isArray(selected) ? selected[0] : selected
        if (!installDir) {
          setQuickSetupStatus('Отменено пользователем')
          return
        }
      }

      const result = await invoke('install_comfyui_portable', { installDir })
      setSettings(s => ({
        ...s,
        comfyInstallDir: installDir || s.comfyInstallDir,
        comfyApiUrl: result.comfyApiUrl || s.comfyApiUrl,
        comfyDir: result.comfyDir || s.comfyDir,
        comfyPython: result.comfyPython || s.comfyPython,
      }))
      setQuickSetupStatus(`✓ ${result.message}`)
      await refreshModels()
      await refreshLoras()
    } catch (e) {
      setQuickSetupStatus(`✗ ${formatUserError(e, 'Не удалось установить ComfyUI')}`)
    } finally {
      setQuickSetupBusy(false)
    }
  }

  async function handleCancel() {
    await invoke('cancel_stable_diffusion').catch(() => {})
  }

  function handleReset() {
    setState('idle')
    setProgress(0)
    setCurrentStep(0)
    setTotalSteps(0)
    setError('')
    setPreviewImage(null)
    setOutputImage(null)
    setUsedSeed(null)
    setLastSavedPath('')
  }

  async function loadHistoryItem(idx) {
    const item = history[idx]
    setHistoryIndex(idx)
    setUsedSeed(item.seed)
    setLastSavedPath(item.savedPath || '')

    // Если картинка уже есть в памяти - показываем сразу
    if (item.image) {
      setOutputImage(item.image)
      return
    }

    // Если есть путь к файлу - подгружаем с диска
    if (item.savedPath) {
      try {
        const b64 = await invoke('read_file_base64', { path: item.savedPath })
        const imageUrl = `data:image/png;base64,${b64}`
        
        // ✅ ФИКС ГОНКИ СОСТОЯНИЙ: проверяем что мы всё ещё на этом индексе
        setHistory(prev => {
          // Обновляем только если пользователь ещё не ушёл с этой картинки
          return prev.map((h, i) => i === idx ? { ...h, image: imageUrl } : h)
        })
        
        // Обновляем отображение только если мы всё ещё на нужном индексе
        setHistoryIndex(current => {
          if (current === idx) {
            setOutputImage(imageUrl)
          }
          return current
        })
      } catch {
        // Файл был удалён - ничего страшного
        setHistoryIndex(current => {
          if (current === idx) {
            setOutputImage(null)
          }
          return current
        })
      }
    } else {
      setOutputImage(null)
    }
  }

  function handleHistoryPrev() {
    if (history.length === 0 || historyIndex <= 0) return
    loadHistoryItem(historyIndex - 1)
  }

  function handleHistoryNext() {
    if (history.length === 0 || historyIndex >= history.length - 1) return
    loadHistoryItem(historyIndex + 1)
  }

  function handleReuseLastSeed() {
    if (usedSeed !== null) {
      updateActiveProfile({ seed: usedSeed })
      setSeedStr(String(usedSeed))
    }
  }

  async function saveImageData(data, stem = 'image') {
    try {
      if (!data) return
      const savePath = await saveOutputUnique({
        defaultStem: stem,
        extension: 'png',
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
        targetDir: settings.outputDir || '',
      })
      if (savePath) {
        await invoke('save_base64_image', { data, path: savePath })
      }
    } catch (e) {
      setError(formatUserError(e, 'Не удалось сохранить изображение'))
      setState('error')
    }
  }

  async function handleSaveImage() {
    await saveImageData(outputImage, 'image')
  }

  function openViewer(src, title, galleryIndex = -1) {
    if (!src) return
    setViewer({ open: true, src, title, zoom: 1 })
    setViewerPan({ x: 0, y: 0 })
    setViewerDragging(false)
    setViewerFitMode(true)
    setGalleryViewerIndex(galleryIndex)
  }

  async function navigateGalleryViewer(dir) {
    if (navigatingRef.current) return
    const nextIndex = galleryViewerIndex + dir
    if (nextIndex < 0 || nextIndex >= galleryFiles.length) return

    navigatingRef.current = true
    const item = galleryFiles[nextIndex]
    
    try {
      const b64 = await invoke('read_file_base64', { path: item.path })
      
      // ✅ ОКОНЧАТЕЛЬНЫЙ ФИКС: Атомарно обновляем ВСЁ за один раз
      setViewer(v => ({ ...v, src: `data:image/png;base64,${b64}`, title: item.filename }))
      setGalleryViewerIndex(nextIndex)
    } catch {
    } finally {
      setTimeout(() => { navigatingRef.current = false }, 200)
    }
  }

  function closeViewer() {
    setViewer(v => ({ ...v, open: false }))
    setViewerDragging(false)
    viewerDragRef.current.active = false
  }

  function zoomViewer(delta) {
    setViewer(v => {
      const nextZoom = Math.min(4, Math.max(0.5, +(v.zoom + delta).toFixed(2)))
      return { ...v, zoom: nextZoom }
    })
    setViewerFitMode(false)
  }

  function handleViewerWheel(e) {
    e.preventDefault()
    const delta = e.deltaY < 0 ? 0.1 : -0.1
    zoomViewer(delta)
  }

  function handleViewerMouseDown(e) {
    if (e.button !== 0) return
    viewerDragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: viewerPan.x,
      startPanY: viewerPan.y,
    }
    setViewerDragging(true)
  }

  function handleViewerMouseMove(e) {
    if (!viewerDragRef.current.active) return
    const dx = e.clientX - viewerDragRef.current.startX
    const dy = e.clientY - viewerDragRef.current.startY
    setViewerPan({
      x: viewerDragRef.current.startPanX + dx,
      y: viewerDragRef.current.startPanY + dy,
    })
  }

  function stopViewerDrag() {
    if (!viewerDragRef.current.active) return
    viewerDragRef.current.active = false
    setViewerDragging(false)
  }

  function toggleViewerFit() {
    setViewerPan({ x: 0, y: 0 })
    setViewerDragging(false)
    viewerDragRef.current.active = false
    if (viewerFitMode) {
      setViewer(v => ({ ...v, zoom: 1 }))
      setViewerFitMode(false)
    } else {
      setViewer(v => ({ ...v, zoom: 1 }))
      setViewerFitMode(true)
    }
  }

  async function handleCopyToClipboard() {
    try {
      if (!outputImage) return
      const res = await fetch(outputImage)
      const blob = await res.blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } catch (e) {
      setError(formatUserError(e, 'Не удалось скопировать изображение в буфер'))
      setState('error')
    }
  }

  const isGenerating = state === 'generating'
  const comfyReady = comfyOk === true
  const canGenerate =
    prompt.trim().length > 0 &&
    !!model &&
    !isGenerating &&
    comfyReady &&
    steps >= 1 && steps <= 50 &&
    (modelType === 'flux' || modelType === 'flux_gguf' || (cfgScale >= 1 && cfgScale <= 30)) &&
    width >= 256 && width <= 2048 &&
    height >= 256 && height <= 2048 &&
    ((modelType !== 'flux' && modelType !== 'flux_gguf') || (!!fluxTextEncoder1 && !!fluxTextEncoder2 && !!fluxVaePath))
  const samplerOptions = modelType === 'sd15' ? SD15_SAMPLERS : SDXL_SAMPLERS
  const safeModels = asArray(availableModels)
  const safeVaes = asArray(availableVaes)
  const safeLoras = asArray(availableLoras)
  const safeFluxTextEncoders = asArray(availableFluxTextEncoders)

  useEffect(() => {
    if (!Array.isArray(samplerOptions) || samplerOptions.length === 0) return
    const valid = samplerOptions.some(opt => opt.value === sampler)
    if (!valid) {
      updateActiveProfile({ sampler: samplerOptions[0].value })
    }
  }, [modelType, sampler])

  return (
    <div className="content">

      {/* Саб-табы */}
      <div className="media-sub-tabs" style={{ marginBottom: 6, marginTop: 4 }}>
        <button
          className={`media-sub-tab ${activeSubTab === 0 ? 'active' : ''}`}
          onClick={() => setActiveSubTab(0)}
        >
          📸 Генерация
        </button>
        <button
          className={`media-sub-tab ${activeSubTab === 1 ? 'active' : ''}`}
          onClick={() => setActiveSubTab(1)}
        >
          ✨ Генератор промптов
        </button>
      </div>

      {activeSubTab === 0 && (
        <>
      {!comfyReady && (
        <div className="card" style={{ border: '1px solid var(--ios-orange)' }}>
          <div className="card-header" style={{ alignItems: 'center' }}>
            <span className="card-title">AI Backend не настроен</span>
            <span className="badge badge-orange">Требуется ComfyUI</span>
          </div>
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Для генерации изображений нужен локальный ComfyUI. Используйте быстрый мастер ниже.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={handleQuickInstall} disabled={quickSetupBusy}>
                Установить
              </button>
              <button className="btn btn-secondary" onClick={handleQuickAutoSetup} disabled={quickSetupBusy}>
                Автонастройка
              </button>
              <button className="btn btn-secondary" onClick={() => setTab('settings')} disabled={quickSetupBusy}>
                Открыть настройки
              </button>
            </div>
            {!!quickSetupStatus && (
              <div style={{
                fontSize: 12,
                color: quickSetupStatus.startsWith('✓') ? 'var(--ios-green)' : (quickSetupStatus.startsWith('✗') ? 'var(--ios-red)' : 'var(--text-secondary)')
              }}>
                {quickSetupStatus}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Промпт */}
      <div className="card">
        <div className="card-header" style={{ alignItems: 'center' }}>
          <span className="card-title">{modelType === 'sdxl' ? 'Stable Diffusion XL' : (modelType === 'flux_gguf' ? 'FLUX GGUF' : (modelType === 'flux' ? 'FLUX' : 'Stable Diffusion 1.5'))}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn btn-secondary"
              onClick={handleTranslatePrompt}
              disabled={isGenerating || translatingPrompt || !prompt.trim()}
              style={{ padding: '6px 10px', fontSize: 12 }}
              title="Локальный перевод RU -> EN"
            >
              {translatingPrompt ? '⏳ RU -> EN...' : 'RU -> EN'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleEnhancePrompt}
              disabled={isGenerating || enhancingPrompt || !prompt.trim()}
              style={{ padding: '6px 10px', fontSize: 12 }}
              title="Автоматически улучшить промпт"
            >
              {enhancingPrompt ? '⏳ ✨...' : '✨'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleTranslateNegativePrompt}
              disabled={isGenerating || translatingNegativePrompt || !negativePrompt.trim()}
              style={{ padding: '6px 10px', fontSize: 12 }}
              title="Локальный перевод RU -> EN для негативного промпта"
            >
              {translatingNegativePrompt ? '⏳ Neg...' : 'Neg RU->EN'}
            </button>
            <input
              type="number"
              min={1}
              max={20}
              value={batchCount}
              onChange={e => setBatchCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
              style={{
                width: 50,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '5px 6px',
                color: 'var(--text)',
                fontSize: 13,
                textAlign: 'center',
              }}
            />
            {isGenerating ? (
              <button className="btn btn-danger" onClick={handleCancel} style={{ padding: '6px 12px', fontSize: 13 }}>
                {batchTotal > 0 ? `Отмена (${batchCurrent}/${batchTotal})` : 'Отмена'}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => { setBatchCurrent(0); setBatchTotal(batchCount); handleGenerate(); }} disabled={!canGenerate} style={{ padding: '6px 16px', fontSize: 13 }}>
                Генерировать {batchCount} шт
              </button>
            )}
          </div>
        </div>

        {isGenerating && (
          <div style={{ padding: '0 16px 12px' }}>
            <ProgressBar percent={progress} />
            <div style={{ fontSize: 12, fontWeight: 400, fontFamily: 'JetBrains Mono, SF Mono, Fira Code, Consolas, monospace', color: 'var(--text-secondary)', marginTop: 4, textAlign: 'right', fontVariantNumeric: 'tabular-nums', filter: 'blur(0.3px)' }}>
              {currentStep} / {totalSteps || steps} · {Math.round(progress)}%
            </div>
          </div>
        )}

        {error && (
          <div style={{ padding: '0 16px 16px' }}>
            <InlineError message={error} />
          </div>
        )}

        <div style={{ padding: '0 16px 16px' }}>
          <textarea
            value={prompt}
            onChange={e => updateActiveProfile({ prompt: e.target.value })}
            placeholder="Опишите что нужно сгенерировать..."
            rows={3}
            style={{
              width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '15px 12px', color: 'var(--text)', fontSize: 14,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 12,
            }}
          />
          <textarea
            value={negativePrompt}
            onChange={e => updateActiveProfile({ negativePrompt: e.target.value })}
            placeholder="Негативный промпт..."
            rows={2}
            style={{
              width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '5px 12px', color: 'var(--text-muted)', fontSize: 13,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />

        {(previewImage || outputImage) && (
          <div style={{ marginTop: 16, position: 'relative' }}>
              {/* Стрелка влево на главном экране */}
              {historyIndex > 0 && (
                <button
                  onClick={handleHistoryPrev}
                  style={{
                    position: 'absolute',
                    left: 12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 10,
                    background: 'rgba(0,0,0,0.45)',
                    border: 'none',
                    borderRadius: '50%',
                    width: 48,
                    height: 48,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  opacity: 0.18,
                  transition: 'opacity 120ms, transform 120ms',
                    backdropFilter: 'blur(3px)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; e.currentTarget.style.transform = 'translateY(-50%) scale(1.08)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.18; e.currentTarget.style.transform = 'translateY(-50%) scale(1)'; }}
                  title="Предыдущая картинка"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                    <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                  </svg>
                </button>
              )}

              {/* Стрелка вправо на главном экране */}
              {historyIndex < history.length - 1 && (
                <button
                  onClick={handleHistoryNext}
                  style={{
                    position: 'absolute',
                    right: 12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 10,
                    background: 'rgba(0,0,0,0.45)',
                    border: 'none',
                    borderRadius: '50%',
                    width: 48,
                    height: 48,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  opacity: 0.18,
                  transition: 'opacity 120ms, transform 120ms',
                    backdropFilter: 'blur(3px)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; e.currentTarget.style.transform = 'translateY(-50%) scale(1.08)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.18; e.currentTarget.style.transform = 'translateY(-50%) scale(1)'; }}
                  title="Следующая картинка"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                    <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/>
                  </svg>
                </button>
              )}
              <div style={{ position: 'relative' }}>
                <img
                  src={previewImage || outputImage}
                  alt="Generated"
                  onClick={() => outputImage && openViewer(outputImage, 'Результат')}
                  title={previewImage ? '' : ''}
                  style={{ maxWidth: '100%', maxHeight: '75vh', width: 'auto', height: 'auto', margin: '0 auto', borderRadius: 8, cursor: previewImage ? 'default' : 'zoom-in', display: 'block', transition: 'opacity 150ms linear' }}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const x = e.clientX - rect.left
                    const leftZone = x < 110 && historyIndex > 0
                    const rightZone = x > rect.width - 110 && historyIndex < history.length - 1
                    e.currentTarget.style.cursor = leftZone || rightZone ? 'pointer' : 'zoom-in'
                  }}
                />
                
                {previewImage && isGenerating && (
                  <div style={{
                    position: 'absolute',
                    bottom: 12,
                    right: 12,
                    background: 'rgba(0, 0, 0, 0.7)',
                    color: 'white',
                    padding: '6px 12px',
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    backdropFilter: 'blur(4px)',
                  }}>
                    ✨ Шаг {currentStep} / {totalSteps}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {usedSeed !== null && (
                    <>
                      <span className="seed-value">{usedSeed}</span>
                      <button className="btn btn-secondary" onClick={handleReuseLastSeed} title="Зафиксировать seed" style={{ padding: '2px 8px', fontSize: 11 }}>
                        Зафиксировать
                      </button>
                    </>
                  )}
                </div>
                <span style={{ fontSize: 15, fontWeight: 500 }}>
                  {history.length > 0 ? `${historyIndex + 1} / ${history.length}` : '0 / 0'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Параметры */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Параметры</span>
        </div>

        <SelectRow
          label="Тип модели"
          value={modelType}
          onChange={handleModelTypeChange}
          options={IMAGE_MODEL_TYPES}
        />

        {/* Модель */}
        <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
          <span className="row-label">Модель</span>
          <div style={{ display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
            {safeModels.length > 0 ? (
              <select
                value={model}
                onChange={e => updateActiveProfile({ model: e.target.value })}
                style={{
                  flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 8px', color: 'var(--text)', fontSize: 13,
                }}
              >
                {safeModels.map(m => (
                  <option key={m.path} value={m.path}>{m.name}</option>
                ))}
              </select>
            ) : (
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>
                {modelType === 'sdxl'
                  ? 'Положите SDXL .safetensors в models/stable-diffusion (например имя с sdxl/xl)'
                  : (modelType === 'flux' || modelType === 'flux_gguf')
                    ? 'Положите FLUX модель в models/diffusion_models или models/unet'
                    : 'Положите SD 1.5 .safetensors в models/stable-diffusion'}
              </span>
            )}
            <button className="btn btn-secondary" onClick={refreshModels} title="Обновить" style={{ padding: '6px 10px', fontSize: 13 }}>🔄</button>
            <button
              className="btn btn-secondary"
              onClick={() => invoke((modelType === 'flux' || modelType === 'flux_gguf') ? 'open_flux_models_folder' : 'open_sd_models_folder', { comfyDir: settings.comfyDir || '' })}
              title="Открыть папку"
              style={{ padding: '6px 10px', fontSize: 13 }}
            >
              📂
            </button>
            <button className="btn btn-secondary" onClick={() => invoke('free_comfy_vram', { comfy_url: settings.comfyApiUrl || '' })} title="Освободить видеопамять" style={{ padding: '6px 10px', fontSize: 13 }}>🗑️</button>
          </div>
        </div>

        {/* LoRA — прямо под моделью */}
        {modelType === 'sd15' && (
          <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
            <span className="row-label">VAE (опц.)</span>
            <div style={{ display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
              <select
                value={vaePath}
                onChange={e => updateActiveProfile({ vaePath: e.target.value })}
                style={{
                  flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 8px', color: 'var(--text)', fontSize: 13,
                }}
              >
                <option value="">Авто (VAE из checkpoint)</option>
                {safeVaes.map(v => (
                  <option key={v.path} value={v.path}>{v.name}</option>
                ))}
              </select>
              <button className="btn btn-secondary" onClick={refreshVaes} title="Обновить список VAE" style={{ padding: '6px 10px', fontSize: 13 }}>🔄</button>
              <button className="btn btn-secondary" onClick={() => invoke('open_vae_folder', { comfyDir: settings.comfyDir || '' })} title="Положите .safetensors/.ckpt/.pt в models/vae" style={{ padding: '6px 10px', fontSize: 13 }}>📂</button>
            </div>
          </div>
        )}

        {/* LoRA — прямо под моделью */}
        {modelType !== 'flux' && modelType !== 'flux_gguf' && (
        <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
          <span className="row-label">LoRA</span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Кнопки управления */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn btn-primary"
                onClick={addLora}
                disabled={safeLoras.length === 0 || selectedLoras.length >= safeLoras.length}
                style={{ padding: '5px 12px', fontSize: 13 }}
              >
                + Добавить
              </button>
              <button className="btn btn-secondary" onClick={refreshLoras} title="Обновить список" style={{ padding: '5px 10px', fontSize: 13 }}>🔄</button>
              <button className="btn btn-secondary" onClick={() => invoke('open_lora_folder', { comfyDir: settings.comfyDir || '' })} title="Положите .safetensors/.pt файлы в models/loras" style={{ padding: '5px 10px', fontSize: 13 }}>📂</button>
            </div>

            {/* Список выбранных LoRA */}
            {safeLoras.length !== 0 && selectedLoras.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}></span>
            ) : (
              selectedLoras.map((lora, idx) => (
                <div key={idx} style={{
                  display: 'flex', gap: 8, alignItems: 'center',
                  background: 'var(--bg-secondary)', borderRadius: 8,
                  padding: '7px 10px', border: '1px solid var(--border)',
                }}>
                  <select
                    value={lora.path}
                    onChange={e => setLoraPath(idx, e.target.value)}
                    style={{
                      flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)',
                      borderRadius: 6, padding: '5px 8px', color: 'var(--text)', fontSize: 12,
                    }}
                  >
                    {safeLoras.map(m => (
                      <option key={m.path} value={m.path}>{m.name}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Вес</span>
                  <input
                    type="range" min={0} max={2} step={0.05}
                    value={lora.weight}
                    onChange={e => setLoraWeight(idx, parseFloat(e.target.value))}
                    style={{ width: 80 }}
                  />
                  <span style={{ minWidth: 34, fontSize: 12, color: 'var(--text)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                    {lora.weight.toFixed(2)}
                  </span>
                  <button className="btn btn-danger" onClick={() => removeLora(idx)} style={{ padding: '3px 8px', fontSize: 12 }}>✕</button>
                </div>
              ))
            )}
          </div>
        </div>
        )}

        <SliderRow label="Шаги" min={1} max={50} step={1} value={steps} onChange={v => updateActiveProfile({ steps: v })} unit="" />
        <SliderRow label={(modelType === 'flux' || modelType === 'flux_gguf') ? 'Guidance' : 'CFG Scale'} min={1.0} max={30.0} step={0.5} value={cfgScale} onChange={v => updateActiveProfile({ cfgScale: v })} unit="" />

        {/* Ширина */}
        <div className="row" style={{ padding: '8px 16px' }}>
          <span className="row-label">Ширина</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1 }}>
            <input type="range" min={256} max={2048} step={64} value={width}
              onChange={e => updateActiveProfile({ width: Math.round(parseInt(e.target.value) / 64) * 64 })} style={{ flex: 1 }} />
            <NumericInput value={width} onChange={val => updateActiveProfile({ width: Math.round(val / 64) * 64 })} min={256} max={2048} snapTo={64} unit="px" />
          </div>
        </div>

        {/* Высота */}
        <div className="row" style={{ padding: '8px 16px' }}>
          <span className="row-label">Высота</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flex: 1 }}>
            <input type="range" min={256} max={2048} step={64} value={height}
              onChange={e => handleHeightChange(parseInt(e.target.value))} style={{ flex: 1 }} />
            <NumericInput value={height} onChange={handleHeightChange} min={256} max={2048} snapTo={64} unit="px" />
          </div>
        </div>

        {/* Seed */}
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
                updateActiveProfile({ seed: clamped })
                setSeedStr(String(clamped))
              }}
              onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
              style={{
                width: 110, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 8px', color: 'var(--text)', fontSize: 13,
              }}
            />
            <button className="btn btn-secondary" onClick={handleRandomSeed} title="Случайный seed" style={{ padding: '5px 10px', fontSize: 14 }}>🎲</button>
            <button className="btn btn-secondary" onClick={handleAutoSeed} title="Авто seed (−1)"
              style={{ padding: '5px 10px', fontSize: 12, opacity: seed === -1 ? 1 : 0.6 }}>
              Авто
            </button>
          </div>
        </div>

        {modelType !== 'flux' && modelType !== 'flux_gguf' && (
          <SelectRow label="Семплер" value={sampler} onChange={v => updateActiveProfile({ sampler: v })} options={samplerOptions} />
        )}

        {(modelType === 'flux' || modelType === 'flux_gguf') && (
          <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
            <span className="row-label">CLIP-L</span>
            <div style={{ display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
              <select
                value={fluxTextEncoder1}
                onChange={e => updateActiveProfile({ fluxTextEncoder1: e.target.value })}
                style={{ flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text)', fontSize: 13 }}
              >
                <option value="">Выберите Text Encoder 1</option>
                {safeFluxTextEncoders.map(v => (<option key={v.path} value={v.path}>{v.name}</option>))}
              </select>
              <button className="btn btn-secondary" onClick={refreshFluxTextEncoders} title="Обновить список" style={{ padding: '6px 10px', fontSize: 13 }}>🔄</button>
              <button className="btn btn-secondary" onClick={() => invoke('open_flux_text_encoders_folder', { comfyDir: settings.comfyDir || '' })} title="Открыть models/text_encoders" style={{ padding: '6px 10px', fontSize: 13 }}>📂</button>
            </div>
          </div>
        )}

        {(modelType === 'flux' || modelType === 'flux_gguf') && (
          <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
            <span className="row-label">T5-XXL</span>
            <div style={{ display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
              <select
                value={fluxTextEncoder2}
                onChange={e => updateActiveProfile({ fluxTextEncoder2: e.target.value })}
                style={{ flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text)', fontSize: 13 }}
              >
                <option value="">Выберите Text Encoder 2</option>
                {safeFluxTextEncoders.map(v => (<option key={v.path} value={v.path}>{v.name}</option>))}
              </select>
            </div>
          </div>
        )}

        {(modelType === 'flux' || modelType === 'flux_gguf') && (
          <div className="row" style={{ padding: '8px 16px', alignItems: 'center' }}>
            <span className="row-label">FLUX VAE</span>
            <div style={{ display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
              <select
                value={fluxVaePath}
                onChange={e => updateActiveProfile({ fluxVaePath: e.target.value })}
                style={{ flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text)', fontSize: 13 }}
              >
                <option value="">Выберите FLUX VAE</option>
                {safeVaes.map(v => (<option key={v.path} value={v.path}>{v.name}</option>))}
              </select>
              <button className="btn btn-secondary" onClick={refreshVaes} title="Обновить список VAE" style={{ padding: '6px 10px', fontSize: 13 }}>🔄</button>
              <button className="btn btn-secondary" onClick={() => invoke('open_vae_folder', { comfyDir: settings.comfyDir || '' })} title="Открыть models/vae" style={{ padding: '6px 10px', fontSize: 13 }}>📂</button>
            </div>
          </div>
        )}

        {(modelType === 'flux') && (
          <SelectRow
            label="Тип весов модели"
            value={fluxWeightDtype}
            onChange={v => updateActiveProfile({ fluxWeightDtype: v })}
            options={[
              { label: 'Авто', value: 'default' },
              { label: 'fp8_e4m3fn', value: 'fp8_e4m3fn' },
              { label: 'fp8_e4m3fn_fast', value: 'fp8_e4m3fn_fast' },
              { label: 'fp8_e5m2', value: 'fp8_e5m2' },
            ]}
          />
        )}
      </div>

      {viewer.open && (
        <div
          onClick={closeViewer}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.82)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(95vw, 1400px)',
              maxHeight: '92vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff' }}>
              <strong style={{ fontSize: 14 }}>{viewer.title || 'Просмотр'}</strong>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" onClick={() => zoomViewer(-0.1)} style={{ padding: '4px 10px', fontSize: 12 }}>-</button>
                <button
                  className="btn btn-secondary"
                  onClick={() => { setViewer(v => ({ ...v, zoom: 1 })); setViewerPan({ x: 0, y: 0 }); setViewerFitMode(false) }}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {viewerFitMode ? 'Fit' : `${Math.round(viewer.zoom * 100)}%`}
                </button>
                <button className="btn btn-secondary" onClick={() => zoomViewer(0.1)} style={{ padding: '4px 10px', fontSize: 12 }}>+</button>
                <button className="btn btn-danger" onClick={closeViewer} style={{ padding: '4px 10px', fontSize: 12 }}>✕</button>
              </div>
            </div>
            <div
              onWheel={handleViewerWheel}
              onMouseDown={handleViewerMouseDown}
              onMouseMove={handleViewerMouseMove}
              onMouseUp={stopViewerDrag}
              onMouseLeave={stopViewerDrag}
              onDoubleClick={toggleViewerFit}
              style={{
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(0,0,0,0.35)',
                minHeight: 200,
                cursor: viewerDragging ? 'grabbing' : 'grab',
                userSelect: 'none',
              }}
            >
              {/* Стрелка влево */}
              {(galleryViewerIndex > 0 || (galleryViewerIndex === -1 && history.length > 1)) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (galleryViewerIndex === -1) {
                      handleHistoryPrev();
                      if (historyIndex > 0) {
                        const prevItem = history[historyIndex - 1];
                        setViewer(v => ({ ...v, src: prevItem.image, title: `История ${historyIndex}/${history.length}` }));
                      }
                    } else {
                      navigateGalleryViewer(-1);
                    }
                  }}
                  style={{
                    position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                    zIndex: 10, background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: '50%',
                    width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', opacity: 0.35, transition: 'opacity 150ms',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = 1}
                  onMouseLeave={e => e.currentTarget.style.opacity = 0.35}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                    <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                  </svg>
                </button>
              )}

              {/* Стрелка вправо */}
              {( (galleryViewerIndex >= 0 && galleryViewerIndex < galleryFiles.length - 1) || (galleryViewerIndex === -1 && history.length > 1) ) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (galleryViewerIndex === -1) {
                      handleHistoryNext();
                      if (historyIndex < history.length - 1) {
                        const nextItem = history[historyIndex + 1];
                        setViewer(v => ({ ...v, src: nextItem.image, title: `История ${historyIndex + 2}/${history.length}` }));
                      }
                    } else {
                      navigateGalleryViewer(1);
                    }
                  }}
                  style={{
                    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                    zIndex: 10, background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: '50%',
                    width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', opacity: 0.35, transition: 'opacity 150ms',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = 1}
                  onMouseLeave={e => e.currentTarget.style.opacity = 0.35}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                    <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/>
                  </svg>
                </button>
              )}
              <img
                key={viewer.src}
                src={viewer.src}
                alt={viewer.title || 'Zoomed preview'}
                style={{
                  display: 'block',
                  margin: '0 auto',
                  width: viewerFitMode ? '100%' : `${Math.round(viewer.zoom * 100)}%`,
                  maxWidth: 'none',
                  transform: `translate(${viewerPan.x}px, ${viewerPan.y}px)`,
                  transformOrigin: 'top center',
                  pointerEvents: 'none',
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Галерея */}
      {galleryOpen && (
        <div
          onClick={() => setGalleryOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.85)',
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setGalleryOpen(false)
          }}
          tabIndex={0}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(95vw, 1300px)',
              maxHeight: '92vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff' }}>
              <strong style={{ fontSize: 16 }}>📜 История генераций</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {!galleryLoading && galleryFiles.length > 0 && (
                  <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    {galleryFiles.length} картинок
                  </span>
                )}
                <button className="btn btn-danger" onClick={() => setGalleryOpen(false)} style={{ padding: '6px 14px', fontSize: 13 }}>✕ Закрыть</button>
              </div>
            </div>

            <div style={{
              background: 'var(--bg-primary)',
              borderRadius: 10,
              padding: 16,
              overflowY: 'auto',
              maxHeight: 'calc(92vh - 60px)',
            }}>

              {galleryLoading ? (
                <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)', fontSize: 15 }}>
                  Загрузка галереи...
                </div>
              ) : galleryFiles.length === 0 ? (
                <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)', fontSize: 15 }}>
                  В папке вывода пока нет сгенерированных картинок
                </div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: 12,
                }}>
                  {galleryFiles.map((item, i) => (
                    <div
                      key={i}
                      style={{
                        aspectRatio: '1 / 1',
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: '1px solid var(--border)',
                        cursor: 'pointer',
                        transition: 'transform 70ms linear, opacity 70ms linear',
                        opacity: 0.9,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; e.currentTarget.style.transform = 'scale(1.03)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.9; e.currentTarget.style.transform = 'scale(1)' }}
                      onClick={async () => {
                        try {
                          const b64 = await invoke('read_file_base64', { path: item.path })
                          openViewer(`data:image/png;base64,${b64}`, item.filename, i)
                        } catch {}
                      }}
                    >
                      <img
                        alt={item.filename}
                        loading="lazy"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          opacity: 0,
                          transition: 'opacity 150ms linear',
                          background: 'var(--bg-secondary)',
                        }}
                        onError={(e) => {
                          if (e.target.dataset.loaded) e.target.style.display = 'none'
                        }}
                        onLoad={(e) => {
                          e.target.style.opacity = 1
                        }}
                        ref={async (el) => {
                          if (!el || el.dataset.loaded) return
                          el.dataset.loaded = '1'
                          try {
                            const b64 = await invoke('read_file_base64', { path: item.path })
                            el.src = `data:image/png;base64,${b64}`
                          } catch {
                            el.style.display = 'none'
                          }
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}

            </div>
          </div>
        </div>
      )}

        </>
      )}

      {activeSubTab === 1 && (
        <div style={{ marginTop: 8 }}>
          <PromptGenPanel
            modelType={modelType}
            onApply={(text) => {
              updateActiveProfile({ prompt: text })
              setActiveSubTab(0)
            }}
            currentPrompt={prompt}
          />
        </div>
      )}

    </div>
  )
}

