import type { Config, Context } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";

/*
 * Juego Decisiones de Marketing — API de salas en línea (V10)
 *
 * Claves en el store (por sala <CODE>):
 *   <CODE>/meta                              { key, createdAt }              clave del profesor
 *   <CODE>/state                             estado público que publica el profesor (+ endsAt, savedAt)
 *   <CODE>/g/<gid>/<nombre-b64url>           grupo (gid = 0..11, define el color)
 *   <CODE>/m/<mid>/<gid|x>/<nombre-b64url>   alumno conectado y el grupo al que pertenece (x = sin grupo)
 *   <CODE>/a/<gid>/<i>/<respuesta>           respuesta vigente del grupo en la ronda i (el valor va en la clave)
 *
 * Formato de <respuesta>:  <ts36>~<l0.l1>~<s>~<s2>~<m>~<c>~<autor-b64url>   (índices; "x" = vacío, "n" = ninguna)
 */

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_GROUPS = 12;
const MAX_MEMBERS = 90;
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
const clean = (s: unknown, max = 24) => String(s ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, max);
const b64e = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const b64d = (s: string) => { try { return Buffer.from(s, "base64url").toString("utf8"); } catch { return ""; } };
const cleanName = (s: unknown, max = 28) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
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

/* ── lecturas con un solo list ── */
async function readGroups(st: Store, code: string) {
  const { blobs } = await st.list({ prefix: `${code}/g/` });
  const map: Record<string, string> = {};
  for (const b of blobs) {
    const [, , gid, enc] = b.key.split("/");
    if (gid !== undefined && enc) map[gid] = b64d(enc);
  }
  return Object.entries(map).map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.id - b.id);
}
async function readMembers(st: Store, code: string) {
  const { blobs } = await st.list({ prefix: `${code}/m/` });
  const map: Record<string, { mid: string; gid: number | null; name: string }> = {};
  for (const b of blobs) {
    const [, , mid, g, enc] = b.key.split("/");
    if (!mid || !enc) continue;
    map[mid] = { mid, gid: g === "x" || g === undefined ? null : Number(g), name: b64d(enc) };
  }
  return Object.values(map).sort((a, b) => a.name.localeCompare(b.name, "es"));
}
function parseAnswer(raw: string) {
  const [ts36, l, s, s2, m, c, by] = raw.split("~");
  const num = (x: string) => (x === "x" || x === undefined || x === "" ? null : x === "n" ? "n" : Number(x));
  return { ts: parseInt(ts36, 36) || 0, l: (l || "").split(".").map(num), s: num(s), s2: num(s2), m: num(m), c: num(c), by: by ? b64d(by) : "" };
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

/* ── alumnos ── */
async function setMember(st: Store, code: string, mid: string, gid: number | null, name: string) {
  const { blobs } = await st.list({ prefix: `${code}/m/${mid}/` });
  const key = `${code}/m/${mid}/${gid === null ? "x" : gid}/${b64e(name)}`;
  await st.set(key, "1");
  await Promise.all(blobs.filter((b) => b.key !== key).map((b) => st.delete(b.key)));
}

/* ── respuestas ── */
function encodeAnswer(round: any, a: any, by: string, now: number) {
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
  return `${now.toString(36)}~${l.join(".")}~${s}~${s2}~${m}~${c}~${by ? b64e(by) : ""}`;
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
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

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
    await st.setJSON(`${code}/state`, { phase: "lobby", v: 0, savedAt: now, assign: body.assign === "host" ? "host" : "free", kind: body.kind === "individual" ? "individual" : "grupos" });
    return json({ code, key });
  }

  /* ── Publicar estado (profesor) ── */
  if (route === "state" && req.method === "POST") {
    const code = code4(body.code);
    if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
    const s = body.state || {};
    s.savedAt = now;
    const t = s.timer;
    s.endsAt = t && t.running && typeof t.remaining === "number" ? now + Math.max(0, t.remaining) * 1000 : null;
    await st.setJSON(`${code}/state`, s);
    return json({ ok: true, savedAt: now, endsAt: s.endsAt, serverNow: now });
  }

  /* ── Estado para los alumnos (igual para todos: se cachea 2 s en el CDN) ── */
  if (route === "state" && req.method === "GET") {
    const code = code4(url.searchParams.get("code"));
    const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
    if (!state) return json({ error: "no_room" }, 404);
    const [groups, members, answers] = await Promise.all([readGroups(st, code), readMembers(st, code), readAnswers(st, code)]);
    // Sello por grupo: cambia cuando el grupo envía una respuesta (sin revelar su contenido)
    const stamps: Record<string, string> = {};
    for (const [g, byI] of Object.entries(answers)) {
      if (state.pace === "free") stamps[g] = String(Object.keys(byI).length) + ":" + Math.max(...Object.values(byI).map((a: any) => a.ts));
      else if (byI[String(state.i)]) stamps[g] = String(byI[String(state.i)].ts);
    }
    return json({ state, groups, members, stamps, serverNow: now }, 200, {
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": "public, durable, s-maxage=2",
      "netlify-vary": "query=code",
    });
  }

  /* ── Registrarse con su nombre (alumno) ── */
  if (route === "member" && req.method === "POST") {
    const code = code4(body.code), mid = clean(body.mid), name = cleanName(body.name, 32);
    if (!code || !mid || !name) return json({ error: "bad_request" }, 400);
    const state = await st.get(`${code}/state`, { type: "json" });
    if (!state) return json({ error: "no_room" }, 404);
    if (state.phase === "end") return json({ error: "ended" }, 409);
    const members = await readMembers(st, code);
    const me = members.find((m) => m.mid === mid);
    if (!me && members.length >= MAX_MEMBERS) return json({ error: "full" }, 409);
    const gid = body.leave ? null : me ? me.gid : null;
    if (body.leave && state.assign === "host" && state.kind !== "individual") return json({ error: "host_only" }, 403);
    await setMember(st, code, mid, gid, name);
    return json({ ok: true, mid, gid, name });
  }

  /* ── Crear grupo o entrar a uno (alumno o profesor) ── */
  if (route === "join" && req.method === "POST") {
    const code = code4(body.code);
    const state = code ? await st.get(`${code}/state`, { type: "json" }) : null;
    if (!state) return json({ error: "no_room" }, 404);
    if (state.phase === "end") return json({ error: "ended" }, 409);
    const host = body.key ? await isHost(st, code, body.key) : false;
    const groups = await readGroups(st, code);
    let g: { id: number; name: string } | undefined, existing = false;
    if (body.gid !== undefined && body.gid !== null && body.gid !== "") {
      g = groups.find((x) => x.id === Number(body.gid));
      if (!g) return json({ error: "no_group" }, 404);
    } else {
      const name = cleanName(body.name);
      if (!name) return json({ error: "bad_request" }, 400);
      g = groups.find((x) => norm(x.name) === norm(name));
      if (g) existing = true;
      else {
        if (!host && state.assign === "host" && state.kind !== "individual") return json({ error: "host_only" }, 403);
        const used = new Set(groups.map((x) => x.id));
        let gid = -1;
        for (let k = 0; k < MAX_GROUPS; k++) if (!used.has(k)) { gid = k; break; }
        if (gid < 0) return json({ error: "full" }, 409);
        await st.set(`${code}/g/${gid}/${b64e(name)}`, "1");
        g = { id: gid, name };
      }
    }
    const mid = clean(body.mid), mname = cleanName(body.member, 32);
    if (mid && mname) await setMember(st, code, mid, g.id, mname);
    return json({ ok: true, gid: g.id, name: g.name, existing });
  }

  /* ── Asignar un alumno a un grupo, o dejarlo sin grupo (profesor) ── */
  if (route === "assign" && req.method === "POST") {
    const code = code4(body.code), mid = clean(body.mid);
    if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
    const members = await readMembers(st, code), me = members.find((m) => m.mid === mid);
    if (!me) return json({ error: "no_member" }, 404);
    const gid = body.gid === null || body.gid === undefined || body.gid === "" ? null : Number(body.gid);
    if (gid !== null && !(await readGroups(st, code)).some((g) => g.id === gid)) return json({ error: "no_group" }, 404);
    await setMember(st, code, mid, gid, me.name);
    return json({ ok: true });
  }

  /* ── Asignar varios alumnos de una vez (profesor): {pairs: [[mid, gid], ...]} ── */
  if (route === "assign-many" && req.method === "POST") {
    const code = code4(body.code);
    if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
    const members = await readMembers(st, code), groups = await readGroups(st, code);
    const ok = new Set(groups.map((g) => g.id));
    const pairs: any[] = Array.isArray(body.pairs) ? body.pairs.slice(0, MAX_MEMBERS) : [];
    await Promise.all(pairs.map(([mid, gid]) => {
      const me = members.find((m) => m.mid === clean(mid));
      const g = gid === null ? null : Number(gid);
      return me && (g === null || ok.has(g)) ? setMember(st, code, me.mid, g, me.name) : null;
    }));
    return json({ ok: true });
  }

  /* ── Quitar un alumno (profesor) ── */
  if (route === "kick-member" && req.method === "POST") {
    const code = code4(body.code), mid = clean(body.mid);
    if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
    const { blobs } = await st.list({ prefix: `${code}/m/${mid}/` });
    await Promise.all(blobs.map((b) => st.delete(b.key)));
    return json({ ok: true });
  }

  /* ── Quitar un grupo (profesor): sus alumnos quedan sin grupo ── */
  if (route === "kick" && req.method === "POST") {
    const code = code4(body.code), gid = Number(body.gid);
    if (!(await isHost(st, code, body.key))) return json({ error: "forbidden" }, 403);
    if (!Number.isInteger(gid)) return json({ error: "bad_request" }, 400);
    const a = await st.list({ prefix: `${code}/g/${gid}/` });
    const b = await st.list({ prefix: `${code}/a/${gid}/` });
    await Promise.all([...a.blobs, ...b.blobs].map((x) => st.delete(x.key)));
    const members = await readMembers(st, code);
    await Promise.all(members.filter((m) => m.gid === gid).map((m) => setMember(st, code, m.mid, null, m.name)));
    return json({ ok: true });
  }

  /* ── Responder una ronda (alumno, o el profesor al corregir) ── */
  if (route === "answer" && req.method === "POST") {
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
    const payload = encodeAnswer((state.rounds || [])[i], body.a, cleanName(host ? "Profesor" : body.by, 24), now);
    if (!payload) return json({ error: "bad_answer" }, 400);
    await writeAnswer(st, code, gid, i, payload);
    return json({ ok: true, serverNow: now });
  }

  /* ── Respuestas del propio grupo (alumno) ── */
  if (route === "mine" && req.method === "GET") {
    const code = code4(url.searchParams.get("code")), gid = Number(url.searchParams.get("gid"));
    if (!code || !Number.isInteger(gid)) return json({ error: "bad_request" }, 400);
    const all = await readAnswers(st, code, gid);
    return json({ answers: all[String(gid)] || {}, serverNow: now });
  }

  /* ── Sondeo del profesor: grupos, alumnos y todas las respuestas ── */
  if (route === "poll" && req.method === "GET") {
    const code = code4(url.searchParams.get("code"));
    if (!(await isHost(st, code, url.searchParams.get("key")))) return json({ error: "forbidden" }, 403);
    const [groups, members, answers] = await Promise.all([readGroups(st, code), readMembers(st, code), readAnswers(st, code)]);
    return json({ groups, members, answers, serverNow: now });
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
