import { useState, useEffect, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import './index.css'

import Sidebar from './components/Sidebar'
import VideoTab from './components/VideoTab'
import AudioTab from './components/AudioTab'
import GifWebpTab from './components/GifWebpTab'
import BatchTab from './components/BatchTab'
import Settings from './components/Settings'
import TrimTab from './components/TrimTab'
import MergeTab from './components/MergeTab'
import FramesTab from './components/FramesTab'
import DownloadTab from './components/DownloadTab'

// ─── Global progress store ────────────────────────────────────────────────────
// Shared across tabs so BatchTab can show progress of any job
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
  const [tab, setTab] = useState('video')
  const [settings, setSettings] = useState({
    ffmpegPath: '',
    ffprobePath: '',
    outputDir: '',
    suffix: '_converted',
    parallelJobs: 2,
    theme: 'system',
    showCmd: true,
    hwAccel: 'none',
  })
  const { jobs } = useJobs()
  const [ffmpegOk, setFfmpegOk] = useState(null) // null=checking, true, false

  // Check ffmpeg on load
  useEffect(() => {
    invoke('check_ffmpeg', { ffmpegPath: settings.ffmpegPath })
      .then(() => setFfmpegOk(true))
      .catch(() => setFfmpegOk(false))
  }, [settings.ffmpegPath])

  const topbarTitles = {
    video: 'Конвертация видео',
    audio: 'Конвертация аудио',
    gif: 'GIF / WebP анимация',
    batch: 'Пакетная обработка',
    trim: 'Обрезка видео',
    merge: 'Склейка файлов',
    thumb: 'Извлечение кадров',
    download: 'Скачать видео',
    settings: 'Настройки',
  }

  return (
    <div className="app-layout">
      <Sidebar tab={tab} setTab={setTab} ffmpegOk={ffmpegOk} jobs={jobs} />

      <div className="main-area">
        <div className="topbar">
          <span className="topbar-title">{topbarTitles[tab] ?? tab}</span>
          <div className="topbar-right">
            {ffmpegOk === false && (
              <span className="badge badge-red">FFmpeg не найден</span>
            )}
            {ffmpegOk === true && (
              <span className="badge badge-green">FFmpeg готов</span>
            )}
          </div>
        </div>

        {tab === 'video'    && <VideoTab settings={settings} jobs={jobs} />}
        {tab === 'audio'    && <AudioTab settings={settings} jobs={jobs} />}
        {tab === 'gif'      && <GifWebpTab settings={settings} jobs={jobs} />}
        {tab === 'batch'    && <BatchTab settings={settings} jobs={jobs} />}
        {tab === 'trim'     && <TrimTab settings={settings} jobs={jobs} />}
        {tab === 'merge'    && <MergeTab settings={settings} jobs={jobs} />}
        {tab === 'settings' && <Settings settings={settings} setSettings={setSettings} />}

        {/* Stubs for future tabs */}
        {tab === 'thumb' && <FramesTab settings={settings} />}
        {tab === 'download' && <DownloadTab />}
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
