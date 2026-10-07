import type { Config, Context } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";

/*
 * Juego Decisiones de Marketing — API de salas en línea
 *
 * Claves en el store (por sala <CODE>):
 *   <CODE>/meta                          { key, createdAt }                 clave del profesor
 *   <CODE>/state                         estado público que publica el profesor (+ endsAt, savedAt)
 *   <CODE>/g/<gid>/<nombre-b64url>       grupo o participante registrado (gid = 0..11, define el color)
 *   <CODE>/a/<gid>/<i>/<respuesta>       respuesta vigente del grupo en la ronda i (el valor va en la clave:
 *                                        el profesor lee todas las respuestas con un solo list)
 *
 * Formato de <respuesta>:  <ts36>~<l0.l1>~<s>~<s2>~<m>~<c>   (índices; "x" = vacío, "n" = ninguna)
 */

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_GROUPS = 12;
const GRACE_MS = 3000;

type Store = {
  get(key: string, opts?: { type?: "json" | "text" }): Promise<any>;
  set(key: string, value: string): Promise<void>;
  setJSON(key: string, value: any): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }>;
  delete(key: string): Promise<void>;
};

function store(): Store {
  const opts = { name: "jdm-salas", consistency: "strong" as const };
  if (Netlify.context?.deploy?.context === "production") return getStore(opts) as unknown as Store;
  return getDeployStore(opts) as unknown as Store;
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

const code4 = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const b64e = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const b64d = (s: string) => { try { return Buffer.from(s, "base64url").toString("utf8"); } catch { return ""; } };
const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 28);
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

function randomCode(n = 4) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => ALPHA[x % ALPHA.length]).join("");
}
function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function isHost(st: Store, code: string, key: unknown) {
  if (!code || !key) return false;
  const meta = await st.get(`${code}/meta`, { type: "json" });
  return !!meta && meta.key === key;
}

async function readGroups(st: Store, code: string) {
  const { blobs } = await st.list({ prefix: `${code}/g/` });
  const map: Record<string, string> = {};
  for (const b of blobs) {
    const [, , gid, enc] = b.key.split("/");
    if (gid !== undefined && enc) map[gid] = b64d(enc);
  }
  return Object.entries(map).map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.id - b.id);
}

/* Respuestas: { gid: { i: {ts, l, s, s2, m, c} } } con un solo list */
function parseAnswer(raw: string) {
  const [ts36, l, s, s2, m, c] = raw.split("~");
  const num = (x: string) => (x === "x" || x === undefined || x === "" ? null : x === "n" ? "n" : Number(x));
  return { ts: parseInt(ts36, 36) || 0, l: (l || "").split(".").map(num), s: num(s), s2: num(s2), m: num(m), c: num(c) };
}
async function readAnswers(st: Store, code: string, gid?: number) {
  const { blobs } = await st.list({ prefix: gid === undefined ? `${code}/a/` : `${code}/a/${gid}/` });
  const out: Record<string, Record<string, any>> = {};
  for (const b of blobs) {
    const [, , g, i, raw] = b.key.split("/");
    if (g === undefined || i === undefined || !raw) continue;
    const a = parseAnswer(raw);
    const cur = (out[g] = out[g] || {})[i];
    if (!cur || a.ts >= cur.ts) out[g][i] = a;
  }
  return out;
}

/* Valida y codifica la respuesta contra la definición de la ronda publicada por el profesor */
function encodeAnswer(round: any, a: any, now: number) {
  if (!round || !a || typeof a !== "object") return null;
  const lo: number[][] = round.lo || [];
  const idx = (v: any, n: number, allowN = false) => {
    if (v === null || v === undefined) return "x";
    if (allowN && v === "n") return "n";
    const k = Number(v);
    return Number.isInteger(k) && k >= 0 && k < n ? String(k) : null;
  };
  const l = lo.map((opts, qi) => idx(Array.isArray(a.l) ? a.l[qi] : null, opts.length));
  const nS = (round.so || []).length + 8, nM = (round.mo || []).length + 8;
  const s = idx(a.s, nS), s2 = idx(a.s2, nS, true), m = idx(a.m, nM), c = idx(a.c, 3);
  if (l.some((x) => x === null) || s === null || s2 === null || m === null || c === null) return null;
  return `${now.toString(36)}~${l.join(".")}~${s}~${s2}~${m}~${c}`;
}

async function writeAnswer(st: Store, code: string, gid: number, i: number, payload: string) {
  const prefix = `${code}/a/${gid}/${i}/`;
  const newKey = prefix + payload;
  await st.set(newKey, "1");
  const { blobs } = await st.list({ prefix });
  await Promise.all(blobs.filter((b) => b.key !== newKey).map((b) => st.delete(b.key)));
}

function answersOpen(state: any, i: number, now: number) {
  if (!state || state.phase !== "play") return "closed";
  if (state.endsAt && now > state.endsAt + GRACE_MS) return "time";
  if (state.pace === "free") return Number.isInteger(i) && i >= 0 && i < (state.rounds || []).length ? "" : "closed";
  if (state.i !== i || state.stage !== "decide") return "closed";
  return "";
}

