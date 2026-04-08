<p align="center">
  <img src="icon.webp" alt="FFStudio" width="1000">
</p>


<p align="center">
<img src="https://readme-typing-svg.demolab.com?font=Share+Tech+Mono&size=20&pause=2000&color=1A6BFF&center=true&vCenter=true&width=700&height=45&duration=40&lines=FFStudio+%E2%80%94+FFmpeg+GUI;React+%2B+Tauri+(Rust)+desktop+app;Convert+%E2%80%A2+Trim+%E2%80%A2+Resize+%E2%80%A2+Extract;No+terminal+required">
</p>



<p align="center">
  <img src="https://img.shields.io/github/license/yourname/ffstudio?style=for-the-badge&label=LICENSE&color=1A6BFF&labelColor=0a0a0f" alt="license">
  <img src="https://img.shields.io/github/stars/yourname/ffstudio?style=for-the-badge&label=STARS&color=1A6BFF&labelColor=0a0a0f" alt="stars">
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

## 📸 Скриншоты

<p align="center">
  <kbd>
    <img src="screen5.png" width="90%" alt="FFStudio Главный экран"/>
  </kbd>
</p>

<details>
<summary>🔍 Ещё скриншоты</summary>
<br>

<p align="center">
  <img src="screen1.png" width="80%"/>
  <br><br>
  <img src="screen2.png" width="80%"/>
  <br><br>
  <img src="screen3.png" width="80%"/>
  <br><br>
  <img src="screen4.png" width="80%"/>
</p>

</details>

<br>

---

<table>
<tr>
<td width="33%">
<img src="https://img.shields.io/badge/React_+_Tauri-1A6BFF?style=flat-square&logoColor=white"/>

Нативное приложение
</td>
<td width="33%">
<img src="https://img.shields.io/badge/No_Terminal-007808?style=flat-square&logoColor=white"/>

Без консоли
</td>
<td width="33%">
<img src="https://img.shields.io/badge/Video_Processing-BA7517?style=flat-square&logoColor=white"/>

Конвертация, обрезка
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
</p>

---

### ⚙️ Требования

> Node.js `16+` &nbsp;•&nbsp; Rust `1.70+` &nbsp;•&nbsp; FFmpeg в системном `PATH`

---

### 🚀 Установка

```bash
# 1. Зависимости Node.js
npm install

# 2. Зависимости Rust
cd src-tauri && cargo build

# 3. Режим разработки
npm run dev

# 4. Сборка
npm run build
```

---

### 📂 Структура

<details>
<summary><b>Показать структуру проекта</b></summary>
<br>
<pre>
ff-studio/
├── src/                   - React-интерфейс
│   ├── components/        - UI-компоненты
│   ├── App.jsx            - корневой компонент
│   └── index.css          - глобальные стили
├── src-tauri/             - Rust / Tauri
│   ├── src/main.rs        - точка входа
│   ├── Cargo.toml         - зависимости Rust
│   └── tauri.conf.json    - конфигурация Tauri
├── ff/                    - FFmpeg-файлы
├── dist/                  - сборка Vite
└── package.json
</pre>
</details>

---

### 🎬 Возможности

- Конвертация видео между форматами
- Извлечение аудиодорожки
- Обрезка по временным меткам
- Изменение разрешения и битрейта
- И многое другое - без терминала

---

### 📄 Лицензия

[MIT](LICENSE)

---

<p align="center">
  <img src="https://img.shields.io/badge/Built_with-React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="react">
  <img src="https://img.shields.io/badge/Powered_by-Tauri-FFC131?style=for-the-badge&logo=tauri&logoColor=black" alt="tauri">
</p>