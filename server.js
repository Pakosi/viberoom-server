const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const LAYOUTS_FILE = path.join(__dirname, 'layouts.json');
const ROOM_STATE_FILE = path.join(__dirname, 'room-states.json');

function loadJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read ${file}:`, err);
    return fallback;
  }
}

function saveJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to write ${file}:`, err);
  }
}

const savedLayouts = loadJsonSafe(LAYOUTS_FILE, {});
const savedRoomStates = loadJsonSafe(ROOM_STATE_FILE, {});

// roomId -> {
//   clients: Set<ws>,
//   players: Map<id, player>,
//   state: {
//     vibe: 'chill',
//     media: { videoId, playing, startAt, startedAt }
//   }
// }
const rooms = new Map();

function makeDefaultRoomState() {
  return {
    vibe: 'chill',
    media: {
      videoId: '',
      playing: false,
      startAt: 0,
      startedAt: 0
    }
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      players: new Map(),
      state: savedRoomStates[roomId] || makeDefaultRoomState()
    });
  }
  return rooms.get(roomId);
}

function send(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  for (const client of room.clients) {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(msg);
    }
  }
}

function persistLayout(roomId, layout) {
  savedLayouts[roomId] = layout;
  saveJsonSafe(LAYOUTS_FILE, savedLayouts);
}

function persistRoomState(roomId, state) {
  savedRoomStates[roomId] = state;
  saveJsonSafe(ROOM_STATE_FILE, savedRoomStates);
}

function roomStats() {
  let roomCount = 0;
  let clientCount = 0;
  for (const [, room] of rooms) {
    roomCount += 1;
    clientCount += room.clients.size;
  }
  return { roomCount, clientCount };
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    const stats = roomStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      status: 'online',
      rooms: stats.roomCount,
      clients: stats.clientCount
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.id = randomUUID();
  ws.roomId = null;
  ws.playerName = 'Guest';
  ws.playerPreset = 'custom';
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    // ==================== JOIN ====================
    if (msg.type === 'join') {
      const roomId = String(msg.room || 'vibe-room').trim() || 'vibe-room';
      const name = String(msg.name || 'Guest').slice(0, 24);
      const preset = String(msg.preset || 'custom').slice(0, 24);

      ws.roomId = roomId;
      ws.playerName = name;
      ws.playerPreset = preset;

      const room = getRoom(roomId);
      room.clients.add(ws);

      room.players.set(ws.id, {
        id: ws.id,
        name,
        preset,
        pos: { x: 0, y: 0, z: 12.3, ry: 0, m: false }
      });

      const otherPlayers = [];
      for (const [id, player] of room.players) {
        if (id !== ws.id) otherPlayers.push(player);
      }

      send(ws, {
        type: 'welcome',
        id: ws.id,
        players: otherPlayers
      });

      if (savedLayouts[roomId]) {
        send(ws, {
          type: 'layout_load',
          data: savedLayouts[roomId]
        });
      }

      send(ws, {
        type: 'room_state',
        data: room.state
      });

      broadcast(room, {
        type: 'peer-join',
        id: ws.id,
        name,
        preset
      }, ws);

      return;
    }

    if (!ws.roomId) return;
    const room = getRoom(ws.roomId);

    // ==================== POSITION ====================
    if (msg.type === 'pos' && msg.data) {
      const player = room.players.get(ws.id);
      if (player) {
        player.pos = {
          x: Number(msg.data.x || 0),
          y: Number(msg.data.y || 0),
          z: Number(msg.data.z || 0),
          ry: Number(msg.data.ry || 0),
          m: !!msg.data.m
        };
      }

      broadcast(room, {
        type: 'pos',
        id: ws.id,
        data: player ? player.pos : msg.data
      }, ws);
      return;
    }

    // ==================== CHAT ====================
    if (msg.type === 'chat' && msg.data) {
      broadcast(room, {
        type: 'chat',
        data: {
          name: String(msg.data.name || ws.playerName).slice(0, 24),
          text: String(msg.data.text || '').slice(0, 1000)
        }
      });
      return;
    }

    // ==================== WHITEBOARD ====================
    if (msg.type === 'draw' && msg.data) {
      broadcast(room, {
        type: 'draw',
        data: msg.data
      }, ws);
      return;
    }

    if (msg.type === 'clear') {
      broadcast(room, { type: 'clear' }, ws);
      return;
    }

    // ==================== LAYOUT ====================
    if (msg.type === 'layout_save' && msg.data && typeof msg.data === 'object') {
      persistLayout(ws.roomId, msg.data);

      broadcast(room, {
        type: 'layout_load',
        data: msg.data
      });

      return;
    }

    if (msg.type === 'layout_load') {
      if (savedLayouts[ws.roomId]) {
        send(ws, {
          type: 'layout_load',
          data: savedLayouts[ws.roomId]
        });
      }
      return;
    }

    // ==================== ROOM / HOST STATE ====================
    if (msg.type === 'room_state' && msg.data && typeof msg.data === 'object') {
      room.state = {
        ...makeDefaultRoomState(),
        ...room.state,
        ...msg.data,
        media: {
          ...makeDefaultRoomState().media,
          ...(room.state?.media || {}),
          ...(msg.data.media || {})
        }
      };

      persistRoomState(ws.roomId, room.state);

      broadcast(room, {
        type: 'room_state',
        data: room.state
      });

      return;
    }

    if (msg.type === 'state_get') {
      send(ws, {
        type: 'room_state',
        data: room.state
      });

      if (savedLayouts[ws.roomId]) {
        send(ws, {
          type: 'layout_load',
          data: savedLayouts[ws.roomId]
        });
      }

      return;
    }

    // ==================== HOST EVENT ====================
    if (msg.type === 'host_event' && msg.data && typeof msg.data === 'object') {
      // persist room state when event includes vibe/media
      if (msg.data.kind === 'vibe' && msg.data.mode) {
        room.state.vibe = String(msg.data.mode);
        persistRoomState(ws.roomId, room.state);
      }

      if (msg.data.kind === 'media') {
        room.state.media = {
          videoId: String(msg.data.videoId || ''),
          playing: !!msg.data.playing,
          startAt: Number(msg.data.startAt || 0),
          startedAt: Number(msg.data.startedAt || 0)
        };
        persistRoomState(ws.roomId, room.state);
      }

      broadcast(room, {
        type: 'host_event',
        data: {
          ...msg.data,
          from: ws.playerName,
          at: Date.now()
        }
      });

      return;
    }

    // ==================== RTC PASS-THROUGH ====================
    if (
      msg.type === 'rtc-offer' ||
      msg.type === 'rtc-answer' ||
      msg.type === 'rtc-ice' ||
      msg.type === 'rtc-request-call'
    ) {
      const targetId = msg.to;
      if (!targetId) return;

      for (const client of room.clients) {
        if (client.id === targetId) {
          send(client, {
            ...msg,
            from: ws.id
          });
          break;
        }
      }

      return;
    }

    // ==================== PING ====================
    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;

    const room = rooms.get(ws.roomId);
    if (!room) return;

    room.clients.delete(ws);
    room.players.delete(ws.id);

    broadcast(room, {
      type: 'peer-leave',
      id: ws.id,
      name: ws.playerName
    });

    if (room.clients.size === 0) {
      rooms.delete(ws.roomId);
    }
  });
});

const interval = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch (err) {}
  }
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log(`Vibe Room server running on port ${PORT}`);
});