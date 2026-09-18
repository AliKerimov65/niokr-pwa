// push-send — рассылка Web Push участникам команды.
// Вход (POST JSON): { members: string[], title: string, body: string, url?: string, tag?: string }
// Подписки читает из public.push_subs (member, endpoint, p256dh, auth).
// Мёртвые подписки (404/410 от push-сервиса) удаляет.
//
// Секреты (Supabase Dashboard → Edge Functions → Secrets):
//   VAPID_PUBLIC   — публичный VAPID-ключ (тот же, что вшит в index.html)
//   VAPID_PRIVATE  — приватный VAPID-ключ (хранится только здесь!)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY рантайм подставляет автоматически.
//
// Деплой:  supabase functions deploy push-send --no-verify-jwt

// deno-lint-ignore-file no-explicit-any
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE") || "";
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const members: string[] = Array.isArray(payload?.members)
    ? [...new Set(payload.members.filter((m: any) => typeof m === "string" && m.trim()))]
    : [];
  if (!members.length) return json({ sent: 0 });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: "VAPID_NOT_CONFIGURED", sent: 0 }, 500);

  webpush.setVapidDetails("mailto:push@niokr-komanda.app", VAPID_PUBLIC, VAPID_PRIVATE);

  const inList = members.map((m) => `"${encodeURIComponent(m)}"`).join(",");
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

  return json({ sent, failed, pruned: dead.length });
});
