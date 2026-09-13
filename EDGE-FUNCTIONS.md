# Edge Functions проекта (снимок аудита 2026-09-14, Эксперт)

Базовый URL: `https://lxgipzdybigdpdcmcnez.supabase.co/functions/v1/`

Код функций в git НЕ хранится (только в Supabase) — это риск. При первой
возможности выгрузите код каждой функции в папку `supabase/functions/`.

| Функция | Статус | Вход (POST JSON) | Назначение |
|---|---|---|---|
| `agent` | ✅ 200 | `{team_id, owner, text, thread_id}` | Агент владельца (Kimi): диалог с инструментами, пишет `agent_messages` |
| `consult` | ✅ 200 | `{team_id, question, item}` | Консультант по этапам НИОКР (3-этапный ответ) |
| `qa-scan` | ✅ 200 | `{team_id, owner}` | Авто-QA: скан переписки → очередь `qa_queue` |
| `sms-gateway` | ✅ 200 | `{action:'send', member, text}` | SMS/мессенджер-шлюз уведомлений |
| `max-bot` | ✅ 200 | `{action:'send', member, text}` | Отправка в MAX по `max_links.chat_id` |
| `az-polish` | ✅ 200 | `{text}` | Обработка голосовой диктовки журнала АН |
| `dev-executor` | 🔄 ПЕРЕНЕСЁН в GitHub Actions (2026-09-14) | очередь `dev_tasks` → коммит | Автоисполнитель задач: см. `.github/workflows/dev-executor.yml` + `tools/dev-executor.mjs` |

## dev-executor (архитектура с 2026-09-14)
Supabase-функция заменена workflow GitHub Actions (крон каждые 5 минут + ручной запуск):
забирает одну задачу «Отправлено» из `dev_tasks`, LLM-патчит `index.html`, проверяет
(уникальные якоря, контроль `<script>`, node --check), поднимает версию в `sw.js`, коммитит.
Секрет `LLM_API_KEY` хранится в репозитории (Actions secrets). Код — `tools/dev-executor.mjs`.
Исходный Deno-вариант сохранён в `supabase/functions/dev-executor/index.ts` как резерв
(если развёрнуть его с секретами GITHUB_TOKEN+LLM_API_KEY — будет мгновенный запуск без очереди).

## Ремонт dev-executor (СТАРАЯ Edge Function — архив)
1. Supabase Dashboard → Edge Functions → `dev-executor` → **Logs** — причина BOOT_ERROR
   (обычно: отсутствует/протух секрет env, синтаксическая ошибка после правки, тяжёлый импорт).
2. Проверить секреты функции (Settings → Edge Functions): токен GitHub и ключ LLM
   должны быть действующими.
3. Передеплой: `supabase functions deploy dev-executor` (нужен access token владельца проекта).
4. Клиент корректно переживает отказ: задача остаётся в статусе «Отправлено»;
   после восстановления функции кнопка «Повторить» (devRetry) отправит её снова.
