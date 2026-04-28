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

const BJ = {
  seatCount: 6,
  startingBank: 5000,
  minBet: 25,
  maxBet: 500,
  maxTransfer: 1000,
  bettingMs: 12000,
  turnMs: 20000,
  resultsMs: 7000,
  decks: 4
};

// roomId -> {
//   clients: Set<ws>,
//   players: Map<id, player>,
//   blackjack: table state,
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
      blackjack: makeBlackjackState(),
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

function makeBlackjackState() {
  return {
    phase: 'betting',
    seats: Array.from({ length: BJ.seatCount }, () => null),
    players: {},
    shoe: [],
    dealer: { hand: [], reveal: false },
    turnSeat: null,
    roundId: 0,
    phaseEndsAt: 0,
    message: 'Place a play-money bet to start blackjack.',
    timer: null
  };
}

function getBjPlayer(room, id) {
  if (!room.blackjack.players[id]) {
    const profile = room.players.get(id);
    room.blackjack.players[id] = {
      id,
      name: profile ? profile.name : 'Guest',
      bank: BJ.startingBank,
      wallet: 0,
      seat: null,
      bet: 0,
      hand: [],
      stood: false,
      busted: false,
      doubled: false,
      result: ''
    };
  } else {
    const profile = room.players.get(id);
    if (profile) room.blackjack.players[id].name = profile.name;
  }
  return room.blackjack.players[id];
}

function clearBjTimer(table) {
  if (table.timer) clearTimeout(table.timer);
  table.timer = null;
}

function sanitizeAmount(value) {
  const amount = Math.floor(Number(value));
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.min(1000000, amount));
}

function makeShoe() {
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const suits = ['S', 'H', 'D', 'C'];
  const shoe = [];
  for (let d = 0; d < BJ.decks; d++) {
    for (const suit of suits) {
      for (const rank of ranks) shoe.push({ rank, suit });
    }
  }
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'K' || rank === 'Q' || rank === 'J') return 10;
  return Number(rank);
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    total += cardValue(card.rank);
    if (card.rank === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

function drawCard(table) {
  if (table.shoe.length < 26) table.shoe = makeShoe();
  return table.shoe.pop();
}

function activeBetSeats(table) {
  const out = [];
  for (let i = 0; i < table.seats.length; i++) {
    const id = table.seats[i];
    if (!id) continue;
    const p = table.players[id];
    if (p && p.bet > 0) out.push(i);
  }
  return out;
}

function publicBlackjackState(room, viewerId = null) {
  const table = room.blackjack;
  const players = {};
  for (const [id, p] of Object.entries(table.players)) {
    players[id] = {
      id,
      name: p.name,
      bank: id === viewerId ? p.bank : undefined,
      wallet: id === viewerId ? p.wallet : undefined,
      seat: p.seat,
      bet: p.bet,
      hand: p.hand,
      total: p.hand.length ? handValue(p.hand) : 0,
      stood: p.stood,
      busted: p.busted,
      doubled: p.doubled,
      result: p.result
    };
  }
  const dealerHand = table.dealer.reveal
    ? table.dealer.hand
    : table.dealer.hand.map((card, idx) => idx === 1 ? { hidden: true } : card);
  return {
    type: 'blackjack_state',
    data: {
      phase: table.phase,
      seats: table.seats,
      players,
      dealer: {
        hand: dealerHand,
        total: table.dealer.reveal ? handValue(table.dealer.hand) : (table.dealer.hand[0] ? handValue([table.dealer.hand[0]]) : 0)
      },
      turnSeat: table.turnSeat,
      roundId: table.roundId,
      phaseEndsAt: table.phaseEndsAt,
      message: table.message,
      minBet: BJ.minBet,
      maxBet: BJ.maxBet,
      maxTransfer: BJ.maxTransfer,
      seatCount: BJ.seatCount
    }
  };
}

function broadcastBlackjack(room) {
  for (const client of room.clients) {
    send(client, publicBlackjackState(room, client.id));
  }
}

function scheduleBlackjack(room, ms, fn) {
  const table = room.blackjack;
  clearBjTimer(table);
  table.timer = setTimeout(() => {
    table.timer = null;
    fn();
  }, ms);
}

function resetHandsForBetting(table) {
  table.dealer = { hand: [], reveal: false };
  table.turnSeat = null;
  for (const p of Object.values(table.players)) {
    p.bet = 0;
    p.hand = [];
    p.stood = false;
    p.busted = false;
    p.doubled = false;
    p.result = '';
  }
}

function enterBetting(room) {
  const table = room.blackjack;
  clearBjTimer(table);
  table.phase = 'betting';
  table.phaseEndsAt = 0;
  table.message = 'Place a play-money bet to start blackjack.';
  resetHandsForBetting(table);
  broadcastBlackjack(room);
}

function scheduleBettingStart(room) {
  const table = room.blackjack;
  if (table.phase !== 'betting' || table.phaseEndsAt) return;
  table.phaseEndsAt = Date.now() + BJ.bettingMs;
  table.message = 'Bets are open. Round starts soon.';
  scheduleBlackjack(room, BJ.bettingMs, () => startBlackjackRound(room));
  broadcastBlackjack(room);
}

function startBlackjackRound(room) {
  const table = room.blackjack;
  if (table.phase !== 'betting') return;
  const seats = activeBetSeats(table);
  if (!seats.length) {
    enterBetting(room);
    return;
  }
  table.phase = 'dealing';
  table.roundId += 1;
  table.phaseEndsAt = 0;
  table.dealer = { hand: [], reveal: false };
  if (table.shoe.length < 26) table.shoe = makeShoe();
  for (const i of seats) {
    const p = table.players[table.seats[i]];
    p.hand = [];
    p.stood = false;
    p.busted = false;
    p.doubled = false;
    p.result = '';
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const i of seats) table.players[table.seats[i]].hand.push(drawCard(table));
    table.dealer.hand.push(drawCard(table));
  }
  table.message = 'Cards dealt.';
  broadcastBlackjack(room);

  if (isBlackjack(table.dealer.hand) || seats.every(i => isBlackjack(table.players[table.seats[i]].hand))) {
    finishPlayersAndResolve(room);
    return;
  }
  table.phase = 'player_turn';
  advanceBlackjackTurn(room);
}

