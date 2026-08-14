# Ватага

Лёгкий P2P голосовой чат для 2–8 друзей. Минималистичный аналог Discord без серверов и аккаунтов.

## Возможности

- **Голосовой чат** — Opus 48 kHz, стерео, 128 кбит/с, шумоподавление, эхокомпенсация, AutoGain
- **Push-to-Talk** и **голосовая активация** с настраиваемым порогом
- **Демонстрация экрана** — с системным звуком, 30 fps, полноэкранный оверлей
- **Передача файлов** — чанки 32 КБ, прогресс/скорость/ETA, пауза/отмена, файлы 10+ ГБ
- **Автопереподключение** — ICE restart, perfect negotiation
- **Комнаты по ссылке** — код приглашения, список участников с VU-метром
- **Нулевая стоимость** — PeerJS public cloud + STUN/TURN, без серверов

## Быстрый старт

```bash
npm install
npm run dev
```

Открой http://localhost:3000 в браузере.

## Как дать ссылку друзьям

### Вариант 1: Cloudflare Pages (бесплатно)

1. Залей проект на GitHub
2. Зайди на [pages.cloudflare.com](https://pages.cloudflare.com)
3. Подключи репозиторий, укажи:
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Нажми Deploy — получишь ссылку вида `https://vataga.pages.dev`

### Вариант 2: Vercel (бесплатно)

1. Залей проект на GitHub
2. Зайди на [vercel.com](https://vercel.com)
3. Import Git Repository → выбери проект
4. Framework Preset: Vite → Deploy
5. Получишь ссылку вида `https://vataga.vercel.app`

### Вариант 3: Локальная сеть

Если все в одной Wi-Fi сети:
```bash
npm run dev -- --host 0.0.0.0
```
Друзья подключатся по `http://<твой-ip>:3000`.

## Горячие клавиши

| Клавиша | Действие |
|---------|----------|
| `M` | Mute/Unmute микрофон |
| `D` | Deafen/Undeafen |
| `Space` | Push-to-Talk (в режиме PTT) |

## Ограничения NAT

WebRTC P2P работает через NAT благодаря STUN-серверам Google. Однако:

- **Симметричный NAT** (корпоративные сети, некоторые мобильные операторы) — P2P может не установиться
- В таких случаях используется TURN-сервер Cloudflare как fallback
- Если TURN тоже заблокирован — связь невозможна (очень редко)

## Замена сигналинга

Сигналинг вынесен в `src/signaling.js`. Для замены на свой сервер:

1. Открой `src/signaling.js`
2. Замени функции `createPeer`, `connectToPeer`, `callPeer`
3. Варианты: Supabase Realtime, свой WebSocket-сервер, Firebase

## Структура проекта

```
vataga/
├── index.html          # Разметка
├── vite.config.js      # Конфиг Vite
├── package.json
├── src/
│   ├── app.js          # Главный модуль, UI-логика
│   ├── signaling.js    # PeerJS обёртка
│   ├── audio.js        # Микрофон, VU-метр, аудио-настройки
│   ├── screen.js       # Демонстрация экрана
│   ├── files.js        # Передача файлов через DataChannel
│   ├── rooms.js        # Комнаты, участники, лог событий
│   ├── reconnect.js    # Переподключение, ICE restart
│   └── styles.css      # Стили
└── dist/               # Production сборка
```

## Требования

- Node.js 18+
- Современный браузер (Chrome 90+, Firefox 90+, Safari 15+, Edge 90+)
- HTTPS для getUserMedia/getDisplayMedia (localhost — исключение)

## Лицензия

MIT
