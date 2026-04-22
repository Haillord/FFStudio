import { useState, useEffect, useCallback, useRef, Component } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './index.css'

import Sidebar from './components/Sidebar'
import { ToastViewport, ConfirmDialogHost } from './components/shared'
import MediaTab from './components/MediaTab'
import Settings from './components/Settings'
import DownloadTab from './components/DownloadTab'
import VoiceTab from './components/VoiceTab'
import RealtimeVoiceTab from './components/RealtimeVoiceTab'
import ImageTab from './components/ImageTab'
import VideoGenTab from './components/VideoGenTab'
import SubtitlesTab from './components/SubtitlesTab'
import MusicTab from './components/MusicTab'

class TabErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error || 'Unknown error'),
    }
  }

  componentDidCatch(error) {
    console.error('Tab render crashed:', error)
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, message: '' })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="content" style={{ padding: 16 }}>
          <div className="card" style={{ border: '1px solid var(--ios-red)' }}>
            <div className="card-header">
              <span className="card-title">Ошибка отрисовки вкладки</span>
            </div>
            <div style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {this.state.message || 'Неизвестная ошибка интерфейса'}
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Global progress store ────────────────────────────────────────────────────
// Shared across tabs so job-capable tabs can show progress
export function useJobs() {
  const [jobs, setJobs] = useState({}) // { jobId: ProgressEvent }

  const updateJob = useCallback((ev) => {
    setJobs(prev => ({ ...prev, [ev.job_id]: ev }))
  }, [])

  useEffect(() => {
    let unlisten
    listen('ffmpeg-progress', ({ payload }) => updateJob(payload))
      .then(fn => { unlisten = fn })
    return () => {
      if (unlisten) unlisten()
    }
  }, [updateJob])

  return { jobs, updateJob }
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('media')
  const [mediaSubTab, setMediaSubTab] = useState(() => {
    const saved = localStorage.getItem('media_last_subtab')
    const allowed = ['video', 'audio', 'gif', 'trim']
    return allowed.includes(saved) ? saved : 'video'
  })
  const [settings, setSettings] = useState(() => {
    let savedSettings = {}
    try {
      const savedSettingsRaw = localStorage.getItem('app_settings')
      savedSettings = savedSettingsRaw ? JSON.parse(savedSettingsRaw) : {}
    } catch {
      savedSettings = {}
    }
    return {
      ffmpegPath: '',
      ffprobePath: '',
      outputDir: '',
      suffix: '_converted',
      parallelJobs: 2,
      theme: 'system',
      showCmd: true,
      hwAccel: 'none',
      comfyApiUrl: 'http://127.0.0.1:8188',
      comfyDir: '',
      comfyPython: 'python',
      comfyInstallDir: '',
      keepComfyCopy: false,
      ...savedSettings,
    }
  })
  const { jobs } = useJobs()
  const [ffmpegOk, setFfmpegOk] = useState(null) // null=checking, true, false
  const [fishReady, setFishReady] = useState(null)
  const [comfyOk, setComfyOk] = useState(null)
  const [audiocraftReady, setAudiocraftReady] = useState(null)
  const [vcclientStatus, setVcclientStatus] = useState(null)
  const [whisperReady, setWhisperReady] = useState(null)
  const [comfyAutostartBusy, setComfyAutostartBusy] = useState(false)
  const comfyAutostartTriedRef = useRef(false)

  // Check ffmpeg on load
  useEffect(() => {
    invoke('check_ffmpeg', { ffmpegPath: settings.ffmpegPath })
      .then(() => setFfmpegOk(true))
      .catch(() => setFfmpegOk(false))
  }, [settings.ffmpegPath])

  // Track window maximize state
  useEffect(() => {
    const updateMaxState = async () => {
      setIsMaximized(await mainWindow.isMaximized())
    }
    
    updateMaxState()
    
    const unlistenResize = mainWindow.listen('tauri://resize', updateMaxState)
    return () => {
      unlistenResize.then(fn => fn())
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('app_settings', JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    const requested = Number(settings.parallelJobs)
    if (!Number.isFinite(requested)) return
    const parallel = Math.max(1, Math.min(4, requested))
    invoke('set_parallel_limit', { limit: parallel }).catch(() => {})
  }, [settings.parallelJobs])

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        await invoke('check_comfyui', { comfyUrl: settings.comfyApiUrl || '' })
        if (!cancelled) setComfyOk(true)
      } catch {
        if (!cancelled) setComfyOk(false)
      }
    }
    check()
    const id = setInterval(check, 15000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [settings.comfyApiUrl])

  // Attempt to auto-start ComfyUI once on app launch.
  useEffect(() => {
    if (comfyAutostartTriedRef.current) return
    comfyAutostartTriedRef.current = true

    let cancelled = false
    const ensureComfyRunning = async () => {
      const hideBadgeSoon = () => {
        window.setTimeout(() => {
          if (!cancelled) setComfyAutostartBusy(false)
        }, 2500)
      }

      try {
        await invoke('check_comfyui', { comfyUrl: settings.comfyApiUrl || '' })
        if (!cancelled) setComfyOk(true)
        return
      } catch {}

      if (!cancelled) setComfyAutostartBusy(true)

      try {
        if (settings.comfyDir && settings.comfyDir.trim()) {
          await invoke('start_comfyui', {
            comfyUrl: settings.comfyApiUrl || '',
            comfyDir: settings.comfyDir,
            pythonBin: settings.comfyPython || 'python',
          })
          if (!cancelled) setComfyOk(true)
          hideBadgeSoon()
          return
        }
      } catch {}

      try {
        const result = await invoke('auto_setup_comfyui')
        if (cancelled) return
        setSettings(prev => ({
          ...prev,
          comfyApiUrl: result.comfyApiUrl || prev.comfyApiUrl,
          comfyDir: result.comfyDir || prev.comfyDir,
          comfyPython: result.comfyPython || prev.comfyPython,
        }))
        setComfyOk(true)
      } catch {
        if (!cancelled) setComfyOk(false)
      } finally {
        hideBadgeSoon()
      }
    }

    ensureComfyRunning()
    return () => {
      cancelled = true
    }
  }, [])

  // Check FishSpeech when open voice tab
  useEffect(() => {
    if (tab === 'voice' && fishReady === null) {
      invoke('check_fish_speech')
        .then(() => setFishReady(true))
        .catch(() => setFishReady(false))
    }
  }, [tab])

  // Check AudioCraft when open music tab
  useEffect(() => {
    if (tab === 'music' && audiocraftReady === null) {
      invoke('check_audiocraft')
        .then(() => setAudiocraftReady(true))
        .catch(() => setAudiocraftReady(false))
    }
  }, [tab])

  // Check VCClient when open realtime voice tab
  useEffect(() => {
    if (tab === 'realtimevoice') {
      invoke('check_vcclient', {})
        .then(res => setVcclientStatus(res.status))
        .catch(() => setVcclientStatus('error'))
    }
  }, [tab])

  // Check Whisper when open subtitles tab
  useEffect(() => {
    if (tab === 'subtitles' && whisperReady === null) {
      invoke('check_whisper')
        .then(() => setWhisperReady(true))
        .catch(() => setWhisperReady(false))
    }
  }, [tab])

  const topbarTitles = {
    media: {
      video: '',
      audio: '',
      gif: '',
      trim: '',
    }[mediaSubTab] || '',
    voice: '',
    realtimevoice: '',
    subtitles: '',
    image: '',
    download: '',
    settings: '',
    videogen: '',
    music: '',
  }

  const [isMaximized, setIsMaximized] = useState(false)
  
  const mainWindow = getCurrentWindow()

  const minimizeWindow = (e) => {
    e.stopPropagation()
    mainWindow.minimize()
  }
  
  const maximizeWindow = async (e) => {
    e.stopPropagation()
    await mainWindow.toggleMaximize()
    setIsMaximized(await mainWindow.isMaximized())
  }
  
  const closeWindow = (e) => {
    e.stopPropagation()
    mainWindow.close()
  }

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#171717',
      overflow: 'hidden',
    }}>

    <div className="app-layout">
      <Sidebar tab={tab} setTab={setTab} />
      <ToastViewport />
      <ConfirmDialogHost />

      <div className="main-area">
        <div className="topbar">
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {tab === 'image' && (
                   <span
                     style={{
                       fontSize: 18,
                       padding: '2px 8px',
                       cursor: 'pointer',
                       userSelect: 'none',
                       marginLeft: -8,
                       opacity: 0.7,
                       transition: 'opacity 70ms linear',
                     }}
                  title="История генераций"
                  onMouseEnter={(e) => e.target.style.opacity = 1}
                  onMouseLeave={(e) => e.target.style.opacity = 0.7}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (window.openImageGallery) {
                      window.openImageGallery()
                    }
                  }}
                >
                  📜
                </span>
              )}
            </div>
            {Object.values(jobs).find(j => !j.done) && (() => {
              const active = Object.values(jobs).find(j => !j.done)
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{active.stage || 'Обработка…'}</span>
                  <div className="progress-bar" style={{ flex: 1, maxWidth: 180, marginTop: 0, height: 4 }}>
                    <div className="progress-fill" style={{ width: `${active.percent}%` }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{Math.round(active.percent)}%</span>
                </div>
              )
            })()}
          </div>
        <div className="topbar-right">

           <button
             className="coffee-btn"
             isolation: isolate
             data-tooltip="На пиццу с кофе"
             onClick={() => {
               import('@tauri-apps/plugin-shell').then(({ open }) => {
                 open('https://www.donationalerts.com/r/haillord1')
               })
             }}
           >
             ☕
             <span className="coffee-steam" aria-hidden />
             <span className="coffee-steam coffee-steam--2" aria-hidden />
           </button>
          {tab === 'media' && (
            <span className="topbar-engine-pill" title="Конвейер конвертации">
              FFmpeg
            </span>
          )}
          {tab === 'voice' && fishReady === false && (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  if (window.voiceTabDownload) window.voiceTabDownload()
                }}
              >
                Скачать модель
              </button>
              <span className="status-pill status-pill--warn">
                <span className="status-pill-dot" aria-hidden />
                FishSpeech не найден
              </span>
            </>
          )}
          {tab === 'voice' && fishReady === true && (
            <span className="status-pill status-pill--ok">
              <span className="status-pill-dot" aria-hidden />
              FishSpeech готов
            </span>
          )}
          {tab === 'media' && ffmpegOk === false && (
            <span className="status-pill status-pill--bad">
              <span className="status-pill-dot" aria-hidden />
              FFmpeg не найден
            </span>
          )}
          {tab === 'media' && ffmpegOk === true && (
            <span className="status-pill status-pill--ok">
              <span className="status-pill-dot" aria-hidden />
              FFmpeg готов
            </span>
          )}
          {comfyAutostartBusy && (
            <span className="status-pill status-pill--warn">
              <span className="status-pill-dot" aria-hidden />
              ComfyUI запускается…
            </span>
          )}
          {!comfyAutostartBusy && ['image', 'videogen', 'settings'].includes(tab) && comfyOk === false && (
            <span className="status-pill status-pill--bad">
              <span className="status-pill-dot" aria-hidden />
              ComfyUI не найден
            </span>
          )}
          {!comfyAutostartBusy && ['image', 'videogen', 'settings'].includes(tab) && comfyOk === true && (
            <span className="status-pill status-pill--ok">
              <span className="status-pill-dot" aria-hidden />
              ComfyUI online
            </span>
          )}
          {tab === 'music' && audiocraftReady === false && (
            <span className="status-pill status-pill--bad">
              <span className="status-pill-dot" aria-hidden />
              AudioCraft не найден
            </span>
          )}
          {tab === 'music' && audiocraftReady === true && (
            <span className="status-pill status-pill--ok">
              <span className="status-pill-dot" aria-hidden />
              AudioCraft готов
            </span>
          )}
          {tab === 'realtimevoice' && (vcclientStatus === 'online') && (
            <span className="status-pill status-pill--ok">
              <span className="status-pill-dot" aria-hidden />
              VCClient online
            </span>
          )}
          {tab === 'realtimevoice' && ['not_installed', 'stopped', 'starting', 'installing'].includes(vcclientStatus) && (
            <span className="status-pill status-pill--warn">
              <span className="status-pill-dot" aria-hidden />
              VCClient {vcclientStatus === 'not_installed' ? 'не установлен' : vcclientStatus === 'stopped' ? 'остановлен' : vcclientStatus === 'starting' ? 'запускается' : 'устанавливается'}
            </span>
          )}
          {tab === 'realtimevoice' && vcclientStatus === 'error' && (
            <span className="status-pill status-pill--bad">
              <span className="status-pill-dot" aria-hidden />
              VCClient ошибка
            </span>
          )}
          {tab === 'subtitles' && whisperReady === false && (
            <span className="status-pill status-pill--bad">
              <span className="status-pill-dot" aria-hidden />
              Whisper не найден
            </span>
          )}
          {tab === 'subtitles' && whisperReady === true && (
            <span className="status-pill status-pill--ok">
              <span className="status-pill-dot" aria-hidden />
              Whisper готов
            </span>
          )}
          {tab === 'download' && (
            <span className="status-pill status-pill--ok">
              <span className="status-pill-dot" aria-hidden />
              yt-dlp готов
            </span>
          )}
        </div>
        </div>

        <TabErrorBoundary resetKey={tab}>
           {tab === 'media'    && (
             <MediaTab settings={settings} jobs={jobs} onSubTabChange={setMediaSubTab} />
           )}
           {tab === 'voice'    && <VoiceTab settings={settings} fishReady={fishReady} setFishReady={setFishReady} />}
           {tab === 'realtimevoice' && <RealtimeVoiceTab />}
           {tab === 'image'    && <ImageTab settings={settings} setSettings={setSettings} comfyOk={comfyOk} setTab={setTab} />}
          {tab === 'settings' && <Settings settings={settings} setSettings={setSettings} />}
          {tab === 'videogen' && <VideoGenTab settings={settings} comfyOk={comfyOk} setTab={setTab} />}
          {tab === 'subtitles' && <SubtitlesTab />}
          {tab === 'music' && <MusicTab />}

          {/* Stubs for future tabs */}
          {tab === 'download' && <DownloadTab />}
        </TabErrorBoundary>
      </div>
    </div>
    </div>
  )
}

function Stub({ title, desc }) {
  return (
    <div className="content" style={{ alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🚧</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>{desc}</div>
      </div>
    </div>
  )
}

