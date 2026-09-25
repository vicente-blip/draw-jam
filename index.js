import { DurableObject } from "cloudflare:workers";

const BOARD = 900;                // pizarra cuadrada 900x900
const MAX_STROKES = 2500;         // trazos que recordamos por sala
const CHECK_SECONDS = 15;         // cada cuanto se revisa la pizarra
const AI_GATEWAY_ID = "draw-jam"; // tu AI Gateway ("" para desactivarlo)

/* ==================================================================
   0) TODAS LAS LLAMADAS DE IA PASAN POR AI GATEWAY
   No hace falta token: el binding AI del Worker ya esta autenticado.
================================================================== */
async function aiRun(env, model, inputs) {
  const opts = AI_GATEWAY_ID ? { gateway: { id: AI_GATEWAY_ID } } : undefined;
  return env.AI.run(model, inputs, opts);
}

/* ==================================================================
   1) ROUTER
================================================================== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const room = cleanRoom(url.searchParams.get("room"));

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Se esperaba una conexion WebSocket", { status: 426 });
      }
      const stub = env.DRAW_ROOM.get(env.DRAW_ROOM.idFromName(room));
      return stub.fetch(request);
    }

    if (url.pathname === "/guess" && request.method === "POST") {
      return guessDrawing(request, env, ctx, room);
    }

    if (url.pathname === "/moderate" && request.method === "POST") {
      return moderateBoard(request, env, room);
    }

    if (url.pathname === "/stats") {
      return Response.json({ total: await countSaved(env, room) });
    }

    if (url.pathname === "/p") return htmlResponse(pagePhone(room));
    if (url.pathname === "/galeria") return galleryPage(env, room);
    if (url.pathname.startsWith("/img/")) return serveImage(env, decodeURIComponent(url.pathname.slice(5)));
    if (url.pathname === "/health") return Response.json({ ok: true, room, gateway: AI_GATEWAY_ID });
    if (url.pathname === "/") return htmlResponse(pageStage(room, url.origin + "/p?room=" + room));

    return new Response("No encontrado", { status: 404 });
  }
};

/* ==================================================================
   2) LA SALA EN TIEMPO REAL (Durable Object)
================================================================== */
export class DrawRoom extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const map = await this.ctx.storage.list({ prefix: "s:", limit: MAX_STROKES });
    server.send(JSON.stringify({ type: "init", strokes: [...map.values()] }));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 20000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "stroke" && msg.stroke) {
      const n = ((await this.ctx.storage.get("count")) || 0) + 1;
      const key = "s:" + String(n).padStart(7, "0");
      await this.ctx.storage.put({ [key]: msg.stroke, count: n });
      if (n > MAX_STROKES) {
        await this.ctx.storage.delete("s:" + String(n - MAX_STROKES).padStart(7, "0"));
      }
      this.broadcast({ type: "stroke", stroke: msg.stroke }, ws);
      return;
    }

    if (msg.type === "clear") {
      await this.ctx.storage.deleteAll();
      this.broadcast({ type: "clear" });
    }
  }

  async webSocketClose() { this.broadcastPresence(-1); }
  async webSocketError() { this.broadcastPresence(-1); }

  announce(text) {
    this.broadcast({ type: "guess", text: String(text || "") });
    return true;
  }

  async wipe(text) {
    await this.ctx.storage.deleteAll();
    this.broadcast({ type: "blocked", text: String(text || "Pizarra borrada.") });
    return true;
  }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch {}
    }
  }

  broadcastPresence(delta = 0) {
    const count = Math.max(0, this.ctx.getWebSockets().length + delta);
    this.broadcast({ type: "presence", count });
  }
}

/* ==================================================================
   3) MODERACION
   El modelo de vision DESCRIBE el dibujo con una pregunta neutra.
   Ese texto pasa por AI Gateway -> Guardrails lo bloquea si procede.
   Llama Guard 3 actua de segunda opinion. Si algo falla, se deja pasar.
================================================================== */
const DESCRIBE_QUESTION =
  "Describe in one short sentence what this hand-drawn doodle shows.";

function isGuardrailError(m) {
  return /guardrail|blocked|unsafe|violat|content policy/i.test(String(m || ""));
}

