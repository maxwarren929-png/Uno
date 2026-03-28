# 🎴 UNO Online

A full-stack multiplayer UNO game with real-time Socket.IO gameplay, PostgreSQL persistence, and account system.

## Stack
- **Backend**: Node.js + Express + Socket.IO
- **Database**: PostgreSQL (via `pg`)
- **Auth**: JWT + bcrypt
- **Frontend**: Vanilla HTML/CSS/JS (served as static files from Express)

## Features
- ✅ Sign up / Log in with accounts
- ✅ Create rooms with shareable 6-letter codes
- ✅ Join friends' rooms
- ✅ Full UNO rules (Skip, Reverse, Draw 2, Wild, Wild+4)
- ✅ UNO callout system (say UNO, catch opponents)
- ✅ In-game chat
- ✅ Win/Loss stats & leaderboard
- ✅ Real-time updates via Socket.IO

---

## 🚀 Deploy to Render

### Option A — One-click with render.yaml (recommended)

1. Push this folder to a **GitHub repo**
2. Go to [render.com](https://render.com) → **New → Blueprint**
3. Connect your repo — Render reads `render.yaml` and auto-creates:
   - A **Web Service** (Node.js)
   - A **PostgreSQL database**
4. Click **Apply** — done! Render handles `DATABASE_URL` automatically.

### Option B — Manual setup

1. **Create a PostgreSQL database** on Render → copy the *Internal Connection String*

2. **Create a Web Service** on Render:
   - Environment: `Node`
   - Build command: `cd server && npm install`
   - Start command: `cd server && node index.js`

3. **Add environment variables**:
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | *(paste your Postgres connection string)* |
   | `JWT_SECRET` | *(any long random string)* |
   | `NODE_ENV` | `production` |

4. Deploy — the server auto-creates the DB tables on first boot.

---

## 🧪 Local Development

```bash
cd server
npm install

# Create a .env file:
echo "DATABASE_URL=postgresql://localhost/uno_dev" > .env
echo "JWT_SECRET=local-dev-secret" >> .env
echo "PORT=3000" >> .env

node index.js
# Visit http://localhost:3000
```

---

## 📁 Project Structure

```
uno-game/
├── render.yaml          # Render Blueprint config
├── package.json         # Root (for Render)
├── server/
│   ├── index.js         # Express + Socket.IO server + all game logic
│   └── package.json     # Server dependencies
└── client/
    └── public/
        └── index.html   # Entire frontend (single file)
```

---

## 🎮 How to Play

1. **Sign up** for an account
2. **Create Room** → share the 6-letter code with friends
3. Friends click **Join Room** and enter the code  
4. Host clicks **Start Game** (min. 2 players, max. 4)
5. Play UNO! Click a card to select it, click again to play it
6. Wild cards prompt a color picker
7. Click the deck to draw
8. Hit **UNO!** when you have 1-2 cards left
9. Click **CATCH!** on an opponent who forgot to say UNO

---

## 🃏 UNO Rules Implemented

| Card | Effect |
|------|--------|
| Numbers (0-9) | Match by color or number |
| Skip | Next player loses their turn |
| Reverse | Direction flips (acts as Skip in 2-player) |
| Draw 2 | Next player draws 2 and skips |
| Wild | Change color, play on anything |
| Wild Draw 4 | Next player draws 4 and skips, you pick color |

**Deck**: 108 cards standard UNO deck  
**Winning**: First to empty their hand wins