function advanceBlackjackTurn(room) {
  const table = room.blackjack;
  const seats = activeBetSeats(table);
  const start = table.turnSeat === null ? -1 : table.turnSeat;
  for (const seat of seats) {
    if (seat <= start) continue;
    const p = table.players[table.seats[seat]];
    if (p && !p.stood && !p.busted && !isBlackjack(p.hand)) {
      table.turnSeat = seat;
      table.phase = 'player_turn';
      table.phaseEndsAt = Date.now() + BJ.turnMs;
      table.message = `${p.name}'s turn.`;
      scheduleBlackjack(room, BJ.turnMs, () => {
        const current = table.players[table.seats[seat]];
        if (table.phase === 'player_turn' && table.turnSeat === seat && current) {
          current.stood = true;
          current.result = 'Auto-stand';
          advanceBlackjackTurn(room);
        }
      });
      broadcastBlackjack(room);
      return;
    }
  }
  finishPlayersAndResolve(room);
}

function finishPlayersAndResolve(room) {
  const table = room.blackjack;
  clearBjTimer(table);
  table.phase = 'dealer_turn';
  table.turnSeat = null;
  table.phaseEndsAt = 0;
  table.dealer.reveal = true;
  while (handValue(table.dealer.hand) < 17) table.dealer.hand.push(drawCard(table));
  resolveBlackjackRound(room);
}

function resolveBlackjackRound(room) {
  const table = room.blackjack;
  const dealerTotal = handValue(table.dealer.hand);
  const dealerBust = dealerTotal > 21;
  const dealerBj = isBlackjack(table.dealer.hand);
  for (const p of Object.values(table.players)) {
    if (!p.bet) continue;
    const total = handValue(p.hand);
    const bj = isBlackjack(p.hand);
    let payout = 0;
    if (p.busted || total > 21) {
      p.result = 'Bust';
    } else if (bj && !dealerBj) {
      payout = p.bet + Math.floor(p.bet * 1.5);
      p.result = 'Blackjack pays 3:2';
    } else if (dealerBj && !bj) {
      p.result = 'Dealer blackjack';
    } else if (dealerBust || total > dealerTotal) {
      payout = p.bet * 2;
      p.result = 'Win';
    } else if (total === dealerTotal) {
      payout = p.bet;
      p.result = 'Push';
    } else {
      p.result = 'Loss';
    }
    p.wallet += payout;
  }
  table.phase = 'results';
  table.phaseEndsAt = Date.now() + BJ.resultsMs;
  table.message = 'Round complete. Results paid in play-money chips.';
  broadcastBlackjack(room);
  scheduleBlackjack(room, BJ.resultsMs, () => enterBetting(room));
}