async function checkTextSafety(env, text) {
  try {
    const r = await aiRun(env, "@cf/meta/llama-guard-3-8b", {
      messages: [{ role: "user", content: String(text) }]
    });
    const out = String(r?.response || "").toLowerCase();
    return { flagged: out.includes("unsafe"), by: "llama-guard" };
  } catch (e) {
    if (isGuardrailError(e.message)) return { flagged: true, by: "ai-gateway-guardrails" };
    return { flagged: false, error: e.message };
  }
}

async function checkImageSafety(env, dataUrl) {
  let description = "";
  try {
    const r = await aiRun(env, "@cf/moondream/moondream3.1-9B-A2B", {
      task: "query",
      image: dataUrl,
      question: DESCRIBE_QUESTION,
      reasoning: false,
      max_tokens: 60
    });
    description = String(r?.answer || r?.caption || "").trim();
  } catch (e) {
    if (isGuardrailError(e.message)) {
      return { flagged: true, by: "ai-gateway-guardrails", description: "" };
    }
    return { flagged: false, error: e.message };
  }

  if (!description) return { flagged: false };

  const t = await checkTextSafety(env, description);
  return { flagged: t.flagged, by: t.by, description };
}

const BLOCKED_MSG = "Contenido no apropiado detectado. La pizarra se ha borrado automaticamente.";

async function wipeRoom(env, room, text) {
  try {
    const stub = env.DRAW_ROOM.get(env.DRAW_ROOM.idFromName(room));
    await stub.wipe(text);
  } catch {}
}

async function moderateBoard(request, env, room) {
  try {
    const body = await request.json();
    const dataUrl = String(body.image || "");
    if (dataUrl.length < 200) return Response.json({ flagged: false });

    const safety = await checkImageSafety(env, dataUrl);
    if (safety.flagged) await wipeRoom(env, room, BLOCKED_MSG);

    return Response.json({ flagged: safety.flagged, by: safety.by || null });
  } catch (e) {
    return Response.json({ flagged: false, error: e.message });
  }
}

/* ==================================================================
   4) LA IA QUE ADIVINA (Workers AI via AI Gateway)
================================================================== */
async function guessDrawing(request, env, ctx, room) {
  let debug = [];
  try {
    const body = await request.json();
    const dataUrl = String(body.image || "");
    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes || bytes.length < 200) {
      return Response.json({ guess: "Todavia no veo nada dibujado." });
    }

    // Moderacion antes de nada
    const safety = await checkImageSafety(env, dataUrl);
    if (safety.flagged) {
      await wipeRoom(env, room, BLOCKED_MSG);
      return Response.json({ guess: BLOCKED_MSG, blocked: true, by: safety.by });
    }

    const question =
      "This is a simple doodle drawn by hand with a finger: black lines on a white background. " +
      "What single object or scene does it represent? Answer with two or three words only, " +
      "for example: a house, a person, a cat, a dog, a car, a tree, the sun, a flower, " +
      "a boat, a star, a fish, a bicycle, a heart, a cloud.";

    let description = "";
    let guardBlocked = false;

    // Moondream 3
    try {
      const r = await aiRun(env, "@cf/moondream/moondream3.1-9B-A2B", {
        task: "query",
        image: dataUrl,
        question: question,
        reasoning: false,
        max_tokens: 100
      });
      description = String(r?.answer || r?.caption || "").trim();
      if (description) debug.push("moondream ok");
    } catch (e) {
      debug.push("moondream: " + e.message);
      if (isGuardrailError(e.message)) guardBlocked = true;
    }

    // Red de seguridad: Llama 4 Scout
    if (!description && !guardBlocked) {
      try {
        const r = await aiRun(env, "@cf/meta/llama-4-scout-17b-16e-instruct", {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }],
          max_tokens: 80
        });
        description = String(r?.response || "").trim();
        if (description) debug.push("scout ok");
      } catch (e) {
        debug.push("scout: " + e.message);
        if (isGuardrailError(e.message)) guardBlocked = true;
      }
    }

    if (guardBlocked) {
      await wipeRoom(env, room, BLOCKED_MSG);
      return Response.json({ guess: BLOCKED_MSG, blocked: true, by: "ai-gateway-guardrails" });
    }

    let verdict = description
      ? description
      : "La IA no ha podido analizar el dibujo (" + debug.join(" / ") + ")";

    if (description) {
      try {
        const es = await aiRun(env, "@cf/meta/llama-3.1-8b-instruct-fp8", {
          messages: [
            {
              role: "system",
              content:
                "Eres el presentador de una demo en directo. Recibes en ingles lo que un modelo " +
                "de vision ha visto en un dibujo hecho a mano, y respondes SOLO en espanol con " +
                "una frase corta y simpatica que empiece por 'Creo que es'. Maximo 12 palabras. " +
                "No inventes detalles que no esten en la descripcion."
            },
            { role: "user", content: description }
          ],
          max_tokens: 60
        });
        if (es?.response) verdict = es.response.trim();
      } catch (e) { debug.push("texto: " + e.message); }
    }

    try {
      const stub = env.DRAW_ROOM.get(env.DRAW_ROOM.idFromName(room));
      await stub.announce(verdict);
    } catch {}

    ctx.waitUntil(saveSnapshot(env, room, bytes, verdict));

    return Response.json({ guess: verdict, raw: description, debug: debug.join(" / ") });
  } catch (err) {
    return Response.json({ guess: "Fallo al analizar: " + err.message + " [" + debug.join(" / ") + "]" });
  }
}

