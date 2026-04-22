<p align="center">
  <img src="icon.webp" alt="FFStudio" width="1000">
</p>


<p align="center">
<img src="https://readme-typing-svg.demolab.com?font=Share+Tech+Mono&size=20&pause=2000&color=1A6BFF&center=true&vCenter=true&width=700&height=45&duration=40&lines=FFStudio+%E2%80%94+AI+%2B+FFmpeg+GUI;React+%2B+Tauri+(Rust)+desktop+app;Конвертация+%E2%80%A2+ИИ+%E2%80%A2+Генерация;Всё+в+одном+окне">
</p>



<p align="center">
<img src="https://img.shields.io/github/license/Haillord/FFStudio?style=for-the-badge&label=LICENSE&color=1A6BFF&labelColor=0a0a0f&cacheSeconds=1" alt="license">
  <img src="https://img.shields.io/github/stars/Haillord/FFStudio?style=for-the-badge&label=STARS&color=1A6BFF&labelColor=0a0a0f" alt="stars">
  <img src="https://img.shields.io/badge/STATUS-ACTIVE-1A6BFF?style=for-the-badge&labelColor=0a0a0f" alt="status">
</p>

<p align="center">
  <img src="banner.svg" width="100%" alt="FFStudio Banner">
</p>

<br>

<p align="center">
  <a href="https://github.com/Haillord/FFStudio/releases/tag/FF">
    <img src="https://img.shields.io/badge/⬇️_Скачать_установщик-007AFF?style=for-the-badge&logoColor=white&logo=github" alt="Скачать FFStudio"/>
  </a>
</p>

<br>

---

<table>
<tr>
<td width="25%">
<img src="https://img.shields.io/badge/React_+_Tauri-1A6BFF?style=flat-square&logoColor=white"/>

Нативное приложение
</td>
<td width="25%">
<img src="https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logoColor=white"/>

Видео/аудио
</td>
<td width="25%">
<img src="https://img.shields.io/badge/AI_Models-9333EA?style=flat-square&logoColor=white"/>

Локальные ИИ
</td>
<td width="25%">
<img src="https://img.shields.io/badge/No_Terminal-FF6B00?style=flat-square&logoColor=white"/>

Без консоли
</td>
</tr>
</table>

---

### 🛠 Stack

<p align="center">
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black"/>
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white"/>
  <img src="https://img.shields.io/badge/Tauri-FFC131?style=for-the-badge&logo=tauri&logoColor=black"/>
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white"/>
  <img src="https://img.shields.io/badge/FFmpeg-007808?style=for-the-badge&logo=ffmpeg&logoColor=white"/>
  <img src="https://img.shields.io/badge/Stable_Diffusion-000000?style=for-the-badge"/>
  <img src="https://img.shields.io/badge/Whisper-000000?style=for-the-badge"/>
</p>

---

### ⚙️ Требования

> Node.js `20+` &nbsp;•&nbsp; Rust `1.75+` &nbsp;•&nbsp; Все остальное автоматически скачивается при первом запуске

---

### 🚀 Установка

```bash
# 1. Зависимости Node.js
npm install

# 2. Режим разработки
npm run dev

# 3. Сборка релизной версии
npm run build
```

---

### 🎬 Все возможности

#### 🎥 Видео
- Конвертация между всеми форматами (MP4, MKV, WebM, MOV, AVI)
- Обрезка по временным меткам
- Изменение размера, кадрирование
- Извлечение аудио дорожки
- Извлечение кадров
- Создание GIF / WebP / APNG анимации
- Склейка файлов
- Пакетная обработка

#### 🎵 Аудио
- Конвертация MP3, AAC, FLAC, WAV, Opus
- Обрезка, нормализация громкости
- Создание рингтонов

#### 🤖 ИИ
##### 🖼️ Изображения
- ✅ Генерация изображений Stable Diffusion XL / Turbo
- ✅ Inpaint / Outpaint
- ✅ ControlNet
- ✅ Интеграция с ComfyUI

##### 🔊 Голос и звук
- ✅ Текст в речь (больше 100 голосов)
- ✅ Realtime голосовой чат
- ✅ Распознавание речи OpenAI Whisper
- ✅ Автоматическое создание субтитров
- ✅ Генерация музыки и звуковых эффектов

##### ✨ Дополнительно
- ✅ Встроенный ИИ генератор промптов
- ✅ Автоматическое улучшение запросов
- ✅ Локальные модели, работает без интернета
- ✅ Никаких API ключей не требуется

---

### 📂 Актуальная структура проекта

<details>
<summary><b>Показать структуру</b></summary>
<br>
<pre>
fg-studio/
├── src/                   - React интерфейс
│   ├── components/        - Все вкладки и UI компоненты
│   ├── App.jsx
│   └── index.css
├── src-tauri/             - Rust бэкенд
│   ├── src/
│   │   ├── commands/      - Команды вызываемые из фронтенда
│   │   ├── models/        - Реализации ИИ моделей
│   │   ├── *_impl.rs      - Реализации движков
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── ff/                    - Встроенный FFmpeg
└── package.json
</pre>
</details>

---

### 📄 Лицензия

[MIT](LICENSE)

---

<p align="center">
  <img src="https://img.shields.io/badge/Built_with-React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="react">
  <img src="https://img.shields.io/badge/Powered_by-Tauri-FFC131?style=for-the-badge&logo=tauri&logoColor=black" alt="tauri">
</p>