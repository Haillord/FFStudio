import { useState, useEffect } from 'react'

const ICONS = {
  media: <svg viewBox="0 0 20 20" fill="currentColor"><rect x="2" y="4" width="11" height="12" rx="2" /><path d="M13 8l5-2.5v9L13 12V8z" /><rect x="6" y="11" width="3" height="6" rx="1" /></svg>,
  voice: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M7 4a3 3 0 016 0v6a3 3 0 01-6 0V4zm-2 6a5 5 0 0010 0h-2a3 3 0 01-6 0H5zm4 5v2H7v1h6v-1h-2v-2h-2z" /></svg>,
  realtimevoice: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a4 4 0 00-4 4v4a4 4 0 008 0V6a4 4 0 00-4-4zm0 12a7 7 0 007-7h-2a5 5 0 11-10 0H3a7 7 0 007 7zm-1 1h2v3H9v-3z" /></svg>,
  subtitles: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm2 0v10h12V5H4zm1 2h3v1H5V7zm5 0h5v1h-5V7zm-5 2h8v1H5V9zm0 2h5v1H5v-1zm6 0h4v1h-4v-1z"/></svg>,
  music: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 18a3 3 0 100-6 3 3 0 000 6zM15 16a3 3 0 100-6 3 3 0 000 6zM5 4l10 3v2L5 6V4zm10 0l4 1v10l-4 1V4z"/></svg>,
  image: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 5a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm2 0v6l3-3 3 3 2-2 2 2V5H5zm0 10h10v-1l-2-2-2 2-3-3-3 3v1z" /></svg>,
  videogen: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 4h8a2 2 0 012 2v1.5l3-2v7l-3-2V14a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm1 3v4h2V7H5zm3 0v4h2V7H8z" /></svg>,
  download: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 3v9m0 0l-3-3m3 3l3-3M4 15h12v2H4v-2z" /></svg>,
  settings: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.532 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.532 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" /></svg>,
  ai: <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.5 11.4 5.8H16l-4.5 3.3 1.7 5.2L10 12.6 6.8 14.3l1.7-5.2L4 5.8h4.6L10 1.5z" /></svg>,
}

const NAV_SECTIONS = [
  {
    label: 'МЕДИА',
    labelClass: 'sidebar-section-label sidebar-section-label--mega',
    items: [
      { key: 'media', id: 'media', label: 'Медиа', icon: 'media' },
      { key: 'image', id: 'image', label: 'Изображения', icon: 'image' },
      { key: 'music', id: 'music', label: 'Музыка', icon: 'music' },
      { key: 'voice', id: 'voice', label: 'Генерация голоса', icon: 'ai' },
      { key: 'realtimevoice', id: 'realtimevoice', label: 'Замена голоса', icon: 'realtimevoice' },
      { key: 'subtitles', id: 'subtitles', label: 'Генерация сабов', icon: 'subtitles' },
      { key: 'videogen', id: 'videogen', label: 'Генерация видео', icon: 'videogen' },
      { key: 'download', id: 'download', label: 'Скачать видео', icon: 'download' },
    ],
  },
  {
    label: 'СИСТЕМА',
    labelClass: 'sidebar-section-label sidebar-section-label--mega',
    items: [
      { key: 'settings', id: 'settings', label: 'Настройки', icon: 'settings' },
    ],
  },
]

const useCustomIcon = (name) => {
  const [icon, setIcon] = useState(null)

  useEffect(() => {
    const exts = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif']
    const load = async () => {
      for (const ext of exts) {
        try {
          const mod = await import(`../assets/icons/${name}.${ext}`)
          setIcon(mod.default)
          return
        } catch {}
      }
    }
    load()
  }, [name])

  return icon
}

export default function Sidebar({ tab, setTab }) {
  const logo = useCustomIcon('logo')

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className={`sidebar-logo-icon${logo ? ' sidebar-logo-icon--custom' : ''}`}>
          {logo
            ? <img src={logo} style={{ width: 18, height: 18, objectFit: 'contain' }} alt="" />
            : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M13 2L3 14H12L11 22L21 10H12L13 2Z"
                  stroke="white"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
        </div>
        <span className="sidebar-logo-text sidebar-logo-text--gradient">MediaKit</span>
      </div>

      {NAV_SECTIONS.map((section) => (
        <div key={section.label}>
          <div className={section.labelClass}>{section.label}</div>
          {section.items.map((item) => (
            <NavRow
              key={item.key}
              item={item}
              tab={tab}
              setTab={setTab}
            />
          ))}
        </div>
      ))}
    </aside>
  )
}

function NavRow({ item, tab, setTab }) {
  const { id, label, icon } = item
  const iconKey = icon || id
  const custom = useCustomIcon(id)
  const active = tab === id

  return (
    <div className={`nav-item${active ? ' active' : ''}`} onClick={() => setTab(id)}>
      <div className="nav-icon">
        <span style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {custom
            ? <img src={custom} style={{ width: '100%', height: '100%', objectFit: 'contain' }} alt="" />
            : ICONS[iconKey]
          }
        </span>
      </div>
      <span className="nav-label">{label}</span>
    </div>
  )
}

