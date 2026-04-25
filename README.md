<p align="center">
  <img src="icon.webp" alt="FFusion" width="1000" />
</p>

<h1 align="center">FFusion</h1>

<p align="center">
  <b>AI + FFmpeg desktop studio</b><br/>
  React + Tauri (Rust) приложение для видео, аудио, субтитров и локальных AI-задач.
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/Haillord/FFStudio?style=for-the-badge&label=LICENSE&color=1A6BFF&labelColor=0a0a0f" alt="license" />
  <img src="https://img.shields.io/github/stars/Haillord/FFStudio?style=for-the-badge&label=STARS&color=1A6BFF&labelColor=0a0a0f" alt="stars" />
  <img src="https://img.shields.io/badge/STATUS-ACTIVE-1A6BFF?style=for-the-badge&labelColor=0a0a0f" alt="status" />
</p>

<p align="center">
  <a href="https://github.com/Haillord/FFStudio/releases/tag/FF">
    <img src="https://img.shields.io/badge/_Скачать_установщик-007AFF?style=for-the-badge&logo=github&logoColor=white" alt="Скачать FFStudio" />
  </a>
</p>

---

## Почему FFusion

- Единый интерфейс для FFmpeg-инструментов и AI-функций.
- Нативный desktop UX без терминала и сложной ручной настройки.
- Локальные сценарии: генерация, распознавание, озвучка, обработка медиа.
- Подходит как для быстрых задач, так и для пайплайнов.

## Стек

<p>
  <img src="https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black" alt="react" />
  <img src="https://img.shields.io/badge/Tauri-FFC131?style=flat-square&logo=tauri&logoColor=black" alt="tauri" />
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="rust" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" alt="vite" />
  <img src="https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="ffmpeg" />
  <img src="https://img.shields.io/badge/Whisper-111111?style=flat-square" alt="whisper" />
  <img src="https://img.shields.io/badge/Stable_Diffusion-111111?style=flat-square" alt="stable diffusion" />
</p>

## Возможности

### Видео
- Конвертация: MP4, MKV, WebM, MOV, AVI и др.
- Trim/resize/crop, извлечение кадров и аудио.
- GIF/WebP/APNG, склейка, пакетная обработка.

### Аудио
- Конвертация: MP3, AAC, FLAC, WAV, Opus.
- Обрезка и нормализация.
- Подготовка рингтонов и коротких клипов.

### AI
- Генерация изображений (SDXL/Turbo), inpaint/outpaint, ControlNet.
- Интеграция с ComfyUI.
- TTS, realtime voice, Whisper, автосубтитры.
- Генерация музыки и SFX.

---

## Скриншоты

<details>
  <summary><b>📸 Открыть галерею</b></summary>
  <br/>

  <details>
    <summary>Главный экран</summary>
    <br/>
    <!-- Замените путь на реальный скриншот -->
    ![Главный экран](./docs/screenshots/main.png)
  </details>

  <details>
    <summary>Видео вкладка</summary>
    <br/>
    <!-- Замените путь на реальный скриншот -->
    ![Видео вкладка](./docs/screenshots/video-tab.png)
  </details>

  <details>
    <summary>AI / Voice вкладка</summary>
    <br/>
    <!-- Замените путь на реальный скриншот -->
    ![AI Voice вкладка](./docs/screenshots/voice-tab.png)
  </details>
</details>


---

## Требования

- Node.js `20+`
- Rust `1.75+`
- Остальные зависимости подтягиваются в процессе работы.

## Быстрый старт

```bash
# Установка зависимостей
npm install

# Frontend dev
npm run dev

# Tauri app
npm run tauri dev

# Production build frontend
npm run build
```

---

## Структура проекта

<details>
<summary><b>Показать структуру</b></summary>
<br/>
<pre>
fg/
├── src/                      # React интерфейс
│   ├── components/           # Вкладки и UI-компоненты
│   ├── App.jsx
│   └── main.jsx
├── src-tauri/                # Rust backend (Tauri)
│   ├── src/
│   │   ├── commands/         # Команды из frontend
│   │   ├── models/           # Типы/модели
│   │   ├── *_impl.rs         # Реализации
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── ff/                       # Встроенные бинарные инструменты
└── package.json
</pre>
</details>

## Лицензия

[MIT](LICENSE)
