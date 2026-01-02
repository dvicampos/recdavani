const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * rooms: Map<roomId, Map<clientId, { ws, name, isAlive }>>
 */
const rooms = new Map();

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function broadcast(room, data, exceptId = null) {
  for (const [cid, info] of room.entries()) {
    if (exceptId && cid === exceptId) continue;
    safeSend(info.ws, data);
  }
}

// ===== WS heartbeat (mata conexiones muertas) =====
const HEARTBEAT_MS = 30000;
const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);

wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._clientId = null;
  ws._name = null;

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // client heartbeat (opcional)
    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", t: Date.now() });
      return;
    }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "lobby");
      const clientId = String(msg.clientId || "");
      const name = String(msg.name || "").trim().slice(0, 24) || clientId.slice(0, 8);
      if (!clientId) return;

      ws._roomId = roomId;
      ws._clientId = clientId;
      ws._name = name;

      const room = getRoom(roomId);

      // peers existentes antes de meter al nuevo (ahora incluye name)
      const peers = Array.from(room.entries()).map(([id, info]) => ({ id, name: info.name }));

      room.set(clientId, { ws, name, isAlive: true });

      // al nuevo: lista de peers
      safeSend(ws, { type: "peers", peers });

      // a los demás: entró alguien
      broadcast(room, { type: "peer-joined", clientId, name }, clientId);
      return;
    }

    // A partir de aquí, requiere estar en room
    const roomId = ws._roomId;
    const fromId = ws._clientId;
    if (!roomId || !fromId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // rename
    if (msg.type === "rename") {
      const name = String(msg.name || "").trim().slice(0, 24);
      if (!name) return;
      const info = room.get(fromId);
      if (!info) return;
      info.name = name;
      ws._name = name;
      broadcast(room, { type: "peer-meta", clientId: fromId, name });
      return;
    }

    // chat (broadcast)
    if (msg.type === "chat") {
      const text = String(msg.text || "").trim().slice(0, 240);
      if (!text) return;
      const info = room.get(fromId);
      const name = info?.name || ws._name || fromId.slice(0, 8);
      broadcast(room, { type: "chat", from: fromId, name, text, ts: Date.now() });
      return;
    }

    // reactions (broadcast)
    if (msg.type === "reaction") {
      const emoji = String(msg.emoji || "✨").slice(0, 6);
      broadcast(room, { type: "reaction", from: fromId, emoji, ts: Date.now() });
      return;
    }

    // señalización (forward 1:1)
    if (msg.type === "signal") {
      const toId = msg.to;
      if (!toId) return;

      const target = room.get(toId);
      if (!target) return;

      safeSend(target.ws, { type: "signal", from: fromId, data: msg.data });
      return;
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

server.on("close", () => clearInterval(hb));

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
