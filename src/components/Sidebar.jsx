import { useState, useEffect } from 'react'

// Автоматическая подгрузка кастомных иконок
const useCustomIcon = (name) => {
  const [icon, setIcon] = useState(null)
  
  useEffect(() => {
    const exts = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif']
    const check = async () => {
      for (const ext of exts) {
        try {
          const path = `/src/assets/icons/${name}.${ext}`
          if (await fetch(path).then(r => r.ok)) {
            setIcon(path)
            return
          }
        } catch {}
      }
    }
    check()
  }, [name])
  
  return icon
}

export default function Sidebar({ tab, setTab, ffmpegOk, jobs }) {
  const activeJobs = Object.values(jobs).filter(j => !j.done).length
  const logo = useCustomIcon('logo')

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon" style={logo ? { background: 'transparent' } : {}}>
          {logo ? 
            <img src={logo} style={{ width: 20, height: 20, objectFit: 'contain' }} alt="" /> :
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="4" width="11" height="12" rx="2.5" fill="white" opacity="0.9"/>
              <path d="M13 8l5-2.5v9L13 12V8z" fill="white" opacity="0.7"/>
            </svg>
          }
        </div>
        <span className="sidebar-logo-text">FFStudio</span>
      </div>

      {/* Convert section */}
      <div className="sidebar-section-label">Конвертация</div>
      <NavItem id="video" icon="🎬" label="Видео"    color="#E8F2FF" tab={tab} setTab={setTab} />
      <NavItem id="audio" icon="🎵" label="Аудио"    color="#FFF0E5" tab={tab} setTab={setTab} />
      <NavItem id="gif"   icon="✨" label="GIF / WebP" color="#F0EEFF" tab={tab} setTab={setTab} />
      <NavItem id="batch" icon="📦" label="Пакетно"  color="#E5F8EE" tab={tab} setTab={setTab}
        badge={activeJobs > 0 ? activeJobs : null} />

      {/* Tools section */}
      <div className="sidebar-section-label">Инструменты</div>
      <NavItem id="trim"  icon="✂️" label="Обрезка"  color="#FFF0F0" tab={tab} setTab={setTab} />
      <NavItem id="merge" icon="🔗" label="Склейка"  color="#E0F0FF" tab={tab} setTab={setTab} />
      <NavItem id="thumb" icon="🖼️" label="Кадры"   color="#FFFAE0" tab={tab} setTab={setTab} />
      <NavItem id="download" icon="⬇️" label="Скачать" color="#E5F8EE" tab={tab} setTab={setTab} />

      <div className="sidebar-spacer" />

      {/* Settings */}
      <NavItem id="settings" icon="⚙️" label="Настройки" color="var(--bg-fill)" tab={tab} setTab={setTab} />
    </aside>
  )
}

function NavItem({ id, icon, label, color, tab, setTab, badge }) {
  const active = tab === id
  const custom = useCustomIcon(id)
  
  return (
    <div className={`nav-item${active ? ' active' : ''}`} onClick={() => setTab(id)}>
      <div className="nav-icon" style={{ background: color, overflow: 'hidden' }}>
        {custom ? 
          <img src={custom} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" /> :
          icon
        }
      </div>
      <span className="nav-label">{label}</span>
      {badge != null && (
        <span className="badge badge-blue" style={{ marginLeft: 'auto', fontSize: 10 }}>{badge}</span>
      )}
    </div>
  )
}
