// server.js — Vibe Room WebSocket relay server
// Deploy on Railway / Render / Fly.io / any Node host
// Node 18+

const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;

// HTTP server (health check + upgrade)
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      clients: [...rooms.values()].reduce((a, r) => a + r.clients.size, 0),
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

// rooms: Map<roomId, { clients: Map<clientId, { ws, info, lastPos }> }>
const rooms = new Map();

function getRoom(roomId) {
  let r = rooms.get(roomId);
  if (!r) {
    r = { clients: new Map() };
    rooms.set(roomId, r);
  }
  return r;
}

function broadcast(roomId, fromId, msg) {
  const r = rooms.get(roomId);
  if (!r) return;
  const data = JSON.stringify(msg);
  for (const [id, c] of r.clients) {
    if (id === fromId) continue;
    if (c.ws.readyState === 1) c.ws.send(data);
  }
}

function sendTo(roomId, targetId, msg) {
  const r = rooms.get(roomId);
  if (!r) return;
  const c = r.clients.get(targetId);
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const clientId = randomUUID();
  let roomId = null;
  let info = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'join') {
      // Leave previous room if any
      if (roomId) leaveRoom();
      roomId = String(msg.room || 'vibe-room').slice(0, 40);
      info = {
        name: String(msg.name || 'Player').slice(0, 20),
        preset: String(msg.preset || 'custom').slice(0, 20),
      };
      const r = getRoom(roomId);
      r.clients.set(clientId, { ws, info, lastPos: null });

      // Send welcome with own id + list of existing players
      const others = [];
      for (const [id, c] of r.clients) {
        if (id === clientId) continue;
        others.push({
          id,
          name: c.info.name,
          preset: c.info.preset,
          pos: c.lastPos || null,
        });
      }
      ws.send(JSON.stringify({ type: 'welcome', id: clientId, room: roomId, players: others }));

      // Tell everyone else about new player
      broadcast(roomId, clientId, {
        type: 'peer-join',
        id: clientId,
        name: info.name,
        preset: info.preset,
      });
      console.log(`[${roomId}] + ${info.name} (${clientId.slice(0,8)}) — ${r.clients.size} in room`);
      return;
    }

    if (!roomId) return; // must join first

    switch (msg.type) {
      case 'pos': {
        const r = rooms.get(roomId);
        if (!r) return;
        const c = r.clients.get(clientId);
        if (c) c.lastPos = msg.data;
        broadcast(roomId, clientId, { type: 'pos', id: clientId, data: msg.data });
        break;
      }
      case 'chat':
        broadcast(roomId, clientId, { type: 'chat', id: clientId, data: msg.data });
        break;
      case 'draw':
        broadcast(roomId, clientId, { type: 'draw', id: clientId, data: msg.data });
        break;
      case 'clear':
        broadcast(roomId, clientId, { type: 'clear', id: clientId });
        break;
      case 'emote':
        broadcast(roomId, clientId, { type: 'emote', id: clientId, data: msg.data });
        break;
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice':
        // WebRTC signaling relay — to specific peer
        if (msg.to) {
          sendTo(roomId, msg.to, {
            type: msg.type,
            from: clientId,
            data: msg.data,
          });
        }
        break;
      case 'rtc-request-call':
        // Peer wants to initiate audio call with another peer
        if (msg.to) {
          sendTo(roomId, msg.to, {
            type: 'rtc-request-call',
            from: clientId,
          });
        }
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  function leaveRoom() {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    r.clients.delete(clientId);
    broadcast(roomId, clientId, {
      type: 'peer-leave',
      id: clientId,
      name: info ? info.name : 'Someone',
    });
    console.log(`[${roomId}] - ${info ? info.name : '?'} (${clientId.slice(0,8)}) — ${r.clients.size} left`);
    if (r.clients.size === 0) rooms.delete(roomId);
    roomId = null;
  }

  ws.on('close', leaveRoom);
  ws.on('error', leaveRoom);
});

// Keepalive: ping every 30s, drop dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) {
      try { ws.ping(); } catch {}
    }
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Vibe Room server listening on :${PORT}`);
});
