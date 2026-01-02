// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * rooms: Map<roomId, Map<clientId, { ws, name }>>
 */
const rooms = new Map();

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function broadcast(room, data, exceptClientId = null) {
  for (const [cid, info] of room.entries()) {
    if (exceptClientId && cid === exceptClientId) continue;
    safeSend(info.ws, data);
  }
}

function listPeers(room, exceptClientId) {
  const peers = [];
  for (const [cid, info] of room.entries()) {
    if (cid === exceptClientId) continue;
    peers.push({ id: cid, name: info.name || cid.slice(0, 8) });
  }
  return peers;
}

/* =========================
   Claude API: Transcript -> resumen
   ========================= */
app.post("/api/ai/summary", async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Falta ANTHROPIC_API_KEY en variables de entorno.",
      });
    }

    const { roomId, transcript, language } = req.body || {};
    const lang = language || "es-MX";

    const transcriptText = String(transcript || "").trim();
    if (transcriptText.length < 20) {
      return res.status(400).json({ error: "Transcript vacío o muy corto." });
    }

    // Modelo: usa el que tengas disponible en tu cuenta.
    // En docs aparece un ejemplo de modelo; tú puedes cambiarlo por env.
    const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";

    // Pedimos JSON estricto para poder parsear sin drama.
    const prompt = `
Eres un asistente que transforma transcripciones en una minuta útil.
Devuelve SOLO JSON válido (sin markdown, sin texto extra).
Idioma: ${lang}

TRANSCRIPCIÓN (puede contener marcas de tiempo):
${transcriptText}

Devuelve este JSON con este esquema:
{
  "title": string,
  "summary": string,
  "highlights": [string],
  "decisions": [string],
  "action_items": [{"who": string, "task": string, "due": string|null}],
  "topics": [{"topic": string, "bullets": [string]}],
  "open_questions": [string],
  "next_steps": [string],
  "keywords": [string]
}

Reglas:
- Sé conciso pero accionable.
- Si no hay "who" claro en acciones, usa "Equipo".
- Si no hay fechas, "due": null.
`.trim();

    // Llamada Claude Messages API:
    // POST /v1/messages con headers anthropic-version y X-Api-Key. :contentReference[oaicite:1]{index=1}
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({
        error: "Claude API error",
        details: data,
      });
    }

    const text =
      (data.content || [])
        .map((c) => (c && c.type === "text" ? c.text : ""))
        .join("")
        .trim() || "";

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Si por alguna razón no regresa JSON perfecto, devolvemos raw.
      parsed = null;
    }

    res.json({
      ok: true,
      roomId: roomId || null,
      raw: text,
      json: parsed,
      model: data.model,
      usage: data.usage || null,
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
});

/* =========================
   WS signaling + broadcast
   ========================= */
wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._clientId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Heartbeat
    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", t: Date.now() });
      return;
    }

    // Join
    if (msg.type === "join") {
      const roomId = String(msg.roomId || "lobby");
      const clientId = String(msg.clientId || "");
      const name = String(msg.name || "").trim().slice(0, 24);

      if (!clientId) return;

      ws._roomId = roomId;
      ws._clientId = clientId;

      const room = getRoom(roomId);

      const peers = listPeers(room, clientId);
      room.set(clientId, { ws, name: name || `Guest-${clientId.slice(0, 4)}` });

      safeSend(ws, { type: "peers", peers });

      broadcast(room, { type: "peer-joined", clientId, name: room.get(clientId).name }, clientId);
      return;
    }

    const roomId = ws._roomId;
    const fromId = ws._clientId;
    if (!roomId || !fromId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Rename
    if (msg.type === "rename") {
      const info = room.get(fromId);
      if (!info) return;
      const newName = String(msg.name || "").trim().slice(0, 24);
      if (!newName) return;

      info.name = newName;
      broadcast(room, { type: "peer-meta", clientId: fromId, name: newName });
      return;
    }

    // Chat / reaction / caption (broadcast)
    if (msg.type === "chat") {
      const info = room.get(fromId);
      const text = String(msg.text || "").trim().slice(0, 400);
      if (!text) return;

      broadcast(room, {
        type: "chat",
        from: fromId,
        name: info?.name || fromId.slice(0, 8),
        text,
        ts: Date.now(),
      });
      return;
    }

    if (msg.type === "reaction") {
      broadcast(room, { type: "reaction", from: fromId, emoji: msg.emoji || "✨" });
      return;
    }

    if (msg.type === "caption") {
      const info = room.get(fromId);
      const text = String(msg.text || "").trim().slice(0, 220);
      if (!text) return;

      broadcast(room, {
        type: "caption",
        from: fromId,
        name: info?.name || fromId.slice(0, 8),
        text,
        ts: Date.now(),
      });
      return;
    }

    // WebRTC signaling
    if (msg.type === "signal") {
      const toId = msg.to;
      if (!toId) return;

      const target = room.get(toId);
      if (!target) return;

      safeSend(target.ws, { type: "signal", from: fromId, data: msg.data });
    }
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    const clientId = ws._clientId;
    if (!roomId || !clientId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(clientId);
    broadcast(room, { type: "peer-left", clientId });

    if (room.size === 0) rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Puerto ${PORT} en uso. Prueba: PowerShell -> $env:PORT=3001; npm start`);
    process.exit(1);
  }
  console.error("❌ Error server:", err);
  process.exit(1);
});

server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
