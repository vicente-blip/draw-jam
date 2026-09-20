import { DurableObject } from "cloudflare:workers";

const BOARD = 900;        // pizarra cuadrada 900x900
const MAX_STROKES = 2500; // trazos que recordamos por sala

/* ==================================================================
   1) ROUTER — qué devolvemos en cada URL
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

    if (url.pathname === "/stats") {
      return Response.json({ total: await countSaved(env, room) });
    }

    if (url.pathname === "/p") return htmlResponse(pagePhone(room));
    if (url.pathname === "/galeria") return galleryPage(env, room);
    if (url.pathname.startsWith("/img/")) return serveImage(env, decodeURIComponent(url.pathname.slice(5)));
    if (url.pathname === "/health") return Response.json({ ok: true, room });
    if (url.pathname === "/") return htmlResponse(pageStage(room));

    return new Response("No encontrado", { status: 404 });
  }
};

/* ==================================================================
   2) LA SALA EN TIEMPO REAL (Durable Object)
   Recibe los trazos de cada movil y los reenvia a todos los demas.
================================================================== */
export class DrawRoom extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server); // WebSockets con hibernacion

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
   3) LA IA — modelos open source de Cloudflare (Workers AI)
================================================================== */
async function guessDrawing(request, env, ctx, room) {
  try {
    const body = await request.json();
    const bytes = dataUrlToBytes(body.image || "");
    if (!bytes || bytes.length < 200) {
      return Response.json({ guess: "Todavia no veo nada dibujado." });
    }

    // Modelo de vision: LLaVA 1.5 7B
    const vision = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: [...bytes],
      prompt:
        "This image is a simple hand-drawn doodle on a white background. " +
        "In one short sentence, say what object or scene it represents " +
        "(for example: a house, a person, a car, a cat, a tree, the sun).",
      max_tokens: 60
    });

    const description = String(vision?.description || vision?.response || "").trim();
    let verdict = description || "No lo tengo claro, dibujad un poco mas!";

    // Modelo de texto: lo pasa a espanol, corto y divertido
    try {
      const es = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
        messages: [
          {
            role: "system",
            content:
              "Eres el presentador de una demo en directo. Recibes en ingles la descripcion " +
              "de un dibujo hecho a mano y respondes SOLO en espanol, con una frase corta y " +
              "simpatica que empiece por 'Creo que es'. Maximo 15 palabras."
          },
          { role: "user", content: description || "an unclear scribble" }
        ],
        max_tokens: 60
      });
      if (es?.response) verdict = es.response.trim();
    } catch {}

    // Avisa a todos los moviles conectados
    try {
      const stub = env.DRAW_ROOM.get(env.DRAW_ROOM.idFromName(room));
      await stub.announce(verdict);
    } catch {}

    // Guarda el dibujo en R2 para la galeria
    ctx.waitUntil(saveSnapshot(env, room, bytes, verdict));

    return Response.json({
      guess: verdict,
      raw: description,
      models: ["@cf/llava-hf/llava-1.5-7b-hf", "@cf/meta/llama-3.1-8b-instruct-fp8"]
    });
  } catch (err) {
    return Response.json({ guess: "La IA no ha podido mirar el dibujo: " + err.message });
  }
}

