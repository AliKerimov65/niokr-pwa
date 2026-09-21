// ai-fill — умное интеллектуальное автозаполнение исполнительной документации:
// Общий журнал работ (ОЖР), акты (АОСР/АПР/АП), журнал авторского надзора (АН).
//
// Вход (POST JSON): { kind: 'az' | 'ojr' | 'act', ctx: {...} }
// Выход: { ok: true, fields: {...} } — черновик полей; клиент подставляет их
// в ОБЫЧНЫЕ поля формы, пользователь проверяет и правит вручную перед записью.
//
// Принцип: модель работает ТОЛЬКО с фактами из ctx (проект, техплан, погода,
// последние записи, ППР). В системном промпте жёсткий запрет выдумывать данные:
// чего нет в контексте — поле возвращается пустой строкой.
//
// Секрет: MOONSHOT_API_KEY (Supabase Dashboard → Edge Functions → Secrets).
// Деплой: supabase functions deploy ai-fill --no-verify-jwt
// (функция в резервном проекте akProject, вызывается клиентом напрямую, как push-send)

// deno-lint-ignore-file no-explicit-any

const KEY = Deno.env.get("MOONSHOT_API_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SCHEMAS: Record<string, Record<string, string>> = {
  az: {
    works: "строка — виды выполненных работ за посещение (деловой стиль журнала АН)",
    conformity: "строго одно из: «Соответствует проектным решениям», «Частично соответствует», «Не соответствует»",
    remarks: "строка — замечания, если следуют из контекста, иначе пустая строка",
  },
  ojr: {
    name: "строка — наименование работ для раздела 3 ОЖР с указанием этапа техплана; место (скв./отм.) оставить заготовкой «скв. №____, отм. ____», если в контексте нет точных данных",
    cond: "строка — условия производства работ: смена, погода из контекста, особые условия",
  },
  act: {
    basis_project: "строка — основание: проектная документация/ППР, раздел (по контексту ППР)",
    basis_quality: "строка — предъявленные документы о качестве (по контексту ППР)",
    date_from: "строка YYYY-MM-DD — начало работ (из статусов техплана), иначе пустая строка",
    date_to: "строка YYYY-MM-DD — окончание работ (из статусов техплана), иначе пустая строка",
    attach: "строка — приложения: исполнительные схемы, протоколы, сертификаты — только те, что следуют из контекста",
  },
};

const SYS = `Ты — опытный инженер строительного контроля. Готовишь ЧЕРНОВИК записи исполнительной документации СТРОГО на основе переданного контекста.

Жёсткие правила:
- Используй ТОЛЬКО факты из контекста. Выдумывать объёмы, даты, документы, людей и факты ЗАПРЕЩЕНО: нет данных — верни пустую строку "".
- Деловой стиль исполнительной документации (ГОСТ Р 21.101-2020, СП 48.13330.2019): кратко, точно, без оценочных слов.
- Если в контексте есть замечания/несоответствия — conformity только «Частично соответствует» или «Не соответствует»; иначе «Соответствует проектным решениям».
- Не упоминай, что это черновик, и не добавляй пояснений — только JSON.
- Ответ — строго один JSON-объект без markdown-обёртки.`;

async function moonshot(model: string, user: string): Promise<string> {
  const r = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error("moonshot " + r.status + ": " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!txt) throw new Error("пустой ответ модели");
  return txt;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const reply = (o: any, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    if (!KEY) return reply({ ok: false, error: "MOONSHOT_API_KEY не задан" });
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind || "");
    const ctx = body.ctx && typeof body.ctx === "object" ? body.ctx : {};
    const schema = SCHEMAS[kind];
    if (!schema) return reply({ ok: false, error: "unknown kind: " + kind });

    const user =
      "Контекст (JSON, только эти факты):\n" + JSON.stringify(ctx).slice(0, 12000) +
      "\n\nТребуемые поля и формат каждого поля:\n" + JSON.stringify(schema);

    let txt: string;
    try {
      txt = await moonshot("kimi-k3", user);
    } catch (_) {
      txt = await moonshot("kimi-k2.6", user);
    }
    let fields: any = {};
    try { fields = JSON.parse(txt); } catch (_) {
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { try { fields = JSON.parse(m[0]); } catch (_) { /* пусто */ } }
    }
    // оставляем только объявленные ключи, всё — строки
    const out: Record<string, string> = {};
    for (const k of Object.keys(schema)) {
      const v = fields[k];
      out[k] = typeof v === "string" ? v : (v == null ? "" : String(v));
    }
    return reply({ ok: true, fields: out });
  } catch (e) {
    return reply({ ok: false, error: String((e && (e as Error).message) || e) });
  }
});
