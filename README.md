# threads-neuro-bot

Telegram bot + AI reply engine for Threads.net — автогенерация комментариев через vLLM/Qwen

## War of Dots

В этом же репозитории лежит игра **War of Dots** — минималистичная одиночная
RTS в реальном времени: два типа юнитов, города, которые кормят армию, и боты
трёх уровней сложности. Без зависимостей и сборки, чистые ES-модули и `<canvas>`.

```bash
npm start        # http://localhost:8080
npm test         # headless-проверки, включая детерминизм реплеев
npm run build    # dist/war-of-dots.zip для загрузки на портал
```

Открыть `game/index.html` двойным кликом нельзя — из-за ES-модулей нужен
локальный HTTP-сервер (`npm start` или `python3 -m http.server 8080 --directory game`).

Полное описание правил, управления и инструментов балансировки —
в [`game/README.md`](game/README.md).
