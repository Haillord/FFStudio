import { useState, useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { Chip, ToggleRow, formatUserError, useTabState, PageHeader } from './shared'

const QUALITIES = [
  { label: 'Лучшее', value: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]' },
  { label: '1080p', value: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]' },
  { label: '720p', value: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]' },
  { label: '480p', value: 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]' },
  { label: 'Только аудио', value: 'bestaudio[ext=m4a]/bestaudio' },
]

export default function DownloadTab() {
  const { state: persistedDownload, patchState: patchTabState } = useTabState('download', {
    url: '', quality: QUALITIES[0].value, savePath: '', openFolder: true,
  })
  const [url, setUrl] = useState(persistedDownload.url)
  const [log, setLog] = useState("")
  const [loading, setLoading] = useState(false)
  const [quality, setQuality] = useState(persistedDownload.quality)
  const [savePath, setSavePath] = useState(persistedDownload.savePath)
  const [openFolder, setOpenFolder] = useState(persistedDownload.openFolder)

  useEffect(() => {
    patchTabState({ url, quality, savePath, openFolder })
  }, [url, quality, savePath, openFolder])

  async function pickSaveFolder() {
    const selected = await open({
      directory: true,
      title: "Выберите папку для сохранения"
    })
    if (selected) {
      setSavePath(selected)
    }
  }

  async function handleDownload() {
    if (!url.trim()) return
    const validUrl = /^https?:\/\/.+/i.test(url.trim())
    if (!validUrl) {
      setLog('Ошибка:\nНекорректная ссылка. Укажите полный URL, начиная с http:// или https://')
      return
    }
    setLoading(true)
    setLog("Скачиваю...")

    try {
      const result = await invoke("run_ytdlp", {
        url: url.trim(),
        format: quality,
        outputDir: savePath
      })

      setLog(result)

      if (openFolder && savePath) {
        invoke("open_in_explorer", { path: savePath }).catch(() => {})
      }

    } catch (e) {
      setLog(`Ошибка:\n${formatUserError(e, 'Не удалось скачать видео')}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="content">

      <div className="card">
        <div className="card-header">
          <span className="card-title">Ссылка на видео</span>
        </div>

        <div style={{ padding: '12px 16px 16px' }}>
          <div style={{ display: "flex", gap: 12 }}>
            <input
              type="text"
              placeholder="Ссылка на видео"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleDownload()}
              style={{ flex: 1, borderRadius: 8 }}
              disabled={loading}
              className="ios-input"
            />
            <button
              className="btn btn-primary"
              onClick={handleDownload}
              disabled={loading || !url.trim()}
              style={{ minWidth: 140 }}
            >
              {loading ? "Скачиваю..." : "Скачать"}
            </button>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{
              flex: 1,
              background: 'var(--bg-fill)',
              borderRadius: 8,
              padding: '6px 10px',
              fontSize: 12,
              color: 'var(--text-secondary)'
            }}>
              {savePath || "По умолчанию: Загрузки"}
            </div>
            <button
              className="btn btn-secondary"
              onClick={pickSaveFolder}
              disabled={loading}
              style={{ minWidth: 100 }}
            >
              Выбрать папку
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Качество</span>
        </div>
        <div className="chip-row" style={{ padding: '8px 16px 8px' }}>
          {QUALITIES.map(q => (
            <Chip
              key={q.value}
              label={q.label}
              sel={quality === q.value}
              onClick={() => setQuality(q.value)}
              disabled={loading}
            />
          ))}
        </div>

        <div style={{ padding: '0 16px 12px' }}>
          <ToggleRow
            label="Открыть папку после скачивания"
            on={openFolder}
            onChange={setOpenFolder}
          />
        </div>
      </div>

      {log && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Лог</span>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12 }}
              onClick={() => setLog("")}
              disabled={loading}
            >
              Очистить
            </button>
          </div>
          <div style={{ padding: '0 16px 16px' }}>
            <pre style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              margin: 0,
              maxHeight: 300,
              overflowY: "auto",
              background: "var(--bg-secondary)",
              borderRadius: 8,
              padding: 12,
              fontFamily: "Consolas, monospace"
            }}>{log}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