function handleBlackjackMessage(room, ws, msg) {
  const table = room.blackjack;
  const p = getBjPlayer(room, ws.id);
  if (msg.type === 'blackjack_get') {
    send(ws, publicBlackjackState(room, ws.id));
    return true;
  }
  if (msg.type === 'blackjack_sit') {
    const seat = Math.floor(Number(msg.seat));
    if (seat < 0 || seat >= BJ.seatCount || table.seats[seat]) {
      send(ws, { type: 'blackjack_error', error: 'Seat is not available.' });
      return true;
    }
    if (p.seat !== null && table.seats[p.seat] === ws.id) table.seats[p.seat] = null;
    p.seat = seat;
    table.seats[seat] = ws.id;
    table.message = `${p.name} sat at seat ${seat + 1}.`;
    broadcastBlackjack(room);
    return true;
  }
  if (msg.type === 'blackjack_leave') {
    if (table.phase !== 'betting' && p.bet > 0) {
      send(ws, { type: 'blackjack_error', error: 'Leave between rounds after your bet resolves.' });
      return true;
    }
    if (p.seat !== null && table.seats[p.seat] === ws.id) table.seats[p.seat] = null;
    if (table.phase === 'betting' && p.bet > 0) p.wallet += p.bet;
    p.seat = null;
    p.bet = 0;
    p.hand = [];
    p.result = '';
    table.message = `${p.name} left the blackjack table.`;
    broadcastBlackjack(room);
    return true;
  }
  if (msg.type === 'safe_withdraw' || msg.type === 'safe_deposit') {
    const amount = Math.min(BJ.maxTransfer, sanitizeAmount(msg.amount));
    if (amount <= 0) return true;
    if (msg.type === 'safe_withdraw') {
      const moved = Math.min(amount, p.bank);
      p.bank -= moved;
      p.wallet += moved;
      table.message = `${p.name} withdrew ${moved} play chips.`;
    } else {
      const moved = Math.min(amount, p.wallet);
      p.wallet -= moved;
      p.bank += moved;
      table.message = `${p.name} deposited ${moved} play chips.`;
    }
    broadcastBlackjack(room);
    return true;
  }
  if (msg.type === 'blackjack_bet') {
    if (table.phase !== 'betting' || p.seat === null) {
      send(ws, { type: 'blackjack_error', error: 'Sit down during betting to place a bet.' });
      return true;
    }
    const amount = sanitizeAmount(msg.amount);
    if (amount < BJ.minBet || amount > BJ.maxBet || amount > p.wallet) {
      send(ws, { type: 'blackjack_error', error: 'Invalid bet or not enough wallet chips.' });
      return true;
    }
    if (p.bet > 0) p.wallet += p.bet;
    p.bet = amount;
    p.wallet -= amount;
    p.result = 'Bet locked';
    scheduleBettingStart(room);
    broadcastBlackjack(room);
    return true;
  }
  if (msg.type === 'blackjack_hit' || msg.type === 'blackjack_stand' || msg.type === 'blackjack_double') {
    if (table.phase !== 'player_turn' || p.seat === null || table.turnSeat !== p.seat) {
      send(ws, { type: 'blackjack_error', error: 'It is not your turn.' });
      return true;
    }
    if (msg.type === 'blackjack_hit') {
      p.hand.push(drawCard(table));
      if (handValue(p.hand) > 21) {
        p.busted = true;
        p.result = 'Bust';
        advanceBlackjackTurn(room);
      } else {
        table.phaseEndsAt = Date.now() + BJ.turnMs;
        table.message = `${p.name} hit.`;
        scheduleBlackjack(room, BJ.turnMs, () => {
          if (table.phase === 'player_turn' && table.turnSeat === p.seat) {
            p.stood = true;
            p.result = 'Auto-stand';
            advanceBlackjackTurn(room);
          }
        });
        broadcastBlackjack(room);
      }
      return true;
    }
    if (msg.type === 'blackjack_stand') {
      p.stood = true;
      p.result = 'Stand';
      advanceBlackjackTurn(room);
      return true;
    }
    if (msg.type === 'blackjack_double') {
      if (p.hand.length !== 2 || p.wallet < p.bet) {
        send(ws, { type: 'blackjack_error', error: 'Double down requires two cards and enough wallet chips.' });
        return true;
      }
      p.wallet -= p.bet;
      p.bet *= 2;
      p.doubled = true;
      p.hand.push(drawCard(table));
      if (handValue(p.hand) > 21) {
        p.busted = true;
        p.result = 'Double bust';
      } else {
        p.stood = true;
        p.result = 'Double stand';
      }
      advanceBlackjackTurn(room);
      return true;
    }
  }
  return false;
}

function cleanupBlackjackPlayer(room, id) {
  const table = room.blackjack;
  const p = table.players[id];
  if (!p) return;
  if (p.seat !== null && table.seats[p.seat] === id) table.seats[p.seat] = null;
  delete table.players[id];
  if (table.turnSeat !== null && table.seats[table.turnSeat] === null) advanceBlackjackTurn(room);
  else broadcastBlackjack(room);
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
      getBjPlayer(room, ws.id);

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
      send(ws, publicBlackjackState(room, ws.id));

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

    if (
      msg.type === 'blackjack_get' ||
      msg.type === 'blackjack_sit' ||
      msg.type === 'blackjack_leave' ||
      msg.type === 'blackjack_bet' ||
      msg.type === 'blackjack_hit' ||
      msg.type === 'blackjack_stand' ||
      msg.type === 'blackjack_double' ||
      msg.type === 'safe_withdraw' ||
      msg.type === 'safe_deposit'
    ) {
      if (handleBlackjackMessage(room, ws, msg)) return;
    }

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
    cleanupBlackjackPlayer(room, ws.id);
    room.players.delete(ws.id);

    broadcast(room, {
      type: 'peer-leave',
      id: ws.id,
      name: ws.playerName
    });

    if (room.clients.size === 0) {
      clearBjTimer(room.blackjack);
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