/* ==================================================================
   5) GALERIA EN R2
================================================================== */
async function saveSnapshot(env, room, bytes, verdict) {
  try {
    if (!env.GALLERY) return;
    const key = room + "/" + Date.now() + ".jpg";
    await env.GALLERY.put(key, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { verdict: String(verdict).slice(0, 500), room }
    });
  } catch {}
}

async function countSaved(env, room) {
  try {
    if (!env.GALLERY) return 0;
    const list = await env.GALLERY.list({ prefix: room + "/", limit: 1000 });
    return list.objects.length;
  } catch { return 0; }
}

async function serveImage(env, key) {
  if (!env.GALLERY) return new Response("Galeria no configurada", { status: 404 });
  const obj = await env.GALLERY.get(key);
  if (!obj) return new Response("No encontrada", { status: 404 });
  return new Response(obj.body, {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" }
  });
}

async function galleryPage(env, room) {
  const list = env.GALLERY ? await env.GALLERY.list({ prefix: room + "/", limit: 40 }) : { objects: [] };
  const items = list.objects.slice().reverse();
  const cards = items.map(function (o) {
    const verdict = (o.customMetadata && o.customMetadata.verdict) || "";
    return `<figure class="shot">
      <img src="/img/${encodeURIComponent(o.key)}" alt="dibujo" />
      <figcaption>${escapeHtml(verdict)}</figcaption>
    </figure>`;
  }).join("");

  return htmlResponse(shell("Galeria - Draw Jam",
    `<p class="kicker">Galeria - guardada en Cloudflare R2</p>
     <h1>Lo que habeis dibujado</h1>
     <p class="muted">${items.length} dibujos analizados en la sala <strong>${room}</strong>.</p>
     <div class="gallery">${cards || '<p class="muted">Todavia no hay nada. Dibuja y pulsa el boton de la IA.</p>'}</div>
     <p style="margin-top:20px;"><a href="/?room=${room}" style="color:var(--accent)">&larr; Volver a la pizarra</a></p>`,
    room, "none"));
}

/* ==================================================================
   6) GENERADOR DE QR PROPIO (sin librerias externas)
================================================================== */
const QR_EXP = new Uint8Array(512), QR_LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { QR_EXP[i] = x; QR_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
})();
const qrMul = (a, b) => (a === 0 || b === 0) ? 0 : QR_EXP[QR_LOG[a] + QR_LOG[b]];

const QR_SPEC = { 1: [21, 19, 7, 0], 2: [25, 34, 10, 18], 3: [29, 55, 15, 22], 4: [33, 80, 20, 26], 5: [37, 108, 26, 30] };
const QR_MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
  (r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0,
  (r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0
];

function qrEcc(data, n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= qrMul(g[j], QR_EXP[i]); }
    g = next;
  }
  const res = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef) for (let j = 0; j < g.length; j++) res[i + j] ^= qrMul(g[j], coef);
  }
  return res.slice(data.length);
}

