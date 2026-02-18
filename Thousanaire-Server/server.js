const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 10000;

/* ============================================================
   ROOM STRUCTURE
   ============================================================ */
/*
rooms = {
  ROOMID: {
    players: {
      0: { socketId, name, avatar, color, chips, eliminated, danger },
      1: { ... },
      2: { ... },
      3: { ... }
    },
    centerPot: 0,
    currentPlayer: 0,
    gameStarted: false
  }
}
*/

let rooms = {};

function createRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* ============================================================
   HELPER FUNCTIONS
   ============================================================ */

function getNextSeat(room, seat) {
  for (let i = 1; i <= 4; i++) {
    const s = (seat + i) % 4;
    if (room.players[s] && !room.players[s].eliminated) return s;
  }
  return seat;
}

function countPlayersWithChips(room) {
  return Object.values(room.players).filter(p => p && p.chips > 0).length;
}

function getLastPlayerWithChips(room) {
  const arr = Object.entries(room.players)
    .filter(([seat, p]) => p && p.chips > 0);
  if (arr.length === 1) return parseInt(arr[0][0]);
  return null;
}

function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const state = {
    players: [null, null, null, null],
    chips:   [0, 0, 0, 0],
    avatars: [null, null, null, null],
    colors:  [null, null, null, null],
    eliminated: [false, false, false, false],
    danger:     [false, false, false, false],
    centerPot: room.centerPot,
    currentPlayer: room.currentPlayer,
    gameStarted: room.gameStarted
  };

  for (let seat = 0; seat < 4; seat++) {
    const p = room.players[seat];
    if (!p) continue;

    state.players[seat]    = p.name;
    state.chips[seat]      = p.chips;
    state.avatars[seat]    = p.avatar;
    state.colors[seat]     = p.color;
    state.eliminated[seat] = p.eliminated;
    state.danger[seat]     = p.danger;
  }

  io.to(roomId).emit("stateUpdate", state);
}

/* ============================================================
   MAIN SOCKET LOGIC
   ============================================================ */

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  /* ---------------- CREATE ROOM ---------------- */
  socket.on("createRoom", () => {
    const roomId = createRoomId();

    rooms[roomId] = {
      players: { 0: null, 1: null, 2: null, 3: null },
      centerPot: 0,
      currentPlayer: 0,
      gameStarted: false
    };

    socket.join(roomId);
    socket.emit("roomCreated", { roomId });
    console.log("Room created:", roomId);
  });

  /* ---------------- JOIN ROOM ---------------- */
  socket.on("joinRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    const seatsTaken = Object.values(room.players).filter(p => p !== null).length;
    if (seatsTaken >= 4) {
      socket.emit("errorMessage", "Room is full");
      return;
    }

    socket.join(roomId);
    socket.emit("joinedRoom", { roomId, seat: null });
  });

  /* ---------------- JOIN SEAT ---------------- */
  socket.on("joinSeat", ({ roomId, name, avatar, color }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Assign next available seat (0→1→2→3)
    let seat = null;
    for (let i = 0; i < 4; i++) {
      if (!room.players[i]) {
        seat = i;
        break;
      }
    }
    if (seat === null) {
      socket.emit("errorMessage", "Room is full");
      return;
    }

    room.players[seat] = {
      socketId: socket.id,
      name,
      avatar,
      color,
      chips: 3,
      eliminated: false,
      danger: false
    };

    socket.join(roomId);
    socket.emit("joinedRoom", { roomId, seat });

    broadcastState(roomId);
  });

  /* ---------------- ROLL DICE ---------------- */
  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);

    if (!seat) return;
    const playerSeat = parseInt(seat[0]);

    if (playerSeat !== room.currentPlayer) return;

    const player = room.players[playerSeat];
    if (player.eliminated) return;

    // If player has 0 chips, skip turn
    if (player.chips === 0) {
      player.danger = true;
      room.currentPlayer = getNextSeat(room, playerSeat);
      broadcastState(roomId);
      return;
    }

    room.gameStarted = true;

    // Roll dice
    const numDice = Math.min(player.chips, 3);
    const faces = ["Left", "Right", "Hub", "Dottt", "Wild"];
    const outcomes = [];

    for (let i = 0; i < numDice; i++) {
      outcomes.push(faces[Math.floor(Math.random() * faces.length)]);
    }

    const wildCount = outcomes.filter(o => o === "Wild").length;

    // Triple wild → special prompt
    if (wildCount === 3) {
      io.to(player.socketId).emit("requestTripleWildChoice", {
        roomId,
        seat: playerSeat
      });
      return;
    }

    // Normal wilds → prompt client for choices
    if (wildCount > 0) {
      io.to(player.socketId).emit("requestWildChoice", {
        roomId,
        seat: playerSeat,
        outcomes
      });
      return;
    }

    // No wilds → apply outcomes immediately
    applyOutcomes(roomId, playerSeat, outcomes);
  });

  /* ---------------- RESOLVE NORMAL WILDS ---------------- */
  socket.on("resolveWilds", ({ roomId, actions }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (!seat) return;

    const playerSeat = parseInt(seat[0]);

    applyWildActions(roomId, playerSeat, actions);
  });

  /* ---------------- TRIPLE WILD CHOICE ---------------- */
  socket.on("tripleWildChoice", ({ roomId, choice }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (!seat) return;

    const playerSeat = parseInt(seat[0]);

    applyTripleWild(roomId, playerSeat, choice);
  });

  /* ---------------- RESET GAME ---------------- */
  socket.on("resetGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    for (let i = 0; i < 4; i++) {
      if (room.players[i]) {
        room.players[i].chips = 3;
        room.players[i].eliminated = false;
        room.players[i].danger = false;
      }
    }

    room.centerPot = 0;
    room.currentPlayer = 0;
    room.gameStarted = false;

    broadcastState(roomId);
  });

  /* ---------------- DISCONNECT ---------------- */
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const roomId in rooms) {
      const room = rooms[roomId];

      for (let seat = 0; seat < 4; seat++) {
        const p = room.players[seat];
        if (p && p.socketId === socket.id) {
          room.players[seat] = null;
        }
      }

      const active = Object.values(room.players).filter(p => p).length;
      if (active === 0) {
        delete rooms[roomId];
        console.log("Room deleted:", roomId);
      } else {
        broadcastState(roomId);
      }
    }
  });
});

