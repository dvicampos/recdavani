/* ============================
   server.js (EDITADO) – FULL
   - peers: ahora manda {id,name}
   - rename, chat, reaction
   - ping/pong
   ============================ */

const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

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

function broadcast(room, data, exceptId = null) {
  for (const [pid, info] of room.entries()) {
    if (exceptId && pid === exceptId) continue;
    safeSend(info.ws, data);
  }
}

wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._clientId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ping/pong
    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", t: msg.t || Date.now() });
      return;
    }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "lobby");
      const clientId = String(msg.clientId || "");
      const name = String(msg.name || "").trim().slice(0, 24) || clientId.slice(0, 8);
      if (!clientId) return;

      ws._roomId = roomId;
      ws._clientId = clientId;

      const room = getRoom(roomId);

      // peers existentes antes de meter al nuevo
      const peers = Array.from(room.entries()).map(([id, info]) => ({ id, name: info.name }));

      room.set(clientId, { ws, name });

      // manda peers al nuevo
      safeSend(ws, { type: "peers", peers });

      // avisa a todos
      broadcast(room, { type: "peer-joined", clientId, name }, clientId);
      return;
    }

    // A partir de aquí requiere room + client
    const roomId = ws._roomId;
    const fromId = ws._clientId;
    if (!roomId || !fromId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // rename
    if (msg.type === "rename") {
      const info = room.get(fromId);
      if (!info) return;
      const name = String(msg.name || "").trim().slice(0, 24) || fromId.slice(0, 8);
      info.name = name;
      broadcast(room, { type: "peer-meta", clientId: fromId, name });
      return;
    }

    // chat broadcast
    if (msg.type === "chat") {
      const info = room.get(fromId);
      const text = String(msg.text || "").slice(0, 240);
      broadcast(room, {
        type: "chat",
        from: fromId,
        name: info?.name || fromId.slice(0, 8),
        text,
        ts: Date.now()
      });
      return;
    }

    // reaction broadcast
    if (msg.type === "reaction") {
      const info = room.get(fromId);
      const emoji = String(msg.emoji || "✨").slice(0, 6);
      broadcast(room, {
        type: "reaction",
        from: fromId,
        name: info?.name || fromId.slice(0, 8),
        emoji,
        ts: Date.now()
      });
      return;
    }

    // señalización
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