function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 0;
  for (let v = 1; v <= 5; v++) if (bytes.length + 2 <= QR_SPEC[v][1]) { ver = v; break; }
  if (!ver) return null;
  const [size, ndata, nec, ac] = QR_SPEC[ver];

  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < ndata * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
  let pi = 0; while (cw.length < ndata) cw.push([0xEC, 0x11][pi++ % 2]);
  const all = cw.concat(qrEcc(cw, nec));

  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (r, c, v) => { if (r < 0 || c < 0 || r >= size || c >= size) return; m[r][c] = v; fn[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const core = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      setF(r0 + r, c0 + c, (ring || core) ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { const v = i % 2 === 0 ? 1 : 0; setF(6, i, v); setF(i, 6, v); }
  if (ac) for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) setF(ac + r, ac + c, Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0);
  setF(size - 8, 8, 1);
  for (let i = 0; i <= 8; i++) { if (!fn[8][i]) setF(8, i, 0); if (!fn[i][8]) setF(i, 8, 0); }
  for (let i = 0; i < 8; i++) { if (!fn[8][size - 1 - i]) setF(8, size - 1 - i, 0); if (!fn[size - 1 - i][8]) setF(size - 1 - i, 8, 0); }

  let idx = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (fn[row][c]) continue;
        let dark = 0;
        if (idx < all.length * 8) { dark = (all[idx >> 3] >> (7 - (idx & 7))) & 1; idx++; }
        m[row][c] = dark;
      }
    }
    up = !up;
  }

  const fmtBits = (mask) => {
    const d = (1 << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    return ((d << 10) | rem) ^ 0x5412;
  };
  const applyFormat = (mm, mask) => {
    const b = fmtBits(mask), g = i => (b >> i) & 1;
    for (let i = 0; i <= 5; i++) mm[i][8] = g(i);
    mm[7][8] = g(6); mm[8][8] = g(7); mm[8][7] = g(8);
    for (let i = 9; i < 15; i++) mm[8][14 - i] = g(i);
    for (let i = 0; i < 8; i++) mm[8][size - 1 - i] = g(i);
    for (let i = 8; i < 15; i++) mm[size - 15 + i][8] = g(i);
    mm[size - 8][8] = 1;
  };
  const penalty = (mm) => {
    let p = 0;
    const line = arr => {
      let run = 1, s = 0;
      for (let i = 1; i < arr.length; i++) { if (arr[i] === arr[i - 1]) run++; else { if (run >= 5) s += 3 + (run - 5); run = 1; } }
      if (run >= 5) s += 3 + (run - 5);
      return s;
    };
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], rpat = pat.slice().reverse();
    const has = (arr, i, p2) => p2.every((v, j) => arr[i + j] === v);
    for (let r = 0; r < size; r++) {
      const row = mm[r], col = mm.map(x => x[r]);
      p += line(row) + line(col);
      for (let i = 0; i + 11 <= size; i++) {
        if (has(row, i, pat) || has(row, i, rpat)) p += 40;
        if (has(col, i, pat) || has(col, i, rpat)) p += 40;
      }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = mm[r][c];
      if (v === mm[r][c + 1] && v === mm[r + 1][c] && v === mm[r + 1][c + 1]) p += 3;
    }
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mm[r][c];
    p += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return p;
  };

  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const mm = m.map(r => r.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && QR_MASKS[mask](r, c)) mm[r][c] ^= 1;
    applyFormat(mm, mask);
    const p = penalty(mm);
    if (p < bestP) { bestP = p; best = mm; }
  }
  return { size, matrix: best };
}

