#!/usr/bin/env node
// ============================================================================
// dev-executor (GitHub Actions) — автономный исполнитель задач разработки
// «НИОКР Команда». Восстановлен 2026-09-14 (Эксперт) взамен упавшей
// Supabase Edge Function (BOOT_ERROR). Без зависимостей, Node 20+.
//
// Каждый запуск берёт ОДНУ самую раннюю задачу dev_tasks со статусом
// «Отправлено» и: планирует правку (LLM) → вносит точечные патчи →
// проверяет (якоря уникальны, число <script> не изменилось, node --check
// каждого скрипт-блока) → коммитит index.html + sw.js с новой версией →
// пишет статус/отчёт в dev_tasks.
//
// Env: SB_URL, SB_KEY (publishable), GH_TOKEN|GITHUB_TOKEN,
//      LLM_API_KEY, [LLM_BASE_URL], [LLM_MODEL], [REPO], [BRANCH], [DRY_RUN]
// ============================================================================
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SB_URL  = process.env.SB_URL  || 'https://lxgipzdybigdpdcmcnez.supabase.co';
const SB_KEY  = process.env.SB_KEY  || '';
const GH_TOK  = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const REPO    = process.env.REPO    || process.env.GITHUB_REPOSITORY || 'AliKerimov65/niokr-pwa';
const BRANCH  = process.env.BRANCH  || 'main';
const LLM_BASE  = (process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'kimi-k2-0905-preview';
const DRY_RUN = !!process.env.DRY_RUN;

const log = (...a) => console.log('[dev-executor]', ...a);

// ---------- Supabase REST ----------
async function sbFetch(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
      ...(opts.headers || {}),
    },
  });
  if (opts.method && opts.method !== 'GET') return r.ok;
  return r.json();
}
const getQueuedTask = () =>
  sbFetch("dev_tasks?status=eq.%D0%9E%D1%82%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D0%B5%D0%BD%D0%BE&order=sent_at.asc&limit=1&select=*")
    .then(rows => (Array.isArray(rows) && rows[0]) || null);
const setTask = (id, patch) =>
  DRY_RUN ? log('DRY: dev_tasks#%d ← %o', id, patch)
          : sbFetch(`dev_tasks?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

// ---------- GitHub ----------
const ghH = () => ({
  Authorization: `Bearer ${GH_TOK}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'niokr-dev-executor-actions',
});
async function ghJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: ghH() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${url} — ${j.message || ''}`);
  return j;
}
const ghGetFile = async (path) => {
  const j = await ghJson(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
  return { sha: j.sha, text: Buffer.from(j.content, 'base64').toString('utf8') };
};
async function ghCommit(files, message) {
  const ref  = await ghJson(`https://api.github.com/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const head = await ghJson(`https://api.github.com/repos/${REPO}/git/commits/${ref.object.sha}`);
  const tree = [];
  for (const f of files) {
    const blob = await ghJson(`https://api.github.com/repos/${REPO}/git/blobs`, {
      method: 'POST', body: JSON.stringify({ content: Buffer.from(f.text, 'utf8').toString('base64'), encoding: 'base64' }),
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await ghJson(`https://api.github.com/repos/${REPO}/git/trees`, {
    method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }),
  });
  const commit = await ghJson(`https://api.github.com/repos/${REPO}/git/commits`, {
    method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }),
  });
  await ghJson(`https://api.github.com/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH', body: JSON.stringify({ sha: commit.sha }),
  });
  log('коммит %s: %s', commit.sha.slice(0, 7), message);
}

// ---------- LLM ----------
async function llm(system, user, maxTokens = 8000) {
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL, temperature: 0.2, max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status} — проверьте LLM_API_KEY/баланс`);
  const j = await r.json();
  let c = String(j.choices?.[0]?.message?.content || '');
  c = c.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!c) throw new Error('LLM: пустой ответ');
  return c;
}