/* ==================================================================
   4) GALERIA EN R2
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
   5) UTILIDADES
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
   6) LAS PAGINAS
================================================================== */
function shell(title, body, room, mode, extraHead = "") {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>${title}</title>
${extraHead}
<style>
  :root { color-scheme: dark; --bg:#0f172a; --border:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#7dd3fc; --accent2:#38bdf8; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: Inter, system-ui, -apple-system, sans-serif; background: radial-gradient(circle at top, #1e293b 0%, var(--bg) 45%); color: var(--text); }
  main { max-width: 1160px; margin: 0 auto; padding: 22px 18px 48px; }
  h1 { margin:0 0 8px; font-size: clamp(1.7rem, 4vw, 3rem); letter-spacing:-0.03em; }
  .kicker { margin:0 0 10px; text-transform:uppercase; letter-spacing:.14em; color:var(--accent); font-size:.74rem; font-weight:700; }
  .muted { color: var(--muted); }
  .card { border:1px solid var(--border); border-radius:18px; background: rgba(15,23,42,.78); padding:18px; }
  .row { display:grid; grid-template-columns: 320px 1fr; gap:18px; align-items:start; }
  .board-wrap { background:#fff; border-radius:16px; overflow:hidden; border:1px solid var(--border); }
  canvas#board { display:block; width:100%; aspect-ratio:1/1; touch-action:none; cursor:crosshair; }
  .button { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:13px 18px; border:0; border-radius:12px; font-weight:700; font-size:1rem; cursor:pointer; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#082f49; }
  .button.ghost { background:#0b1220; color:var(--text); border:1px solid var(--border); }
  .button:disabled { opacity:.6; cursor:wait; }
  .bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:14px; }
  .verdict { margin-top:14px; padding:16px; border-radius:14px; border:1px solid var(--border); background:#0b1220; min-height:58px; font-size:1.2rem; line-height:1.5; }
  .swatches { display:flex; gap:12px; flex-wrap:wrap; margin-top:14px; }
  .sw { width:44px; height:44px; border-radius:50%; border:3px solid #0b1220; cursor:pointer; }
  .sw[aria-pressed="true"] { border-color: var(--accent); transform: scale(1.12); }
  .qr { background:#fff; padding:14px; border-radius:16px; width:fit-content; }
  .url { font-family: ui-monospace, monospace; font-size:.85rem; word-break:break-all; color:var(--accent); }
  .pill { display:inline-flex; padding:7px 12px; border-radius:999px; font-size:.82rem; background:#0b1220; border:1px solid var(--border); color:var(--muted); margin-right:8px; }
  .gallery { display:grid; grid-template-columns: repeat(auto-fill, minmax(190px,1fr)); gap:14px; margin-top:18px; }
  .shot { margin:0; background:#0b1220; border:1px solid var(--border); border-radius:14px; overflow:hidden; }
  .shot img { display:block; width:100%; background:#fff; }
  .shot figcaption { padding:10px 12px; font-size:.85rem; color:var(--muted); }
  @media (max-width: 880px) { .row { grid-template-columns: 1fr; } main { padding:14px 12px 28px; } }
</style>
</head>
<body>
<main>${body}</main>
${mode === "none" ? "" : `<script>${clientScript(room, mode)}</script>`}
</body>
</html>`;
}

function pageStage(room) {
  return shell(
    "Draw Jam - dibujo colaborativo con IA",
    `<p class="kicker">Demo en directo - Workers + Durable Objects + Workers AI + R2</p>
     <h1>Draw Jam</h1>
     <p class="muted">Escanea el QR con tu movil y dibuja con el dedo. Todo lo que dibujeis aparece aqui al instante. Despues, un modelo open source de IA intenta adivinar que es.</p>

     <div class="row" style="margin-top:18px;">
       <section class="card">
         <h2 style="margin:0 0 12px; font-size:1.05rem;">1 &middot; Escanea para dibujar</h2>
         <div class="qr"><canvas id="qr"></canvas></div>
         <p class="url" id="phone-url" style="margin-top:12px;"></p>
         <p style="margin-top:12px;">
           <span class="pill" id="presence">0 conectados</span>
           <span class="pill" id="total">0 analizados</span>
         </p>
         <p class="muted" style="font-size:.85rem;">Sala: <strong>${room}</strong></p>
         <p style="margin-top:8px;"><a href="/galeria?room=${room}" style="color:var(--accent); font-size:.9rem;">Ver galeria &rarr;</a></p>
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
         <p class="muted" style="font-size:.8rem; margin-top:10px;">
           Vision: <strong>LLaVA 1.5 7B</strong> &middot; Texto: <strong>Llama 3.1 8B</strong> &mdash; modelos open source en GPUs de Cloudflare.
         </p>
       </section>
     </div>`,
    room,
    "stage",
    `<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>`
  );
}

function pagePhone(room) {
  return shell(
    "Draw Jam - dibuja",
    `<p class="kicker">Dibuja con el dedo</p>
     <h1 style="font-size:1.55rem;">Draw Jam</h1>
     <p class="muted" style="font-size:.95rem;">Lo que dibujes aparece en la pantalla grande y en el movil de los demas, al instante.</p>
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
   7) CODIGO QUE CORRE EN EL NAVEGADOR
================================================================== */
function clientScript(room, mode) {
  return `
const MODE = '${mode}';
const ROOM = '${room}';
const SIZE = ${BOARD};

const canvas = document.getElementById('board');
canvas.width = SIZE; canvas.height = SIZE;
const cx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const verdictEl = document.getElementById('verdict');

function background() { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, SIZE, SIZE); }
background();

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
    else if (msg.type === 'clear') { background(); verdictEl.textContent = 'Pizarra limpia. A dibujar!'; }
    else if (msg.type === 'guess') verdictEl.textContent = msg.text;
    else if (msg.type === 'presence') {
      const p = document.getElementById('presence');
      if (p) p.textContent = msg.count + (msg.count === 1 ? ' conectado' : ' conectados');
    }
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
connect();

const clearBtn = document.getElementById('clear');
if (clearBtn) clearBtn.addEventListener('click', function () { background(); send({ type: 'clear' }); });

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
  const phoneUrl = location.origin + '/p?room=' + ROOM;
  const urlEl = document.getElementById('phone-url');
  if (urlEl) urlEl.textContent = phoneUrl;
  if (window.QRCode) {
    window.QRCode.toCanvas(document.getElementById('qr'), phoneUrl, { width: 260, margin: 1 }, function () {});
  }

  fetch('/stats?room=' + ROOM).then(function (r) { return r.json(); }).then(function (d) {
    const t = document.getElementById('total');
    if (t) t.textContent = (d.total || 0) + ' analizados';
  }).catch(function () {});

  const guessBtn = document.getElementById('guess');
  guessBtn.addEventListener('click', async function () {
    guessBtn.disabled = true;
    verdictEl.textContent = 'La IA esta mirando el dibujo...';
    try {
      const image = canvas.toDataURL('image/jpeg', 0.85);
      const res = await fetch('/guess?room=' + ROOM, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: image })
      });
      const data = await res.json();
      verdictEl.textContent = data.guess || 'Sin respuesta.';
      fetch('/stats?room=' + ROOM).then(function (r) { return r.json(); }).then(function (d) {
        const t = document.getElementById('total');
        if (t) t.textContent = (d.total || 0) + ' analizados';
      }).catch(function () {});
    } catch (err) {
      verdictEl.textContent = 'Error: ' + err.message;
    } finally {
      guessBtn.disabled = false;
    }
  });
}
`;
}
