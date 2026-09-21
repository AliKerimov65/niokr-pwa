# Edge Functions проекта (снимок аудита 2026-09-14, обновлено 2026-09-18, Эксперт)

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
| `push-send` | ✅ РАБОТАЕТ с v141 — развёрнута в резервном проекте `nlgxrendtkxlzisqikoj` (akProject), данные читает/чистит в основном (`lxgipzdybigdpdcmcnez`) через NIOKR_SB_URL/NIOKR_SB_KEY; секреты VAPID_PUBLIC/VAPID_PRIVATE заданы. С v150: категории (`kind`) + фильтр по `push_prefs` (таблица живёт в akProject, RLS открыт); код в `supabase/functions/push-send/index.ts` | отправка `{members[], title, body, url?, kind?}`; настройки `{action:'prefs-get'/'prefs-set', member, prefs?}` | Web Push-рассылка по подпискам `push_subs` с учётом пользовательских категорий (chat/dm/task/news); вызывается клиентом после сообщений/задач/объявлений |
| `ai-fill` | ✅ РАБОТАЕТ с v162 — резервный проект `nlgxrendtkxlzisqikoj` (akProject), `--no-verify-jwt`; секрет MOONSHOT_API_KEY задан; код в `supabase/functions/ai-fill/index.ts` | `{kind:'az'|'ojr'|'act', ctx}` | Умное автозаполнение исполнительной документации: черновик полей ТОЛЬКО из фактов контекста (проект, техплан, погода, прошлые записи, ППР); клиент подставляет в обычные поля формы — пользователь правит вручную перед записью |
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
