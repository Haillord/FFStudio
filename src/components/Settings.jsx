import { useState, useEffect } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { SelectRow, ToggleRow, formatUserError, PageHeader } from './shared'

export default function Settings({ settings, setSettings }) {
  const [ffmpegStatus, setFfmpegStatus] = useState(null)
  const [comfyStatus, setComfyStatus] = useState(null)
  const [comfyLaunchStatus, setComfyLaunchStatus] = useState(null)
  const [comfyInstallStatus, setComfyInstallStatus] = useState(null)
  const [logsStatus, setLogsStatus] = useState(null)
  const [showComfyAdvanced, setShowComfyAdvanced] = useState(false)

  const set = (key) => (value) => setSettings(s => ({ ...s, [key]: value }))

  const pickOutputDir = async () => {
    const dir = await open({ directory: true, multiple: false })
    if (dir) set('outputDir')(dir)
  }

  const checkFfmpeg = async () => {
    setFfmpegStatus('checking')
    try {
      const result = await invoke('check_ffmpeg', { ffmpegPath: settings.ffmpegPath })
      setFfmpegStatus(`✓ FFmpeg ${result.version} — ${result.path}`)
    } catch (e) {
      setFfmpegStatus(`✗ ${formatUserError(e, 'FFmpeg не найден')}`)
    }
  }

  const checkComfyUi = async () => {
    setComfyStatus('checking')
    try {
      const result = await invoke('check_comfyui', { comfyUrl: settings.comfyApiUrl })
      setComfyStatus(`✓ ${result}`)
    } catch (e) {
      setComfyStatus(`✗ ${formatUserError(e, 'ComfyUI недоступен')}`)
    }
  }

  const pickComfyDir = async () => {
    const dir = await open({ directory: true, multiple: false })
    const selected = Array.isArray(dir) ? dir[0] : dir
    if (selected) set('comfyDir')(selected)
  }

  const pickComfyInstallDir = async () => {
    const dir = await open({ directory: true, multiple: false })
    const selected = Array.isArray(dir) ? dir[0] : dir
    if (selected) set('comfyInstallDir')(selected)
  }

  const startComfyUi = async () => {
    setComfyLaunchStatus('Запуск...')
    try {
      const message = await invoke('start_comfyui', {
        comfyUrl: settings.comfyApiUrl || '',
        comfyDir: settings.comfyDir || '',
        pythonBin: settings.comfyPython || 'python',
      })
      setComfyLaunchStatus(`✓ ${message}`)
      await checkComfyUi()
    } catch (e) {
      setComfyLaunchStatus(`✗ ${formatUserError(e, 'Не удалось запустить ComfyUI')}`)
    }
  }

  const autoSetupComfyUi = async () => {
    setComfyLaunchStatus('Автонастройка...')
    try {
      const result = await invoke('auto_setup_comfyui')
      setSettings(s => ({
        ...s,
        comfyApiUrl: result.comfyApiUrl || s.comfyApiUrl,
        comfyDir: result.comfyDir || s.comfyDir,
        comfyPython: result.comfyPython || s.comfyPython,
      }))
      setComfyLaunchStatus(`✓ ${result.message}`)
      setComfyStatus(`✓ ComfyUI online (${result.comfyApiUrl})`)
    } catch (e) {
      setComfyLaunchStatus(`✗ ${formatUserError(e, 'Автонастройка ComfyUI не удалась')}`)
    }
  }

  const installComfyUi = async () => {
    setComfyInstallStatus('Установка...')
    try {
      const result = await invoke('install_comfyui_portable', {
        installDir: settings.comfyInstallDir || '',
      })
      setSettings(s => ({
        ...s,
        comfyApiUrl: result.comfyApiUrl || s.comfyApiUrl,
        comfyDir: result.comfyDir || s.comfyDir,
        comfyPython: result.comfyPython || s.comfyPython,
      }))
      setComfyInstallStatus(`✓ ${result.message}`)
      setComfyLaunchStatus(`✓ ${result.message}`)
      setComfyStatus(`✓ ComfyUI online (${result.comfyApiUrl})`)
    } catch (e) {
      setComfyInstallStatus(`✗ ${formatUserError(e, 'Установка ComfyUI не удалась')}`)
    }
  }

  const exportLogs = async () => {
    setLogsStatus('Экспорт...')
    try {
      const defaultName = `mediakit-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`
      const target = await save({
        defaultPath: defaultName,
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
      })
      if (!target) {
        setLogsStatus('Отменено')
        return
      }
      const outPath = await invoke('export_logs', { destination: target })
      setLogsStatus(`✓ Сохранено: ${outPath}`)
    } catch (e) {
      setLogsStatus(`✗ ${formatUserError(e, 'Не удалось экспортировать логи')}`)
    }
  }

  useEffect(() => {
    checkComfyUi()
  }, [settings.comfyApiUrl])

  return (
    <div className="content">

      <div className="card">
        <div className="row">
          <div className="row-label">Разработчик</div>
          <button 
            className="btn btn-primary" 
            style={{ fontSize: 12 }}
            onClick={() => {
              import('@tauri-apps/plugin-shell').then(({ open }) => {
                open('https://www.donationalerts.com/r/haillord1')
              })
            }}
          >
            Поддержать разработчика
          </button>
        </div>
      </div>
      {/* FFmpeg paths */}
      <div className="card">
        <div className="card-header"><span className="card-title">Пути к FFmpeg</span></div>

        <div className="row">
          <div>
            <div className="row-label">Путь к ffmpeg</div>
            <div className="row-hint">Оставьте пустым для автопоиска</div>
          </div>
          <input
            className="ios-input"
            style={{ width: 160, textAlign: 'left' }}
            placeholder="ffmpeg"
            value={settings.ffmpegPath}
            onChange={e => set('ffmpegPath')(e.target.value)}
          />
        </div>

        <div className="row">
          <div>
            <div className="row-label">Путь к ffprobe</div>
          </div>
          <input
            className="ios-input"
            style={{ width: 160, textAlign: 'left' }}
            placeholder="ffprobe"
            value={settings.ffprobePath}
            onChange={e => set('ffprobePath')(e.target.value)}
          />
        </div>

        <div className="row">
          <div className="row-label">Статус</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {ffmpegStatus && (
              <span style={{
                fontSize: 12,
                color: ffmpegStatus.startsWith('✓') ? 'var(--ios-green)' : 'var(--ios-red)'
              }}>
                {ffmpegStatus}
              </span>
            )}
            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={checkFfmpeg}>
              Проверить
            </button>
          </div>
        </div>
      </div>

      {/* Output */}
      <div className="card">
        <div className="card-header"><span className="card-title">ComfyUI</span></div>

        <div className="row">
          <div>
            <div className="row-label">Быстрый старт</div>
            <div className="row-hint">Один клик: найти, настроить и запустить уже установленный ComfyUI</div>
          </div>
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={autoSetupComfyUi}>
            Автонастройка
          </button>
        </div>

        <div className="row">
          <div>
            <div className="row-label">Установка ComfyUI</div>
            <div className="row-hint">Скачать portable-сборку и установить в выбранную папку</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={pickComfyInstallDir}>
              {settings.comfyInstallDir ? settings.comfyInstallDir.split(/[\\/]/).pop() : 'Выбрать папку'}
            </button>
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={installComfyUi}>
              Установить
            </button>
          </div>
        </div>

        {comfyInstallStatus && (
          <div className="row">
            <div className="row-label">Инсталлятор</div>
            <span style={{
              fontSize: 12,
              color: comfyInstallStatus.startsWith('✓') ? 'var(--ios-green)' : (comfyInstallStatus === 'Установка...' ? 'var(--text-muted)' : 'var(--ios-red)')
            }}>
              {comfyInstallStatus}
            </span>
          </div>
        )}

        <div className="row">
          <div className="row-label">Ручные настройки</div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12 }}
            onClick={() => setShowComfyAdvanced(v => !v)}
          >
            {showComfyAdvanced ? 'Скрыть' : 'Показать'}
          </button>
        </div>

        {showComfyAdvanced && (
          <>
            <div className="row">
              <div>
                <div className="row-label">API URL</div>
                <div className="row-hint">Обычно: http://127.0.0.1:8188</div>
              </div>
              <input
                className="ios-input"
                style={{ width: 260, textAlign: 'left' }}
                placeholder="http://127.0.0.1:8188"
                value={settings.comfyApiUrl || ''}
                onChange={e => set('comfyApiUrl')(e.target.value)}
              />
            </div>

            <div className="row">
              <div>
                <div className="row-label">Папка ComfyUI</div>
                <div className="row-hint">Папка, где лежит `main.py`</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={pickComfyDir}>
                  {settings.comfyDir ? settings.comfyDir.split(/[\\/]/).pop() : 'Выбрать папку'}
                </button>
              </div>
            </div>

            <div className="row">
              <div>
                <div className="row-label">Python</div>
                <div className="row-hint">Обычно `python` или путь к `python.exe`</div>
              </div>
              <input
                className="ios-input"
                style={{ width: 180, textAlign: 'left' }}
                placeholder="python"
                value={settings.comfyPython || 'python'}
                onChange={e => set('comfyPython')(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="row">
          <div className="row-label">Статус</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {comfyStatus && (
              <span style={{
                fontSize: 12,
                color: comfyStatus.startsWith('✓') ? 'var(--ios-green)' : 'var(--ios-red)'
              }}>
                {comfyStatus}
              </span>
            )}
            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={checkComfyUi}>
              Проверить
            </button>
            {showComfyAdvanced && (
              <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={startComfyUi}>
                Запустить ComfyUI
              </button>
            )}
          </div>
        </div>

        {comfyLaunchStatus && (
          <div className="row">
            <div className="row-label">Запуск</div>
            <span style={{
              fontSize: 12,
              color: comfyLaunchStatus.startsWith('✓') ? 'var(--ios-green)' : (comfyLaunchStatus === 'Запуск...' || comfyLaunchStatus === 'Автонастройка...' ? 'var(--text-muted)' : 'var(--ios-red)')
            }}>
              {comfyLaunchStatus}
            </span>
          </div>
        )}

        <ToggleRow
          label="Хранить копии в папке ComfyUI"
          hint="Если выключено, MediaKit сохранит результат у себя и удалит файл из ComfyUI/output"
          on={!!settings.keepComfyCopy}
          onChange={set('keepComfyCopy')}
        />
      </div>

      {/* Output */}
      <div className="card">
        <div className="card-header"><span className="card-title">Вывод файлов</span></div>

        <div className="row">
          <div className="row-label">Папка по умолчанию</div>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={pickOutputDir}>
            {settings.outputDir ? settings.outputDir.split(/[\\/]/).pop() : 'Рядом с оригиналом'}
          </button>
        </div>

        <SelectRow label="Суффикс имени" value={settings.suffix} onChange={set('suffix')}
          options={[
            { label: '_converted', value: '_converted' },
            { label: '_out', value: '_out' },
            { label: 'Нет суффикса', value: '' },
          ]} />
      </div>

      {/* Interface */}
      <div className="card">
        <div className="card-header"><span className="card-title">Интерфейс</span></div>

        <SelectRow label="Тема" value={settings.theme} onChange={set('theme')}
          options={[
            { label: 'Системная', value: 'system' },
            { label: 'Светлая', value: 'light' },
            { label: 'Тёмная', value: 'dark' },
          ]} />

        <ToggleRow label="Показывать команду FFmpeg" on={settings.showCmd} onChange={set('showCmd')} />
      </div>

      {/* Hardware */}
      <div className="card">
        <div className="card-header"><span className="card-title">Производительность</span></div>

        <SelectRow label="Аппаратное ускорение" value={settings.hwAccel} onChange={set('hwAccel')}
          options={[
            { label: 'Нет (CPU)', value: 'none' },
            { label: 'NVENC (NVIDIA)', value: 'nvenc' },
            { label: 'VideoToolbox (Apple)', value: 'videotoolbox' },
            { label: 'VAAPI (Linux/AMD)', value: 'vaapi' },
            { label: 'AMF (AMD Windows)', value: 'amf' },
          ]} />

        <SelectRow label="Параллельных задач (пакет)" value={String(settings.parallelJobs)}
          onChange={v => set('parallelJobs')(Number(v))}
          options={['1','2','3','4']} />
      </div>

      {/* About */}
      <div className="card">
        <div className="card-header"><span className="card-title">О приложении</span></div>
        <div className="row">
          <div className="row-label">MediaKit</div>
          <span className="badge badge-gray">v0.1.0</span>
        </div>
        <div className="row">
          <div className="row-label">Движок</div>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>FFmpeg + Tauri + React</span>
        </div>
        <div className="row">
          <div>
            <div className="row-label">Диагностика</div>
            <div className="row-hint">Экспорт журнала операций для диагностики</div>
          </div>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={exportLogs}>
            Экспорт логов
          </button>
        </div>
        {logsStatus && (
          <div className="row">
            <div className="row-label">Логи</div>
            <span style={{
              fontSize: 12,
              color: logsStatus.startsWith('✓') ? 'var(--ios-green)' : (logsStatus === 'Экспорт...' || logsStatus === 'Отменено' ? 'var(--text-muted)' : 'var(--ios-red)')
            }}>
              {logsStatus}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

