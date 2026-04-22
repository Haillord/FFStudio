import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ProgressBar, formatUserError, useTabState, InlineError, PageHeader } from './shared'

const BUILD_OPTIONS = [
  { label: 'CUDA (NVIDIA, рекомендовано)', value: 'cuda' },
  { label: 'DirectML (AMD / Intel / запасной)', value: 'dml' },
]

const STATUS_META = {
  not_installed: { label: 'Не установлен', className: 'badge badge-gray' },
  stopped: { label: 'Остановлен', className: 'badge badge-orange' },
  starting: { label: 'Запускается', className: 'badge badge-orange' },
  online: { label: 'Online', className: 'badge badge-green' },
  installing: { label: 'Устанавливается', className: 'badge badge-orange' },
  error: { label: 'Ошибка', className: 'badge badge-red' },
}

function statusView(status) {
  return STATUS_META[status] ?? STATUS_META.error
}

export default function RealtimeVoiceTab() {
  const { state: persisted, patchState } = useTabState('realtime_voice', {
    serverUrl: 'http://127.0.0.1:18888',
    flavor: 'cuda',
  })
  const [serverUrl, setServerUrl] = useState(persisted.serverUrl)
  const [flavor, setFlavor] = useState(persisted.flavor)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [lastMessage, setLastMessage] = useState('')
  const [lastLog, setLastLog] = useState('')
  const [copied, setCopied] = useState(false)
  const progressUnlistenRef = useRef(null)

  useEffect(() => {
    patchState({ serverUrl, flavor })
  }, [serverUrl, flavor, patchState])

  useEffect(() => {
    let disposed = false

    const setup = async () => {
      progressUnlistenRef.current = await listen('vcclient-progress', ({ payload }) => {
        if (disposed) return
        if (payload?.percent != null) setProgress(payload.percent)
        if (payload?.message) setLastMessage(payload.message)
      })
    }

    setup()
    return () => {
      disposed = true
      if (progressUnlistenRef.current) {
        progressUnlistenRef.current()
        progressUnlistenRef.current = null
      }
    }
  }, [])

  const refreshStatus = async () => {
    try {
      const next = await invoke('check_vcclient', { serverUrl })
      setStatus(next)
      setLastLog(next.logTail || '')
      if (next.lastMessage) setLastMessage(next.lastMessage)
      if (next.status !== 'error') setError('')
      return next
    } catch (e) {
      setError(formatUserError(e, 'Не удалось проверить состояние VCClient'))
      return null
    }
  }

  useEffect(() => {
    refreshStatus()
    const id = window.setInterval(refreshStatus, 5000)
    return () => window.clearInterval(id)
  }, [serverUrl])

  const runAction = async (actionName, action, fallback) => {
    setBusy(actionName)
    setProgress(0)
    setError('')
    try {
      const next = await action()
      if (next?.message) setLastMessage(next.message)
      await refreshStatus()
    } catch (e) {
      setError(formatUserError(e, fallback))
    } finally {
      setBusy('')
    }
  }

  const handleInstall = () => runAction(
    'install',
    () => invoke('install_vcclient', { flavor }),
    'Не удалось установить VCClient',
  )

  const handleStart = () => runAction(
    'start',
    () => invoke('start_vcclient', { serverUrl }),
    'Не удалось запустить VCClient',
  )

  const handleStop = () => runAction(
    'stop',
    () => invoke('stop_vcclient'),
    'Не удалось остановить VCClient',
  )

  const handleOpenUi = async () => {
    try {
      await invoke('open_vcclient_ui', { serverUrl })
    } catch (e) {
      setError(formatUserError(e, 'Не удалось открыть интерфейс VCClient'))
    }
  }

  const handleCopyLog = async () => {
    if (!lastLog) return
    await navigator.clipboard.writeText(lastLog)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const handleOpenInstallDir = async () => {
    if (!status?.installDir) return
    try {
      await invoke('open_in_explorer', { path: status.installDir })
    } catch (e) {
      setError(formatUserError(e, 'Не удалось открыть папку установки VCClient'))
    }
  }

  const badge = statusView(status?.status)
  const installDir = status?.installDir || 'Будет создан автоматически'
  const canInstall = !busy
  const canStart = !busy && status?.installed && status?.status !== 'online'
  const canStop = !busy && status?.running
  const canOpen = status?.installed
  const cmdPreview = useMemo(() => {
    return `VCClient: ${flavor.toUpperCase()} · ${serverUrl || 'http://127.0.0.1:18888'}`
  }, [flavor, serverUrl])

  return (
    <div className="content">

      <div className="card">

        {(busy || progress > 0) && (
          <div style={{ padding: '12px 16px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {lastMessage || 'Выполняется операция...'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--accent-text)' }}>{Math.round(progress)}%</span>
            </div>
            <ProgressBar percent={progress} />
          </div>
        )}

        <div className="row">
          <div>
            <div className="row-label">Сборка</div>
            <div className="row-hint">Выберите тип portable-сборки перед установкой</div>
          </div>
          <select className="ios-select realtime-select" value={flavor} onChange={e => setFlavor(e.target.value)}>
            {BUILD_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="row">
          <div>
            <div className="row-label">Локальный URL</div>
            <div className="row-hint">По умолчанию VCClient стартует на 127.0.0.1:18888</div>
          </div>
          <input
            className="ios-input realtime-input"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="http://127.0.0.1:18888"
          />
        </div>

        <div className="row">
          <div>
            <div className="row-label">Папка установки</div>
            <div className="row-hint">{installDir}</div>
          </div>
          <div className="row-right">
             <button className="btn btn-secondary" onClick={refreshStatus} disabled={!!busy} title="Обновить статус">🔄</button>
             <button className="btn btn-secondary" onClick={handleStart} disabled={!canStart} title="Запустить VCClient">▶️</button>
             <button className="btn btn-danger" onClick={handleStop} disabled={!canStop} title="Остановить VCClient">⏹️</button>
             <button className="btn btn-primary" onClick={handleInstall} disabled={!canInstall}>Установить</button>
            <button className="btn btn-secondary" onClick={handleOpenUi} disabled={!canOpen}>Открыть UI</button>
            <button
              className="btn btn-secondary"
              onClick={handleOpenInstallDir}
              disabled={!canOpen}
              title="Открыть папку установки"
              aria-label="Открыть папку установки"
              style={{ padding: '6px 10px', minWidth: 0 }}
            >
              📁
            </button>
          </div>
        </div>

        <div className="row">
          <div>
            <div className="row-label">Состояние</div>
            <div className="row-hint">{status?.message || lastMessage || 'VCClient еще не проверялся'}</div>
          </div>
          <div className="row-right">
            {status?.running && status?.pid ? (
              <span className="badge badge-blue">PID {status.pid}</span>
            ) : (
              <span className="badge badge-gray">PID неизвестен</span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Ошибка</span>
          </div>
          <div style={{ padding: 16 }}>
            <InlineError message={error} />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Последний лог</span>
          <button className="btn btn-secondary" onClick={handleCopyLog} disabled={!lastLog}>
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
        <div style={{ padding: 16 }}>
          <div className="cmd-preview">{lastLog || cmdPreview}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Системная подмена голоса</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Для Discord, OBS и игр нужен внешний виртуальный аудиокабель. Само приложение управляет только `VCClient`.
          </div>
          <div className="realtime-checklist">
            <div>1. Установите `VB-Cable` или аналог.</div>
            <div>2. В `VCClient` выберите микрофон как `Input`.</div>
            <div>3. В `VCClient` выберите виртуальный кабель как `Output`.</div>
            <div>4. В Discord/OBS/игре выберите этот кабель как входной микрофон.</div>
            <div>5. Для женского голоса загрузите подходящую `RVC`-модель внутри интерфейса `VCClient`.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

