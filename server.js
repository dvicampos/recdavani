const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * rooms: Map<roomId, Map<clientId, ws>>
 */
const rooms = new Map();

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._clientId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "lobby");
      const clientId = String(msg.clientId || "");
      if (!clientId) return;

      ws._roomId = roomId;
      ws._clientId = clientId;

      const room = getRoom(roomId);

      // peers existentes ANTES de meter al nuevo
      const peers = Array.from(room.keys());

      room.set(clientId, ws);

      safeSend(ws, { type: "peers", peers });

      for (const [pid, pws] of room.entries()) {
        if (pid !== clientId) safeSend(pws, { type: "peer-joined", clientId });
      }
      return;
    }

    // señalización
    const roomId = ws._roomId;
    const fromId = ws._clientId;
    if (!roomId || !fromId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (msg.type === "signal") {
      const toId = msg.to;
      if (!toId) return;
      const target = room.get(toId);
      if (!target) return;

      safeSend(target, { type: "signal", from: fromId, data: msg.data });
    }
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    const clientId = ws._clientId;
    if (!roomId || !clientId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(clientId);

    for (const [, pws] of room.entries()) {
      safeSend(pws, { type: "peer-left", clientId });
    }

    if (room.size === 0) rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`));