// ---------- Карта функций и регионы ----------
function codeMap(html) {
  const out = [];
  const re = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(html))) out.push({ name: m[1], start: m.index });
  return out;
}
function extractRegion(html, start, cap = 6000) {
  const open = html.indexOf('{', start);
  if (open < 0) return html.slice(start, start + 2000);
  let depth = 0;
  for (let i = open; i < Math.min(html.length, open + cap); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return html.slice(start, start + cap) + '\n// …(фрагмент обрезан)';
}

// ---------- Проверки результата ----------
function syntaxCheck(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  mkdirSync('/tmp/dexc', { recursive: true });
  blocks.forEach((b, i) => {
    const f = `/tmp/dexc/blk_${i}.js`;
    writeFileSync(f, b);
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { throw new Error(`Синтаксис скрипт-блока #${i} сломан после патча: коммит отменён`); }
  });
  log('node --check: %d блоков OK', blocks.length);
}

// ---------- Основной сценарий ----------
async function main() {
  if (!GH_TOK) throw new Error('Нет GH_TOKEN/GITHUB_TOKEN');
  if (!process.env.LLM_API_KEY) throw new Error('Нет LLM_API_KEY');
  if (!SB_KEY) throw new Error('Нет SB_KEY');

  const task = await getQueuedTask();
  if (!task) { log('очередь пуста'); return; }
  log('задача #%d: %s', task.id, task.title);
  await setTask(task.id, { status: 'В работе', agent_note: null });

  try {
    const index = await ghGetFile('index.html');
    const sw = await ghGetFile('sw.js');

    const map = codeMap(index.text);
    const plan = JSON.parse(await llm(
      'Ты планировщик правок однофайлового PWA (index.html, ~400 КБ, русскоязычный проект «НИОКР Команда»). ' +
      'По задаче и списку функций верни СТРОГО JSON: {"targets":["имя1","имя2"],"notes":"что менять"}. ' +
      'Выбирай 1–6 функций, реально затронутых задачей. Никакого текста вне JSON.',
      `ЗАДАЧА: ${task.title}\n\nОПИСАНИЕ:\n${task.body || '(нет)'}\n\nФУНКЦИИ В ФАЙЛЕ: ${map.map(x => x.name).join(', ')}`,
      2000));
    const targets = Array.isArray(plan.targets) ? plan.targets.slice(0, 6) : [];
    if (!targets.length) throw new Error('Планировщик не выбрал ни одной функции');
    log('цели: %s', targets.join(', '));

    let regions = '';
    for (const t of targets) {
      const hit = map.find(x => x.name === t);
      if (hit) regions += `\n\n===== function ${t} =====\n` + extractRegion(index.text, hit.start);
      if (regions.length > 60000) break;
    }
    const ans = JSON.parse(await llm(
      'Ты вносишь точечные правки в index.html однофайлового PWA. Верни СТРОГО JSON: ' +
      '{"patches":[{"old":"<точный фрагмент из присланного кода>","new":"<новый фрагмент>"}],"summary":"кратко, по-русски, что сделано"}. ' +
      'ЖЁСТКИЕ ПРАВИЛА: 1) old — дословная непрерывная подстрока из присланных регионов, встречающаяся в файле РОВНО один раз (бери с запасом контекста). ' +
      '2) Минимум правок, стиль кода сохранить. 3) Никаких комментариев вне JSON. 4) Если правка небезопасна — верни {"patches":[],"summary":"причина отказа"}.',
      `ЗАДАЧА: ${task.title}\n\nЗАМЕТКИ ПЛАНИРОВЩИКА: ${plan.notes || '—'}\n\nРЕГИОНЫ КОДА:${regions}`,
      16000));
    const patches = Array.isArray(ans.patches) ? ans.patches : [];
    const summary = String(ans.summary || 'Без описания');
    if (!patches.length) throw new Error('Исполнитель отказался: ' + summary);

    let html = index.text;
    let applied = 0;
    for (const p of patches) {
      if (!p.old || typeof p.new !== 'string') continue;
      const first = html.indexOf(p.old);
      if (first < 0 || html.indexOf(p.old, first + 1) >= 0) { log('патч пропущен (якорь не найден/не уникален): %s…', p.old.slice(0, 50)); continue; }
      html = html.slice(0, first) + p.new + html.slice(first + p.old.length);
      applied++;
    }
    if (!applied) throw new Error('Ни один патч не лёг — задача требует уточнения ТЗ');
    if ((html.match(/<script/g) || []).length !== (index.text.match(/<script/g) || []).length)
      throw new Error('Контроль целостности: изменилось число <script>-блоков, коммит отменён');
    syntaxCheck(html);

    const vm = sw.text.match(/niokr-pwa-v(\d+)/);
    const newVer = vm ? parseInt(vm[1]) + 1 : 106;
    const swNew = sw.text.replace(/niokr-pwa-v\d+/, `niokr-pwa-v${newVer}`);

    if (DRY_RUN) {
      mkdirSync('./out', { recursive: true });
      writeFileSync('./out/index.html', html);
      writeFileSync('./out/sw.js', swNew);
      log('DRY_RUN: коммит НЕ выполнен. Результат в ./out (v%d, патчей: %d)', newVer, applied);
      log('summary: %s', summary);
      return;
    }

    await ghCommit(
      [{ path: 'index.html', text: html }, { path: 'sw.js', text: swNew }],
      `v${newVer}: ${String(task.title).slice(0, 60)}`);
    await setTask(task.id, {
      status: 'Исполнено',
      agent_note: `v${newVer} · ${summary} · патчей: ${applied}`,
    });
    log('ГОТОВО: v%d — %s', newVer, summary);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    await setTask(task.id, { status: 'Ошибка', agent_note: msg });
    console.error('[dev-executor] ОШИБКА:', msg);
    process.exitCode = 1;
  }
}

main();
