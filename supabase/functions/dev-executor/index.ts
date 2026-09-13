// ============================================================================
// dev-executor — автономный исполнитель задач разработки «НИОКР Команда»
// Восстановлен 2026-09-14 (Эксперт) после BOOT_ERROR. Без внешних зависимостей.
//
// Вход  (POST JSON): { "task_id": <number>, "owner": "<имя>" }
// Выход (JSON):      { ok: true, version: <number>, summary: "..." }
//                    { ok: false, error: "..." }
//
// Секреты (Dashboard → Edge Functions → Secrets):
//   GITHUB_TOKEN  — PAT с правом Contents: write на репозиторий (обязателен)
//   LLM_API_KEY   — ключ Moonshot/Kimi (обязателен)
//   LLM_BASE_URL  — необязательно, по умолчанию https://api.moonshot.ai/v1
//   LLM_MODEL     — необязательно, по умолчанию kimi-k2.7-code
//   GITHUB_REPO   — необязательно, по умолчанию AliKerimov65/niokr-pwa
// Системные SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (или SUPABASE_SECRET_KEYS)
// уже встроены в проект.
// ============================================================================

const REPO   = Deno.env.get('GITHUB_REPO')   || 'AliKerimov65/niokr-pwa';
const BRANCH = Deno.env.get('GITHUB_BRANCH') || 'main';
const LLM_BASE  = (Deno.env.get('LLM_BASE_URL') || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
const LLM_MODEL = Deno.env.get('LLM_MODEL') || 'kimi-k2.7-code';
const SB_URL = Deno.env.get('SUPABASE_URL') || '';

function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const multi = Deno.env.get('SUPABASE_SECRET_KEYS') || '';
  try {
    const j = JSON.parse(multi);
    if (Array.isArray(j)) return String(j[0]);
    const v = Object.values(j);
    return String(v[0] || '');
  } catch { return multi; }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const jres = (obj: unknown, code = 200) =>
  new Response(JSON.stringify(obj), { status: code, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- Supabase REST ----------
async function sbGetTask(id: number) {
  const r = await fetch(`${SB_URL}/rest/v1/dev_tasks?id=eq.${id}&select=*`, {
    headers: { apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}` },
  });
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
async function sbSetTask(id: number, patch: Record<string, unknown>) {
  await fetch(`${SB_URL}/rest/v1/dev_tasks?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
}

// ---------- GitHub ----------
const ghHeaders = () => ({
  Authorization: `Bearer ${Deno.env.get('GITHUB_TOKEN')}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'niokr-dev-executor',
});
function b64encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}
function b64decode(b64: string): string {
  const bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function ghGetFile(path: string): Promise<{ sha: string; text: string }> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub: не удалось прочитать ${path} (${r.status})`);
  const j = await r.json();
  return { sha: j.sha, text: b64decode(j.content) };
}
async function ghCommit(files: { path: string; text: string }[], message: string) {
  const H = ghHeaders();
  const ref = await (await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${BRANCH}`, { headers: H })).json();
  const headSha = ref.object.sha;
  const head = await (await fetch(`https://api.github.com/repos/${REPO}/git/commits/${headSha}`, { headers: H })).json();
  const tree = [];
  for (const f of files) {
    const blob = await (await fetch(`https://api.github.com/repos/${REPO}/git/blobs`, {
      method: 'POST', headers: H, body: JSON.stringify({ content: b64encode(f.text), encoding: 'base64' }),
    })).json();
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await (await fetch(`https://api.github.com/repos/${REPO}/git/trees`, {
    method: 'POST', headers: H, body: JSON.stringify({ base_tree: head.tree.sha, tree }),
  })).json();
  const commit = await (await fetch(`https://api.github.com/repos/${REPO}/git/commits`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  })).json();
  const upd = await fetch(`https://api.github.com/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ sha: commit.sha }),
  });
  if (!upd.ok) throw new Error('GitHub: не удалось обновить ветку main');
}

// ---------- LLM ----------
async function llm(system: string, user: string, maxTokens = 8000): Promise<string> {
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('LLM_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL, max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`LLM: HTTP ${r.status} — проверьте LLM_API_KEY / баланс`);
  const j = await r.json();
  let c = String(j.choices?.[0]?.message?.content || '');
  c = c.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!c) throw new Error('LLM: пустой ответ');
  return c;
}

// ---------- Карта кода: функции верхнего уровня index.html ----------
function codeMap(html: string): { name: string; start: number }[] {
  const out: { name: string; start: number }[] = [];
  const re = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(html))) out.push({ name: m[1], start: m.index });
  return out;
}
function extractRegion(html: string, start: number, cap = 6000): string {
  const open = html.indexOf('{', start);
  if (open < 0) return html.slice(start, start + 2000);
  let depth = 0, i = open;
  for (; i < Math.min(html.length, open + cap); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return html.slice(start, start + cap) + '\n// …(фрагмент обрезан)';
}

// ---------- Основной сценарий ----------
async function execute(taskId: number, owner: string) {
  const task = await sbGetTask(taskId);
  if (!task) throw new Error(`Задача #${taskId} не найдена`);
  await sbSetTask(taskId, { status: 'В работе', agent_note: null });

  const index = await ghGetFile('index.html');
  const sw = await ghGetFile('sw.js');

  // Шаг 1 — планировщик: какие функции менять
  const map = codeMap(index.text);
  const mapText = map.map(x => x.name).join(', ');
  const plan = JSON.parse(await llm(
    'Ты планировщик правок однофайлового PWA (index.html, ~400 КБ, русскоязычный проект «НИОКР Команда»). ' +
    'По задаче и списку функций верни СТРОГО JSON: {"targets":["имя1","имя2"],"notes":"что менять"}. ' +
    'Выбирай 1–6 функций, реально затронутых задачей. Никакого текста вне JSON.',
    `ЗАДАЧА: ${task.title}\n\nОПИСАНИЕ:\n${task.body || '(нет)'}\n\nФУНКЦИИ В ФАЙЛЕ: ${mapText}`,
    2000,
  ));
  const targets: string[] = Array.isArray(plan.targets) ? plan.targets.slice(0, 6) : [];
  if (!targets.length) throw new Error('Планировщик не выбрал ни одной функции');

  // Шаг 2 — извлечь регионы и запросить точные патчи
  let regions = '';
  for (const t of targets) {
    const hit = map.find(x => x.name === t);
    if (hit) regions += `\n\n===== function ${t} =====\n` + extractRegion(index.text, hit.start);
    if (regions.length > 60000) break;
  }
  const patchAns = JSON.parse(await llm(
    'Ты вносишь точечные правки в index.html однофайлового PWA. Верни СТРОГО JSON: ' +
    '{"patches":[{"old":"<точный фрагмент из присланного кода>","new":"<новый фрагмент>"}],"summary":"кратко, по-русски, что сделано"}. ' +
    'ЖЁСТКИЕ ПРАВИЛА: 1) old — дословная непрерывная подстрока из присланных регионов, встречающаяся в файле РОВНО один раз (бери с запасом контекста). ' +
    '2) Минимум правок, стиль кода сохранить. 3) Никаких комментариев вне JSON. 4) Если правка небезопасна — верни {"patches":[],"summary":"причина отказа"}.',
    `ЗАДАЧА: ${task.title}\n\nЗАМЕТКИ ПЛАНИРОВЩИКА: ${plan.notes || '—'}\n\nРЕГИОНЫ КОДА:${regions}`,
    16000,
  ));
  const patches: { old: string; new: string }[] = Array.isArray(patchAns.patches) ? patchAns.patches : [];
  const summary: string = String(patchAns.summary || 'Без описания');
  if (!patches.length) throw new Error('Исполнитель отказался: ' + summary);

  // Шаг 3 — применить патчи с проверкой уникальности
  let html = index.text;
  const applied: string[] = [];
  for (const p of patches) {
    if (!p.old || typeof p.new !== 'string') continue;
    const first = html.indexOf(p.old);
    if (first < 0 || html.indexOf(p.old, first + 1) >= 0) continue; // не найден/не уникален — пропуск
    html = html.slice(0, first) + p.new + html.slice(first + p.old.length);
    applied.push(p.old.slice(0, 60));
  }
  if (!applied.length) throw new Error('Ни один патч не лёг (якоря не уникальны) — задача требует уточнения');
  if ((html.match(/<script/g) || []).length !== (index.text.match(/<script/g) || []).length)
    throw new Error('Контроль целостности: изменилось число <script>-блоков, коммит отменён');

  // Шаг 4 — версия и коммит одним снимком
  const vm = sw.text.match(/niokr-pwa-v(\d+)/);
  const newVer = vm ? parseInt(vm[1]) + 1 : 105;
  const swNew = sw.text.replace(/niokr-pwa-v\d+/, `niokr-pwa-v${newVer}`);
  await ghCommit(
    [{ path: 'index.html', text: html }, { path: 'sw.js', text: swNew }],
    `v${newVer}: ${String(task.title).slice(0, 60)}`,
  );

  await sbSetTask(taskId, {
    status: 'Исполнено',
    agent_note: `v${newVer} · ${summary} · патчей: ${applied.length} · исполнил: ${owner || 'агент'}`,
  });
  return { ok: true, version: newVer, summary };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jres({ ok: false, error: 'POST only' }, 405);
  let taskId = 0;
  try {
    if (!Deno.env.get('GITHUB_TOKEN')) throw new Error('Нет секрета GITHUB_TOKEN');
    if (!Deno.env.get('LLM_API_KEY')) throw new Error('Нет секрета LLM_API_KEY');
    const body = await req.json().catch(() => ({}));
    taskId = Number(body.task_id) || 0;
    if (!taskId) return jres({ ok: false, error: 'Нужен task_id' }, 400);
    const res = await execute(taskId, String(body.owner || ''));
    return jres(res);
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    try {
      if (taskId) await sbSetTask(taskId, { status: 'Ошибка', agent_note: msg });
    } catch { /* запись ошибки — по возможности */ }
    return jres({ ok: false, error: msg }, 500);
  }
});