export async function handle(req: Request, st: Store, now = Date.now()) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/api\/?/, "").replace(/\/$/, "");

  /* ── Crear sala (profesor) ── */
  if (route === "room" && req.method === "POST") {
    let code = "";
    for (let t = 0; t < 10; t++) {
      const c = randomCode(4);
      if (!(await st.get(`${c}/meta`))) { code = c; break; }
    }
    if (!code) return json({ error: "no_code" }, 503);
    const key = randomKey();
    await st.setJSON(`${code}/meta`, { key, createdAt: now });
    await st.setJSON(`${code}/state`, { phase: "lobby", v: 0, savedAt: now });
    return json({ code, key });
  }

  /* ── Publicar estado (profesor) ── */
  if (route === "state" && req.method === "POST") {
    const body = await req.json();
    const code = code4(body.code);
    if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
    const s = body.state || {};
    s.savedAt = now;
    const t = s.timer;
    s.endsAt = t && t.running && typeof t.remaining === "number" ? now + Math.max(0, t.remaining) * 1000 : null;
    await st.setJSON(`${code}/state`, s);
    return json({ ok: true, savedAt: now, endsAt: s.endsAt, serverNow: now });
  }

  /* ── Estado para los dispositivos (igual para todos: se cachea 2 s en el CDN) ── */
  if (route === "state" && req.method === "GET") {
    const code = code4(url.searchParams.get("code"));
    const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
    if (!state) return json({ error: "no_room" }, 404);
    const groups = await readGroups(st, code);
    return json({ state, groups, serverNow: now }, 200, {
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": "public, durable, s-maxage=2",
      "netlify-vary": "query=code",
    });
  }

  /* ── Unirse o crear grupo (dispositivo; el profesor también puede crear) ── */
  if (route === "join" && req.method === "POST") {
    const body = await req.json();
    const code = code4(body.code);
    const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
    if (!state) return json({ error: "no_room" }, 404);
    if (state.phase === "end") return json({ error: "ended" }, 409);
    const groups = await readGroups(st, code);
    if (body.gid !== undefined && body.gid !== null && body.gid !== "") {
      const g = groups.find((x) => x.id === Number(body.gid));
      return g ? json({ ok: true, gid: g.id, name: g.name }) : json({ error: "no_group" }, 404);
    }
    const name = cleanName(body.name);
    if (!name) return json({ error: "bad_request" }, 400);
    const same = groups.find((x) => norm(x.name) === norm(name));
    if (same) return json({ ok: true, gid: same.id, name: same.name, existing: true });
    const used = new Set(groups.map((g) => g.id));
    let gid = -1;
    for (let k = 0; k < MAX_GROUPS; k++) if (!used.has(k)) { gid = k; break; }
    if (gid < 0) return json({ error: "full" }, 409);
    await st.set(`${code}/g/${gid}/${b64e(name)}`, "1");
    return json({ ok: true, gid, name });
  }

  /* ── Quitar un grupo (profesor) ── */
  if (route === "kick" && req.method === "POST") {
    const body = await req.json();
    const code = code4(body.code), gid = Number(body.gid);
    if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
    if (!Number.isInteger(gid)) return json({ error: "bad_request" }, 400);
    const a = await st.list({ prefix: `${code}/g/${gid}/` });
    const b = await st.list({ prefix: `${code}/a/${gid}/` });
    await Promise.all([...a.blobs, ...b.blobs].map((x) => st.delete(x.key)));
    return json({ ok: true });
  }

  /* ── Responder una ronda (dispositivo, o el profesor al corregir) ── */
  if (route === "answer" && req.method === "POST") {
    const body = await req.json();
    const code = code4(body.code), gid = Number(body.gid), i = Number(body.i);
    if (!code || !Number.isInteger(gid) || !Number.isInteger(i)) return json({ error: "bad_request" }, 400);
    const state = await st.get(`${code}/state`, { type: "json" });
    if (!state) return json({ error: "no_room" }, 404);
    const host = body.key ? await isHost(st, code, body.key) : false;
    const groups = await readGroups(st, code);
    if (!groups.some((g) => g.id === gid)) return json({ error: "no_group" }, 404);
    if (!host) {
      const why = answersOpen(state, i, now);
      if (why) return json({ error: why }, 409);
      if (state.pace === "free") {
        const prev = await st.list({ prefix: `${code}/a/${gid}/${i}/` });
        if (prev.blobs.length) return json({ error: "already" }, 409);
      }
    }
    const payload = encodeAnswer((state.rounds || [])[i], body.a, now);
    if (!payload) return json({ error: "bad_answer" }, 400);
    await writeAnswer(st, code, gid, i, payload);
    return json({ ok: true, serverNow: now });
  }

  /* ── Respuestas de un grupo (dispositivo que se reconecta) ── */
  if (route === "mine" && req.method === "GET") {
    const code = code4(url.searchParams.get("code")), gid = Number(url.searchParams.get("gid"));
    if (!code || !Number.isInteger(gid)) return json({ error: "bad_request" }, 400);
    const all = await readAnswers(st, code, gid);
    return json({ answers: all[String(gid)] || {}, serverNow: now });
  }

  /* ── Sondeo del profesor: grupos + todas las respuestas ── */
  if (route === "poll" && req.method === "GET") {
    const code = code4(url.searchParams.get("code"));
    if (!(await isHost(st, code, url.searchParams.get("key")))) return json({ error: "forbidden" }, 403);
    const [groups, answers] = await Promise.all([readGroups(st, code), readAnswers(st, code)]);
    return json({ groups, answers, serverNow: now });
  }

  return json({ error: "not_found" }, 404);
}

export default async (req: Request, _context: Context) => {
  try {
    return await handle(req, store());
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
