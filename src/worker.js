// Philips "Testuj Produkty" — powiadomienia na Telegram o nowych testach do zgłoszenia.
// Cloudflare Worker uruchamiany cronem co 15 minut. Stan w KV.
//
// Bindingi:
//   STATE               – KV namespace
//   TELEGRAM_BOT_TOKEN  – sekret
//   CHECK_KEY           – sekret (klucz do ręcznego /check)
//   TELEGRAM_CHAT_ID    – zmienna (grupa, do której bot pisze)
//   DRY_RUN=1           – (test lokalny) nic nie wysyłaj, tylko loguj

const LIST_URL = "https://testujprodukty.pl/testy";
const TZ = "Europe/Warsaw";
const QUIET_FROM = 23;
const QUIET_TO = 7;
const STATE_KEY = "state";

// ---------- Pobieranie i parsowanie strony ----------

const decode = (s) => s
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();

export function parseTrials(html) {
  return html.split('class="trial-item"').slice(1).map((chunk) => {
    const url = chunk.match(/href="(https:\/\/testujprodukty\.pl\/test\/[^"]+)"/)?.[1];
    if (!url) return null;
    const name = decode(chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] || "");
    const desc = decode(chunk.match(/<div class="content">[\s\S]*?<\/h3>([\s\S]*?)<\/div>/)?.[1] || "");
    const text = decode(chunk);
    return {
      id: url.split("/test/")[1],
      url,
      name,
      desc,
      open: /Weź udział/.test(text) && !/Czas na zgłoszenie minął/.test(text),
      deadline: text.match(/Termin przyjmowania zgłoszeń:\s*([\d.]+)/)?.[1] || null,
      prizes: text.match(/Liczba nagród:\s*(\d+)/)?.[1] || null,
    };
  }).filter(Boolean);
}

async function fetchTrials() {
  const res = await fetch(LIST_URL, { headers: { "User-Agent": "Mozilla/5.0 (trial-watcher)", "Accept-Language": "pl" } });
  if (!res.ok) throw new Error(`testujprodukty.pl HTTP ${res.status}`);
  const trials = parseTrials(await res.text());
  // Zabezpieczenie: jeśli strona zmieni wygląd i nic nie sparsujemy, nie ruszamy stanu.
  if (!trials.length) throw new Error("Nie znaleziono żadnych testów — zmienił się wygląd strony?");
  return trials;
}

// ---------- Telegram ----------

async function send(env, text) {
  if (env.DRY_RUN === "1") { console.log(`[DRY_RUN] sendMessage\n${text}`); return; }
  const chunks = []; let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + line).length > 3900) { chunks.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur.trim()) chunks.push(cur);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
  }
}

// ---------- Logika ----------

const formatTrial = (t) => {
  const meta = [t.deadline && `zgłoszenia do ${t.deadline}`, t.prizes && `nagród: ${t.prizes}`].filter(Boolean).join(" · ");
  return `• ${t.name}${meta ? `\n  ${meta}` : ""}\n  ${t.url}`;
};

function warsawHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));
}
const isQuiet = (h) => (QUIET_FROM > QUIET_TO ? h >= QUIET_FROM || h < QUIET_TO : h >= QUIET_FROM && h < QUIET_TO);

async function check(env) {
  const trials = await fetchTrials();
  const open = trials.filter((t) => t.open);
  const prev = await env.STATE.get(STATE_KEY, "json");
  const state = prev || { notified: [], pending: [] };
  const notified = new Set(state.notified);
  let changed = !prev;

  if (!prev) {
    for (const t of open) notified.add(t.id);
    const list = open.length ? `\n\nTeraz otwarte (${open.length}):\n${open.map(formatTrial).join("\n")}` : "";
    await send(env, `✅ Monitoring testujprodukty.pl (Philips) działa.\nDam znać, gdy pojawi się nowy test do zgłoszenia.${list}`);
  } else {
    for (const t of open) {
      if (!notified.has(t.id)) {
        notified.add(t.id);
        state.pending.push(t);
        changed = true;
      }
    }
  }

  // Nie przypominaj o testach, które zdążyły się zamknąć w nocy.
  const openIds = new Set(open.map((t) => t.id));
  const before = state.pending.length;
  state.pending = state.pending.filter((t) => openIds.has(t.id));
  if (state.pending.length !== before) changed = true;

  const quiet = isQuiet(warsawHour());
  if (state.pending.length && !quiet) {
    const head = state.pending.length === 1 ? "🆕 Nowy test Philips do zgłoszenia:" : `🆕 Nowe testy Philips do zgłoszenia (${state.pending.length}):`;
    await send(env, `${head}\n${state.pending.map(formatTrial).join("\n")}`);
    state.pending = [];
    changed = true;
  }

  // KV ma limit zapisów w darmowym planie — zapisujemy tylko przy zmianie.
  if (changed) {
    state.notified = [...notified];
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
  }
  return { trials: trials.length, open: open.length, pending: state.pending.length, quiet };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/check" && env.CHECK_KEY && url.searchParams.get("key") === env.CHECK_KEY) {
      return Response.json(await check(env));
    }
    return new Response("Philips trial watcher");
  },
};
