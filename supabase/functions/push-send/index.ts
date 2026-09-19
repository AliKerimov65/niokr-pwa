// push-send — рассылка Web Push участникам команды.
// Вход (POST JSON):
//   отправка:   { members: string[], title: string, body: string, url?: string, tag?: string, kind?: string }
//   настройки:  { action: 'prefs-get', member: string }            → { ok:true, prefs:{...} }
//               { action: 'prefs-set', member: string, prefs:{} }  → { ok:true }
//
// kind — категория уведомления: 'chat' | 'dm' | 'task' | 'news' (и др. в будущем).
// Перед отправкой функция читает public.push_prefs (member → prefs jsonb) СВОЕГО проекта
// и НЕ шлёт члену категории, где prefs[kind] === false. Нет записи — всё включено.
//
// Подписки читает из public.push_subs ОСНОВНОГО проекта (member, endpoint, p256dh, auth).
// Мёртвые подписки (404/410 от push-сервиса) удаляет.
//
// Секреты (Supabase Dashboard → Edge Functions → Secrets):
//   VAPID_PUBLIC   — публичный VAPID-ключ (тот же, что вшит в index.html)
//   VAPID_PRIVATE  — приватный VAPID-ключ (хранится только здесь!)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY рантайм подставляет автоматически.
// NIOKR_SB_URL / NIOKR_SB_KEY — указатель на основной проект с push_subs.
//
// Деплой:  supabase functions deploy push-send --no-verify-jwt

// deno-lint-ignore-file no-explicit-any
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE") || "";
// Данные (push_subs) живут в проекте приложения; функция развёрнута в резервном
// проекте, поэтому заданы NIOKR_SB_URL / NIOKR_SB_KEY (publishable достаточно)
const SB_URL = Deno.env.get("NIOKR_SB_URL") || Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("NIOKR_SB_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// Настройки категорий (push_prefs) живут в ЭТОМ проекте
const OWN_URL = Deno.env.get("SUPABASE_URL") || "";
const OWN_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---- Настройки категорий (push_prefs в собственной БД) ----
async function prefsGet(member: string): Promise<Record<string, unknown>> {
  const r = await fetch(
    `${OWN_URL}/rest/v1/push_prefs?member=eq.${encodeURIComponent(member)}&select=prefs`,
    { headers: { apikey: OWN_KEY, Authorization: `Bearer ${OWN_KEY}` } },
  );
  if (!r.ok) return {};
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0] && typeof rows[0].prefs === "object" && rows[0].prefs) || {};
}
async function prefsSet(member: string, prefs: Record<string, unknown>): Promise<boolean> {
  const clean: Record<string, boolean> = {};
  for (const k of Object.keys(prefs || {}).slice(0, 20)) clean[String(k).slice(0, 24)] = !!prefs[k];
  const r = await fetch(`${OWN_URL}/rest/v1/push_prefs`, {
    method: "POST",
    headers: {
      apikey: OWN_KEY, Authorization: `Bearer ${OWN_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ member: String(member).slice(0, 120), prefs: clean, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}
async function prefsForMembers(members: string[]): Promise<Record<string, Record<string, unknown>>> {
  const inList = members.map((m) => `"${encodeURIComponent(m)}"`).join(",");
  const r = await fetch(
    `${OWN_URL}/rest/v1/push_prefs?member=in.(${inList})&select=member,prefs`,
    { headers: { apikey: OWN_KEY, Authorization: `Bearer ${OWN_KEY}` } },
  );
  const out: Record<string, Record<string, unknown>> = {};
  if (!r.ok) return out;
  for (const row of (await r.json()) || []) out[row.member] = row.prefs || {};
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  // ---- API настроек категорий ----
  if (payload?.action === "prefs-get") {
    const member = String(payload?.member || "").trim();
    if (!member) return json({ error: "member required" }, 400);
    return json({ ok: true, prefs: await prefsGet(member) });
  }
  if (payload?.action === "prefs-set") {
    const member = String(payload?.member || "").trim();
    if (!member || typeof payload?.prefs !== "object" || !payload.prefs) return json({ error: "member+prefs required" }, 400);
    const ok = await prefsSet(member, payload.prefs);
    return json({ ok });
  }

  const members: string[] = Array.isArray(payload?.members)
    ? [...new Set(payload.members.filter((m: any) => typeof m === "string" && m.trim()))]
    : [];
  if (!members.length) return json({ sent: 0 });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: "VAPID_NOT_CONFIGURED", sent: 0 }, 500);

  webpush.setVapidDetails("mailto:push@niokr-komanda.app", VAPID_PUBLIC, VAPID_PRIVATE);

  const kind = typeof payload.kind === "string" ? payload.kind.slice(0, 24) : "";

  // Фильтр категорий: исключаем членов, отключивших эту категорию
  let allowed = members;
  if (kind) {
    try {
      const prefs = await prefsForMembers(members);
      allowed = members.filter((m) => !(prefs[m] && prefs[m][kind] === false));
    } catch { /* при сбое чтения настроек шлём всем — безопасный дефолт */ }
  }
  if (!allowed.length) return json({ sent: 0, muted: members.length });

  const inList = allowed.map((m) => `"${encodeURIComponent(m)}"`).join(",");
  const subsRes = await fetch(
    `${SB_URL}/rest/v1/push_subs?member=in.(${inList})&select=id,endpoint,p256dh,auth`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  );
  if (!subsRes.ok) return json({ error: "subs fetch failed", sent: 0 }, 502);
  const subs = await subsRes.json();

  const notification = JSON.stringify({
    title: String(payload.title || "НИОКР Команда").slice(0, 80),
    body: String(payload.body || "").slice(0, 180),
    url: typeof payload.url === "string" ? payload.url : "./",
    tag: typeof payload.tag === "string" ? payload.tag : "niokr",
    kind,
  });

  let sent = 0, failed = 0;
  const dead: number[] = [];
  await Promise.all((subs || []).map(async (s: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        notification,
        { TTL: 3600 },
      );
      sent++;
    } catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.id);
    }
  }));

  if (dead.length) {
    await fetch(`${SB_URL}/rest/v1/push_subs?id=in.(${dead.join(",")})`, {
      method: "DELETE",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }).catch(() => {});
  }

  return json({ sent, failed, pruned: dead.length, muted: members.length - allowed.length });
});