/* ============================================================
   GAME LOGIC FUNCTIONS
   ============================================================ */

function applyOutcomes(roomId, seat, outcomes) {
  const room = rooms[roomId];
  const player = room.players[seat];

  outcomes.forEach(o => {
    if (o === "Left" && player.chips > 0) {
      const leftSeat = getNextSeat(room, seat);
      player.chips--;
      room.players[leftSeat].chips++;
    }
    if (o === "Right" && player.chips > 0) {
      const rightSeat = getNextSeat(room, seat - 2); // reverse direction
      player.chips--;
      room.players[rightSeat].chips++;
    }
    if (o === "Hub" && player.chips > 0) {
      player.chips--;
      room.centerPot++;
    }
  });

  finalizeTurn(roomId, seat);
}

function applyWildActions(roomId, seat, actions) {
  const room = rooms[roomId];
  const player = room.players[seat];

  actions.forEach(a => {
    if (a.type === "cancel") {
      // Canceling is handled implicitly by not applying that outcome
    }
    if (a.type === "steal") {
      const target = room.players[a.from];
      if (target && target.chips > 0) {
        target.chips--;
        player.chips++;
      }
    }
  });

  finalizeTurn(roomId, seat);
}

function applyTripleWild(roomId, seat, choice) {
  const room = rooms[roomId];
  const player = room.players[seat];

  if (choice.type === "takePot") {
    player.chips += room.centerPot;
    room.centerPot = 0;
  }

  if (choice.type === "steal3") {
    let steals = 3;
    for (let i = 0; i < 4; i++) {
      if (i === seat) continue;
      const target = room.players[i];
      if (target && target.chips > 0 && steals > 0) {
        const amount = Math.min(target.chips, steals);
        target.chips -= amount;
        player.chips += amount;
        steals -= amount;
      }
    }
  }

  finalizeTurn(roomId, seat);
}

function finalizeTurn(roomId, seat) {
  const room = rooms[roomId];
  const player = room.players[seat];

  // Danger logic
  if (player.chips === 0) {
    if (player.danger) {
      player.eliminated = true;
    } else {
      player.danger = true;
    }
  } else {
    player.danger = false;
  }

  // Instant win if only one player has chips
  const count = countPlayersWithChips(room);
  if (count === 1) {
    const winnerSeat = getLastPlayerWithChips(room);
    const winner = room.players[winnerSeat];

    io.to(roomId).emit("gameOver", {
      winnerSeat,
      winnerName: winner.name,
      pot: room.centerPot
    });

    broadcastState(roomId);
    return;
  }

  // Advance turn
  room.currentPlayer = getNextSeat(room, seat);

  broadcastState(roomId);
}

/* ============================================================
   START SERVER
   ============================================================ */

server.listen(PORT, () => {
  console.log(`Authoritative game server running on port ${PORT}`);
});
