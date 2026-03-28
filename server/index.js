const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'uno-secret-change-in-production';

// ── Init DB ───────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS game_rooms (
      id VARCHAR(10) PRIMARY KEY,
      host_id INTEGER REFERENCES users(id),
      state JSONB,
      status VARCHAR(20) DEFAULT 'waiting',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database initialized');
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, wins, losses, games_played',
      [username, email, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') {
      const field = err.detail.includes('username') ? 'Username' : 'Email';
      res.status(400).json({ error: `${field} already taken` });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, wins: user.wins, losses: user.losses, games_played: user.games_played } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT id, username, email, wins, losses, games_played FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json(result.rows[0]);
});

app.get('/api/leaderboard', async (req, res) => {
  const result = await pool.query(
    'SELECT username, wins, losses, games_played FROM users ORDER BY wins DESC LIMIT 10'
  );
  res.json(result.rows);
});

// ── UNO Game Logic ────────────────────────────────────────────────────────────
const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];
const WILDS = ['wild', 'wild4'];

function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (const value of VALUES) {
      deck.push({ color, value, id: uuidv4() });
      if (value !== '0') deck.push({ color, value, id: uuidv4() });
    }
  }
  for (const value of WILDS) {
    for (let i = 0; i < 4; i++) deck.push({ color: 'wild', value, id: uuidv4() });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dealCards(deck, count) {
  return deck.splice(0, count);
}

function canPlay(card, topCard, currentColor) {
  if (card.color === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function applyCardEffect(gameState, card, chosenColor) {
  const players = gameState.players;
  const n = players.length;
  let next = (gameState.currentPlayer + gameState.direction + n) % n;

  if (card.value === 'skip') {
    gameState.currentPlayer = (next + gameState.direction + n) % n;
    return;
  }
  if (card.value === 'reverse') {
    gameState.direction *= -1;
    if (n === 2) {
      // In 2-player, reverse acts like skip
      gameState.currentPlayer = (gameState.currentPlayer + gameState.direction + n) % n;
      return;
    }
    gameState.currentPlayer = (gameState.currentPlayer + gameState.direction + n) % n;
    return;
  }
  if (card.value === 'draw2') {
    const drawn = dealCards(gameState.deck, 2);
    if (gameState.deck.length < 2) reshuffleDeck(gameState);
    players[next].hand.push(...drawn);
    gameState.currentPlayer = (next + gameState.direction + n) % n;
    return;
  }
  if (card.value === 'wild') {
    gameState.currentColor = chosenColor;
    gameState.currentPlayer = next;
    return;
  }
  if (card.value === 'wild4') {
    const drawn = dealCards(gameState.deck, 4);
    if (gameState.deck.length < 4) reshuffleDeck(gameState);
    players[next].hand.push(...drawn);
    gameState.currentColor = chosenColor;
    gameState.currentPlayer = (next + gameState.direction + n) % n;
    return;
  }

  gameState.currentPlayer = next;
}

function reshuffleDeck(gameState) {
  const top = gameState.discardPile.pop();
  gameState.deck = shuffle(gameState.discardPile);
  gameState.discardPile = [top];
}

function createGame(players) {
  const deck = shuffle(buildDeck());
  const hands = players.map(p => ({ id: p.id, username: p.username, hand: dealCards(deck, 7), saidUno: false }));
  let top;
  do { top = deck.shift(); } while (top.color === 'wild');

  return {
    deck,
    discardPile: [top],
    currentColor: top.color,
    currentPlayer: 0,
    direction: 1,
    players: hands,
    status: 'playing',
    winner: null
  };
}

// In-memory rooms (synced to DB periodically)
const rooms = {};
const socketToUser = {};
const userToRoom = {};

function getRoomState(roomId, forPlayerId) {
  const room = rooms[roomId];
  if (!room || !room.gameState) return null;
  const gs = room.gameState;
  return {
    discardPile: gs.discardPile,
    currentColor: gs.currentColor,
    currentPlayer: gs.currentPlayer,
    direction: gs.direction,
    status: gs.status,
    winner: gs.winner,
    players: gs.players.map(p => ({
      id: p.id,
      username: p.username,
      handCount: p.hand.length,
      hand: p.id === forPlayerId ? p.hand : undefined,
      saidUno: p.saidUno
    })),
    deckCount: gs.deck.length
  };
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('auth', ({ token }) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      socketToUser[socket.id] = user;
      socket.emit('authed', { username: user.username });
    } catch {
      socket.emit('error', 'Invalid token');
    }
  });

  socket.on('create_room', () => {
    const user = socketToUser[socket.id];
    if (!user) return socket.emit('error', 'Not authenticated');

    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      hostId: user.id,
      players: [{ id: user.id, username: user.username, socketId: socket.id }],
      gameState: null,
      status: 'waiting'
    };
    userToRoom[user.id] = roomId;
    socket.join(roomId);
    socket.emit('room_created', { roomId });
    io.to(roomId).emit('room_update', { players: rooms[roomId].players, status: 'waiting', roomId });
  });

  socket.on('join_room', ({ roomId }) => {
    const user = socketToUser[socket.id];
    if (!user) return socket.emit('error', 'Not authenticated — try refreshing');
    const room = rooms[roomId];
    console.log(`Join attempt: ${user.username} → room ${roomId}, exists: ${!!room}, active rooms: ${Object.keys(rooms).join(', ')}`);
    if (!room) return socket.emit('error', `Room "${roomId}" not found — check the code or ask host to recreate`);
    if (room.status !== 'waiting') return socket.emit('error', 'Game already started');
    if (room.players.length >= 4) return socket.emit('error', 'Room is full (max 4 players)');
    if (room.players.find(p => p.id === user.id)) {
      socket.join(roomId);
      socket.emit('room_joined', { roomId });
      io.to(roomId).emit('room_update', { players: room.players, status: room.status, roomId });
      return;
    }

    room.players.push({ id: user.id, username: user.username, socketId: socket.id });
    userToRoom[user.id] = roomId;
    socket.join(roomId);
    socket.emit('room_joined', { roomId });
    io.to(roomId).emit('room_update', { players: room.players, status: 'waiting', roomId });
  });

  socket.on('start_game', () => {
    const user = socketToUser[socket.id];
    if (!user) return;
    const roomId = userToRoom[user.id];
    const room = rooms[roomId];
    if (!room || room.hostId !== user.id) return socket.emit('error', 'Not the host');
    if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players');

    room.gameState = createGame(room.players);
    room.status = 'playing';

    room.players.forEach(p => {
      const playerSocket = io.sockets.sockets.get(p.socketId);
      if (playerSocket) {
        playerSocket.emit('game_started', getRoomState(roomId, p.id));
      }
    });
  });

  socket.on('play_card', ({ cardId, chosenColor }) => {
    const user = socketToUser[socket.id];
    if (!user) return;
    const roomId = userToRoom[user.id];
    const room = rooms[roomId];
    if (!room || !room.gameState) return;
    const gs = room.gameState;

    const playerIdx = gs.players.findIndex(p => p.id === user.id);
    if (playerIdx !== gs.currentPlayer) return socket.emit('error', 'Not your turn');

    const player = gs.players[playerIdx];
    const cardIdx = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return socket.emit('error', 'Card not in hand');

    const card = player.hand[cardIdx];
    const topCard = gs.discardPile[gs.discardPile.length - 1];

    if (!canPlay(card, topCard, gs.currentColor)) return socket.emit('error', 'Cannot play that card');

    player.hand.splice(cardIdx, 1);
    player.saidUno = false;
    gs.discardPile.push(card);
    if (card.color !== 'wild') gs.currentColor = card.color;

    if (player.hand.length === 0) {
      gs.status = 'finished';
      gs.winner = user.username;
      // Update DB stats
      pool.query('UPDATE users SET wins = wins + 1, games_played = games_played + 1 WHERE id = $1', [user.id]);
      room.players.filter(p => p.id !== user.id).forEach(p => {
        pool.query('UPDATE users SET losses = losses + 1, games_played = games_played + 1 WHERE id = $1', [p.id]);
      });
    } else {
      applyCardEffect(gs, card, chosenColor);
    }

    room.players.forEach(p => {
      const playerSocket = io.sockets.sockets.get(p.socketId);
      if (playerSocket) {
        playerSocket.emit('game_update', getRoomState(roomId, p.id));
      }
    });
  });

  socket.on('draw_card', () => {
    const user = socketToUser[socket.id];
    if (!user) return;
    const roomId = userToRoom[user.id];
    const room = rooms[roomId];
    if (!room || !room.gameState) return;
    const gs = room.gameState;

    const playerIdx = gs.players.findIndex(p => p.id === user.id);
    if (playerIdx !== gs.currentPlayer) return socket.emit('error', 'Not your turn');

    if (gs.deck.length === 0) reshuffleDeck(gs);
    if (gs.deck.length === 0) return socket.emit('error', 'No cards left');

    const [drawn] = gs.deck.splice(0, 1);
    gs.players[playerIdx].hand.push(drawn);

    const n = gs.players.length;
    gs.currentPlayer = (gs.currentPlayer + gs.direction + n) % n;

    room.players.forEach(p => {
      const playerSocket = io.sockets.sockets.get(p.socketId);
      if (playerSocket) playerSocket.emit('game_update', getRoomState(roomId, p.id));
    });
  });

  socket.on('say_uno', () => {
    const user = socketToUser[socket.id];
    if (!user) return;
    const roomId = userToRoom[user.id];
    const room = rooms[roomId];
    if (!room || !room.gameState) return;
    const player = room.gameState.players.find(p => p.id === user.id);
    if (player && player.hand.length <= 2) {
      player.saidUno = true;
      io.to(roomId).emit('uno_called', { username: user.username });
    }
  });

  socket.on('call_out_uno', ({ targetId }) => {
    const user = socketToUser[socket.id];
    if (!user) return;
    const roomId = userToRoom[user.id];
    const room = rooms[roomId];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const target = gs.players.find(p => p.id === targetId);
    if (target && target.hand.length === 1 && !target.saidUno) {
      const drawn = gs.deck.splice(0, 2);
      target.hand.push(...drawn);
      io.to(roomId).emit('uno_penalty', { username: target.username });
      room.players.forEach(p => {
        const ps = io.sockets.sockets.get(p.socketId);
        if (ps) ps.emit('game_update', getRoomState(roomId, p.id));
      });
    }
  });

  socket.on('send_chat', ({ message }) => {
    const user = socketToUser[socket.id];
    if (!user) return;
    const roomId = userToRoom[user.id];
    if (!roomId) return;
    io.to(roomId).emit('chat_message', { username: user.username, message, time: Date.now() });
  });

  socket.on('disconnect', () => {
    const user = socketToUser[socket.id];
    if (user) {
      const roomId = userToRoom[user.id];
      if (roomId && rooms[roomId]) {
        const room = rooms[roomId];
        room.players = room.players.filter(p => p.id !== user.id);
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          io.to(roomId).emit('player_left', { username: user.username, players: room.players });
        }
      }
      delete userToRoom[user.id];
      delete socketToUser[socket.id];
    }
    console.log('Socket disconnected:', socket.id);
  });
});

// ── Catch-all: serve frontend ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, () => console.log(`🎴 UNO server running on port ${PORT}`));
});