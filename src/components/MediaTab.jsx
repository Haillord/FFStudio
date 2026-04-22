import { useState, useEffect } from 'react'
import VideoTab from './VideoTab'
import AudioTab from './AudioTab'
import GifWebpTab from './GifWebpTab'
import TrimTab from './TrimTab'

const SUB_TABS = [
  { id: 'video', label: 'Видео' },
  { id: 'audio', label: 'Аудио' },
  { id: 'gif', label: 'GIF / WebP' },
  { id: 'trim', label: 'Обрезка' },
]

export default function MediaTab({ settings, jobs, onSubTabChange }) {
  const [subTab, setSubTab] = useState(() => {
    const saved = localStorage.getItem('media_last_subtab')
    return saved && SUB_TABS.find(t => t.id === saved) ? saved : 'video'
  })

  useEffect(() => {
    localStorage.setItem('media_last_subtab', subTab)
    onSubTabChange?.(subTab)
  }, [subTab, onSubTabChange])

  return (
    <div className="media-tab-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="media-sub-tabs">
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`media-sub-tab ${subTab === t.id ? 'active' : ''}`}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {subTab === 'video' && <VideoTab settings={settings} jobs={jobs} />}
        {subTab === 'audio' && <AudioTab settings={settings} jobs={jobs} />}
        {subTab === 'gif' && <GifWebpTab settings={settings} jobs={jobs} />}
        {subTab === 'trim' && <TrimTab settings={settings} jobs={jobs} />}
      </div>
    </div>
  )
}