function qrSvg(text, px) {
  const q = qrMatrix(text);
  if (!q) return '<div style="padding:16px;color:#0f172a;font:14px sans-serif">Usa la URL de abajo</div>';
  const quiet = 4, dim = q.size + quiet * 2;
  let rects = "";
  for (let r = 0; r < q.size; r++) {
    let c = 0;
    while (c < q.size) {
      if (q.matrix[r][c]) {
        let len = 1;
        while (c + len < q.size && q.matrix[r][c + len]) len++;
        rects += `<rect x="${c + quiet}" y="${r + quiet}" width="${len}" height="1"/>`;
        c += len;
      } else c++;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" shape-rendering="crispEdges" style="display:block"><rect width="${dim}" height="${dim}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`;
}

/* ==================================================================
   7) UTILIDADES
================================================================== */
function cleanRoom(value) {
  const r = String(value || "demo").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  return r || "demo";
}

function htmlResponse(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function dataUrlToBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(",");
  if (comma === -1) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ==================================================================
   8) PAGINAS
================================================================== */
function shell(title, body, room, mode) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; --bg:#0f172a; --border:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#7dd3fc; --accent2:#38bdf8; --danger:#ef4444; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: Inter, system-ui, -apple-system, sans-serif; background: radial-gradient(circle at top, #1e293b 0%, var(--bg) 45%); color: var(--text); }
  main { max-width: 1160px; margin: 0 auto; padding: 18px 18px 40px; }
  h1 { margin:0 0 6px; font-size: clamp(1.6rem, 3.4vw, 2.6rem); letter-spacing:-0.03em; }
  .kicker { margin:0 0 8px; text-transform:uppercase; letter-spacing:.14em; color:var(--accent); font-size:.72rem; font-weight:700; }
  .muted { color: var(--muted); }
  .card { border:1px solid var(--border); border-radius:18px; background: rgba(15,23,42,.78); padding:18px; }
  .row { display:grid; grid-template-columns: 320px 1fr; gap:18px; align-items:start; }
  .board-wrap { background:#fff; border-radius:16px; overflow:hidden; border:1px solid var(--border); max-width: min(58vh, 620px); }
  canvas#board { display:block; width:100%; aspect-ratio:1/1; touch-action:none; cursor:crosshair; }
  .button { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:13px 18px; border:0; border-radius:12px; font-weight:700; font-size:1rem; cursor:pointer; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#082f49; }
  .button.ghost { background:#0b1220; color:var(--text); border:1px solid var(--border); }
  .button:disabled { opacity:.6; cursor:wait; }
  .bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:12px; }
  .verdict { margin-top:12px; padding:14px 16px; border-radius:14px; border:1px solid var(--border); background:#0b1220; min-height:54px; font-size:1.15rem; line-height:1.5; transition: border-color .2s, color .2s; }
  .verdict.blocked { border-color: var(--danger); color: #fecaca; }
  .swatches { display:flex; gap:12px; flex-wrap:wrap; margin-top:12px; }
  .sw { width:44px; height:44px; border-radius:50%; border:3px solid #0b1220; cursor:pointer; }
  .sw[aria-pressed="true"] { border-color: var(--accent); transform: scale(1.12); }
  .qr { background:#fff; padding:10px; border-radius:16px; width:fit-content; line-height:0; }
  .url { font-family: ui-monospace, monospace; font-size:.8rem; word-break:break-all; color:var(--accent); }
  .pill { display:inline-flex; padding:7px 12px; border-radius:999px; font-size:.82rem; background:#0b1220; border:1px solid var(--border); color:var(--muted); margin-right:8px; }
  .gallery { display:grid; grid-template-columns: repeat(auto-fill, minmax(190px,1fr)); gap:14px; margin-top:18px; }
  .shot { margin:0; background:#0b1220; border:1px solid var(--border); border-radius:14px; overflow:hidden; }
  .shot img { display:block; width:100%; background:#fff; }
  .shot figcaption { padding:10px 12px; font-size:.85rem; color:var(--muted); }
  @media (max-width: 880px) { .row { grid-template-columns: 1fr; } main { padding:14px 12px 28px; } .board-wrap { max-width:100%; } }
</style>
</head>
<body>
<main>${body}</main>
${mode === "none" ? "" : `<script>${clientScript(room, mode)}</script>`}
</body>
</html>`;
}

function pageStage(room, phoneUrl) {
  return shell(
    "Draw Jam - dibujo colaborativo con IA",
    `<p class="kicker">Workers + Durable Objects + Workers AI + AI Gateway + R2</p>
     <h1>Draw Jam</h1>
     <p class="muted">Escanea el QR con tu movil y dibuja con el dedo. Todo lo que dibujeis aparece aqui al instante. Despues, un modelo open source de IA intenta adivinar que es.</p>

     <div class="row" style="margin-top:16px;">
       <section class="card">
         <h2 style="margin:0 0 12px; font-size:1.05rem;">1 &middot; Escanea para dibujar</h2>
         <div class="qr">${qrSvg(phoneUrl, 260)}</div>
         <p class="url" style="margin-top:10px;">${escapeHtml(phoneUrl)}</p>
         <p style="margin-top:10px;">
           <span class="pill" id="presence">0 conectados</span>
           <span class="pill" id="total">0 analizados</span>
         </p>
         <p class="muted" style="font-size:.85rem;">Sala: <strong>${room}</strong></p>
         <p class="muted" style="font-size:.8rem;">Moderacion automatica cada ${CHECK_SECONDS}s</p>
         <p style="margin-top:6px;"><a href="/galeria?room=${room}" style="color:var(--accent); font-size:.9rem;">Ver galeria &rarr;</a></p>
       </section>

       <section class="card">
         <h2 style="margin:0 0 12px; font-size:1.05rem;">2 &middot; Pizarra compartida</h2>
         <div class="board-wrap"><canvas id="board"></canvas></div>
         <div class="swatches" id="swatches"></div>
         <div class="bar">
           <button class="button" id="guess">Que hemos dibujado?</button>
           <button class="button ghost" id="clear">Borrar pizarra</button>
           <span class="muted" id="status">Conectando...</span>
         </div>
         <div class="verdict" id="verdict">La IA esta esperando vuestro dibujo...</div>
         <p class="muted" style="font-size:.8rem; margin-top:8px;">
           Vision: <strong>Moondream 3</strong> &middot; Texto: <strong>Llama 3.1 8B</strong> &middot; Moderacion: <strong>AI Gateway Guardrails + Llama Guard 3</strong> &middot; Todo via <strong>AI Gateway</strong>.
         </p>
       </section>
     </div>`,
    room,
    "stage"
  );
}

function pagePhone(room) {
  return shell(
    "Draw Jam - dibuja",
    `<p class="kicker">Dibuja con el dedo</p>
     <h1 style="font-size:1.5rem;">Draw Jam</h1>
     <p class="muted" style="font-size:.95rem;">Lo que dibujes aparece en la pantalla grande y en el movil de los demas, al instante. Hay moderacion automatica de contenido.</p>
     <div class="board-wrap" style="margin-top:12px;"><canvas id="board"></canvas></div>
     <div class="swatches" id="swatches"></div>
     <div class="bar">
       <button class="button ghost" id="clear">Borrar todo</button>
       <span class="muted" id="status">Conectando...</span>
     </div>
     <div class="verdict" id="verdict">Esperando el veredicto de la IA...</div>`,
    room,
    "phone"
  );
}

/* ==================================================================
   9) CODIGO QUE CORRE EN EL NAVEGADOR
================================================================== */
function clientScript(room, mode) {
  return `
const MODE = '${mode}';
const ROOM = '${room}';
const SIZE = ${BOARD};
const CHECK_MS = ${CHECK_SECONDS} * 1000;

const canvas = document.getElementById('board');
canvas.width = SIZE; canvas.height = SIZE;
const cx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const verdictEl = document.getElementById('verdict');

let dirty = false;

function background() { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, SIZE, SIZE); }
background();

function snapshot(px, quality) {
  const small = document.createElement('canvas');
  small.width = px; small.height = px;
  const sctx = small.getContext('2d');
  sctx.fillStyle = '#ffffff'; sctx.fillRect(0, 0, px, px);
  sctx.drawImage(canvas, 0, 0, px, px);
  return small.toDataURL('image/jpeg', quality);
}

function paint(s) {
  const pts = s && s.p;
  if (!pts || !pts.length) return;
  cx.strokeStyle = s.c || '#0f172a';
  cx.lineWidth = (s.w || 5) * (SIZE / 400);
  cx.lineCap = 'round';
  cx.lineJoin = 'round';
  cx.beginPath();
  cx.moveTo(pts[0][0] * SIZE, pts[0][1] * SIZE);
  if (pts.length === 1) cx.lineTo(pts[0][0] * SIZE + 0.1, pts[0][1] * SIZE);
  for (let i = 1; i < pts.length; i++) cx.lineTo(pts[i][0] * SIZE, pts[i][1] * SIZE);
  cx.stroke();
  dirty = true;
}

function setVerdict(text, blocked) {
  verdictEl.textContent = text;
  if (blocked) verdictEl.classList.add('blocked');
  else verdictEl.classList.remove('blocked');
}

let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws?room=' + ROOM);
  ws.onopen = function () { statusEl.textContent = 'En directo'; };
  ws.onclose = function () { statusEl.textContent = 'Reconectando...'; setTimeout(connect, 1500); };
  ws.onmessage = function (event) {
    let msg; try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'init') { background(); (msg.strokes || []).forEach(paint); }
    else if (msg.type === 'stroke') paint(msg.stroke);
    else if (msg.type === 'clear') { background(); dirty = false; setVerdict('Pizarra limpia. A dibujar!', false); }
    else if (msg.type === 'blocked') { background(); dirty = false; setVerdict(msg.text, true); }
    else if (msg.type === 'guess') setVerdict(msg.text, false);
    else if (msg.type === 'presence') {
      const p = document.getElementById('presence');
      if (p) p.textContent = msg.count + (msg.count === 1 ? ' conectado' : ' conectados');
    }
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
connect();

const clearBtn = document.getElementById('clear');
if (clearBtn) clearBtn.addEventListener('click', function () { background(); dirty = false; send({ type: 'clear' }); });

let color = '#0f172a';
const box = document.getElementById('swatches');
if (box) {
  ['#0f172a', '#f6821f', '#0ea5e9', '#22c55e', '#ef4444', '#a855f7'].forEach(function (c, i) {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.background = c;
    b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    b.addEventListener('click', function () {
      color = c;
      Array.prototype.forEach.call(box.children, function (el) { el.setAttribute('aria-pressed', 'false'); });
      b.setAttribute('aria-pressed', 'true');
    });
    box.appendChild(b);
  });
}

let drawing = false, buffer = [], last = null;
function pos(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
}
function flush() {
  if (buffer.length < 2) return;
  send({ type: 'stroke', stroke: { c: color, w: 5, p: buffer } });
  buffer = [buffer[buffer.length - 1]];
}
canvas.addEventListener('pointerdown', function (e) {
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  drawing = true; last = pos(e); buffer = [last];
});
canvas.addEventListener('pointermove', function (e) {
  if (!drawing) return;
  e.preventDefault();
  const p = pos(e);
  paint({ c: color, w: 5, p: [last, p] });
  buffer.push(p); last = p;
  if (buffer.length >= 8) flush();
});
function endStroke() {
  if (!drawing) return;
  if (buffer.length === 1) { paint({ c: color, w: 5, p: [last, last] }); buffer.push(last); }
  flush(); drawing = false;
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('pointerleave', endStroke);

if (MODE === 'stage') {
  function refreshTotal() {
    fetch('/stats?room=' + ROOM).then(function (r) { return r.json(); }).then(function (d) {
      const t = document.getElementById('total');
      if (t) t.textContent = (d.total || 0) + ' analizados';
    }).catch(function () {});
  }
  refreshTotal();

  setInterval(function () {
    if (!dirty || drawing) return;
    dirty = false;
    fetch('/moderate?room=' + ROOM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: snapshot(384, 0.7) })
    }).catch(function () {});
  }, CHECK_MS);

  const guessBtn = document.getElementById('guess');
  guessBtn.addEventListener('click', async function () {
    guessBtn.disabled = true;
    setVerdict('La IA esta mirando el dibujo...', false);
    try {
      const res = await fetch('/guess?room=' + ROOM, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: snapshot(512, 0.8) })
      });
      const data = await res.json();
      setVerdict(data.guess || 'Sin respuesta.', !!data.blocked);
      setTimeout(refreshTotal, 1200);
    } catch (err) {
      setVerdict('Error: ' + err.message, false);
    } finally {
      guessBtn.disabled = false;
    }
  });
}
