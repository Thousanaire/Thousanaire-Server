const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// 🚀 COMPLETE FIXED SERVER INITIALIZATION - MOBILE FRIENDLY
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // 🎯 MOBILE TIMEOUT FIX - Survives screen timeout (20 minutes)
  pingTimeout: 1200000, // 20 minutes before disconnect (default: 20s)
  pingInterval: 25000,  // Ping every 25 seconds (default: 25s)
  connectTimeout: 10000 // 10s connection timeout
});

const PORT = process.env.PORT || 10000;

let graceRoundPlayers = new Set();
let rooms = {};

// Auto-clean empty rooms after 5 minutes
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const seatedPlayers = Object.values(room.players).filter(p => p !== null).length;
    if (seatedPlayers === 0) {
      for (let key of graceRoundPlayers) {
        if (key.startsWith(roomId + '-')) {
          graceRoundPlayers.delete(key);
        }
      }
      delete rooms[roomId];
      console.log("🧹 Auto-deleted empty room:", roomId);
    }
  }
}, 5 * 60 * 1000);

function createRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* ============================================================
HELPER FUNCTIONS
============================================================ */

function getNextSeat(room, seat) {
  // Clockwise, skipping eliminated seats
  for (let i = 1; i <= 4; i++) {
    const s = (seat + i + 4) % 4;
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
    chips: [0, 0, 0, 0],
    avatars: [null, null, null, null],
    colors: [null, null, null, null],
    eliminated: [false, false, false, false],
    danger: [false, false, false, false],
    centerPot: room.centerPot,
    currentPlayer: room.currentPlayer,
    gameStarted: room.gameStarted
  };

  for (let seat = 0; seat < 4; seat++) {
    const p = room.players[seat];
    if (!p) continue;
    state.players[seat] = p.name;
    state.chips[seat] = p.chips;
    state.avatars[seat] = p.avatar;
    state.colors[seat] = p.color;
    state.eliminated[seat] = p.eliminated;
    state.danger[seat] = p.danger;
  }

  io.to(roomId).emit("stateUpdate", state);
}

function handleZeroChipsOnTurn(roomId, seat) {
  const room = rooms[roomId];
  const player = room.players[seat];
  if (!player) return false;

  const playersWithChips = countPlayersWithChips(room);

  if (player.chips === 0) {
    if (playersWithChips <= 1) {
      if (playersWithChips === 1) {
        const winnerSeat = getLastPlayerWithChips(room);
        const winner = room.players[winnerSeat];
        io.to(roomId).emit("gameOver", {
          winnerSeat,
          winnerName: winner.name,
          pot: room.centerPot
        });
        // winner will take pot in finalizeTurn logic if needed
        broadcastState(roomId);
        return true;
      }
    } else {
      if (!graceRoundPlayers.has(`${roomId}-${seat}`)) {
        player.danger = true;
        graceRoundPlayers.add(`${roomId}-${seat}`);
        io.to(roomId).emit("graceWarning", {
          seat,
          message: `${player.name} on DANGER - 1 full round left!`
        });
      } else {
        player.eliminated = true;
        graceRoundPlayers.delete(`${roomId}-${seat}`);
        io.to(roomId).emit("playerEliminated", {
          seat,
          name: player.name
        });
      }
    }
  }

  room.currentPlayer = getNextSeat(room, seat);
  broadcastState(roomId);
  return false;
}

/* ============================================================
MAIN SOCKET LOGIC
============================================================ */

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  /* ---------------- CREATE ROOM - FIXED HOST FLOW ---------------- */
  socket.on("createRoom", () => {
    const roomId = createRoomId();
    rooms[roomId] = {
      players: { 0: null, 1: null, 2: null, 3: null },
      centerPot: 0,
      currentPlayer: 0, // 🎯 HOST ALWAYS STARTS AT SEAT 0
      gameStarted: false
    };
    socket.join(roomId);
    socket.emit("roomCreated", { roomId });
    socket.emit("roomJoined", { roomId }); // 🎯 HOST IMMEDIATELY IN LOBBY
    console.log("🎯 Room created:", roomId, "- Host ready for SEAT 0");
  });

  /* ---------------- JOIN ROOM ---------------- */
  socket.on("joinRoom", ({ roomId }) => {
    const raw = (roomId || "").trim().toUpperCase();
    const direct = rooms[raw] ? raw : null;

    if (!direct) {
      socket.emit("errorMessage", "Room not found");
      console.log("JoinRoom failed. Requested:", roomId);
      return;
    }

    const room = rooms[direct];
    const seatsTaken = Object.values(room.players).filter(p => p !== null).length;

    if (seatsTaken >= 4) {
      socket.emit("errorMessage", "Room is full");
      return;
    }

    socket.join(direct);
    socket.emit("roomJoined", { roomId: direct });
    console.log(`Client ${socket.id} joined room lobby:`, direct);
  });

  /* ---------------- JOIN SEAT - 🎯 START GAME WHEN FULL ---------------- */
  socket.on("joinSeat", ({ roomId, name, avatar, color }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    // Check if already seated
    const existingSeat = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (existingSeat) {
      socket.emit("errorMessage", "You already joined this game.");
      return;
    }

    let seat = null;
    const seatedCount = Object.values(room.players).filter(p => p !== null).length;

    // 🎯 RULE 1: FIRST PLAYER = HOST = SEAT 0 ALWAYS
    if (seatedCount === 0) {
      seat = 0;
      console.log(`🎯 HOST "${name}" AUTO-ASSIGNED SEAT 0 in ${roomId}`);
    }
    // 🎯 RULE 2: Others fill seats 1,2,3
    else {
      for (let i = 1; i < 4; i++) {
        if (!room.players[i]) {
          seat = i;
          break;
        }
      }
    }

    if (seat === null) {
      socket.emit("errorMessage", "Room is full");
      return;
    }

    room.players[seat] = {
      socketId: socket.id,
      name: name.substring(0, 12),
      avatar,
      color,
      chips: 3,
      eliminated: false,
      danger: false,
      seatedTime: Date.now() // 🎯 TRACK WHEN SEATED
    };

    // 🎯 CRITICAL FIX: START GAME WHEN 4 PLAYERS SEATED!
    const newSeatedCount = Object.values(room.players).filter(p => p !== null).length;
    if (newSeatedCount === 4) {
      room.gameStarted = true;
      console.log(`🚀 GAME STARTED in ${roomId}! ${room.players[0].name} (seat 0) rolls first! 🎲`);
    }

    socket.join(roomId);
    socket.emit("joinedRoom", { roomId, seat });
    broadcastState(roomId);
    console.log(`✅ Player "${name}" (${room.players[seat].name}) seated at ${seat} (${newSeatedCount}/4) in ${roomId}`);
  });

  /* ---------------- CHAT ---------------- */
  socket.on("chatMessage", ({ roomId, name, text }) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit("chatMessage", { name, text });
    console.log(`[${roomId}] ${name}: ${text}`);
  });

  /* ---------------- ROLL DICE ---------------- */
  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seatEntry = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (!seatEntry) return;

    const playerSeat = parseInt(seatEntry[0]);
    if (playerSeat !== room.currentPlayer) {
      console.log(`❌ ${room.players[playerSeat]?.name} tried to roll but not their turn (current: ${room.currentPlayer})`);
      return;
    }

    const player = room.players[playerSeat];
    if (player.eliminated) return;

    console.log(`🎲 ${player.name} (seat ${playerSeat}) ROLLING...`);

    // Handle 0 chips BEFORE rolling
    if (player.chips === 0) {
      const ended = handleZeroChipsOnTurn(roomId, playerSeat);
      if (ended) return;
    }

    // 🎯 ENSURE gameStarted is true (backup from joinSeat fix)
    room.gameStarted = true;
    broadcastState(roomId); // Sends gameStarted: true + current state

    const numDice = Math.min(player.chips, 3);
    const faces = ["Left", "Right", "Hub", "Dottt", "Wild"];
    const outcomes = [];

    for (let i = 0; i < numDice; i++) {
      outcomes.push(faces[Math.floor(Math.random() * faces.length)]);
    }

    console.log(`🎲 Roll results for ${player.name}: ${outcomes.join(", ")}`);

    io.to(roomId).emit("rollResult", {
      seat: playerSeat,
      outcomes,
      outcomesText: outcomes.join(", ")
    });

    const wildCount = outcomes.filter(o => o === "Wild").length;

    if (wildCount === 3) {
      io.to(player.socketId).emit("requestTripleWildChoice", { roomId, seat: playerSeat });
      return;
    }

    if (wildCount > 0) {
      io.to(player.socketId).emit("requestWildChoice", { roomId, seat: playerSeat, outcomes });
      return;
    }

    applyOutcomes(roomId, playerSeat, outcomes);
  });

  /* ---------------- RESOLVE WILDS ---------------- */
  socket.on("resolveWilds", ({ roomId, actions }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seatEntry = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (!seatEntry) return;

    const playerSeat = parseInt(seatEntry[0]);
    applyWildActions(roomId, playerSeat, actions);
  });

  socket.on("tripleWildChoice", ({ roomId, choice }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seatEntry = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (!seatEntry) return;

    const playerSeat = parseInt(seatEntry[0]);
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

    for (let key of graceRoundPlayers) {
      if (key.startsWith(roomId + '-')) {
        graceRoundPlayers.delete(key);
      }
    }

    room.centerPot = 0;
    room.currentPlayer = 0;
    room.gameStarted = false;
    broadcastState(roomId);
  });

  /* ---------------- IMMORTAL SEATED PLAYERS - NO DISCONNECTS ---------------- */
  socket.on("disconnect", (reason) => {
    console.log("🔌 DISCONNECT ATTEMPT:", socket.id, reason);
    
    let foundSeatedPlayer = false;

    // 🎯 ONLY REMOVE IF NOT SEATED > 30 SECONDS OR NOT SEATED AT ALL
    for (const roomId in rooms) {
      const room = rooms[roomId];
      
      for (let seat = 0; seat < 4; seat++) {
        const player = room.players[seat];
        if (player && player.socketId === socket.id) {
          
          // 🎯 IMMORTAL MODE: Seated players > 30s STAY SEATED
          if (player.seatedTime && (Date.now() - player.seatedTime) > 30000) {
            console.log(`🛡️ IMMORTAL "${player.name}" seat ${seat} in ${roomId} - STAYING SEATED`);
            player.socketId = null; // Mark as disconnected but KEEP SEATED
            foundSeatedPlayer = true;
            break;
          } 
          
          // Normal disconnect for new/unseated players
          console.log(`👋 Player "${player.name}" left seat ${seat} in ${roomId}`);
          room.players[seat] = null;
          broadcastState(roomId);
          foundSeatedPlayer = true;
          break;
        }
      }
      if (foundSeatedPlayer) break;
    }
    
    if (!foundSeatedPlayer) {
      console.log("👤 Unseated client disconnected:", socket.id);
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
      io.to(roomId).emit("chipTransfer", { fromSeat: seat, toSeat: leftSeat, type: "left" });
    }

    if (o === "Right" && player.chips > 0) {
      const rightSeat = getNextSeat(room, seat + 2);
      player.chips--;
      room.players[rightSeat].chips++;
      io.to(roomId).emit("chipTransfer", { fromSeat: seat, toSeat: rightSeat, type: "right" });
    }

    if (o === "Hub" && player.chips > 0) {
      player.chips--;
      room.centerPot++;
      io.to(roomId).emit("chipTransfer", { fromSeat: seat, toSeat: null, type: "hub" });
    }
  });

  io.to(roomId).emit("historyEntry", {
    playerName: player.name,
    outcomesText: outcomes.join(", ")
  });

  finalizeTurn(roomId, seat);
}

function applyWildActions(roomId, seat, actions) {
  const room = rooms[roomId];
  const player = room.players[seat];

  actions.forEach(a => {
    if (a.type === "steal") {
      const target = room.players[a.from];
      if (target && target.chips > 0) {
        target.chips--;
        player.chips++;
        io.to(roomId).emit("chipTransfer", { fromSeat: a.from, toSeat: seat, type: "steal" });
      }
    }
  });

  finalizeTurn(roomId, seat);
}

function applyTripleWild(roomId, seat, choice) {
  const room = rooms[roomId];
  const player = room.players[seat];

  if (choice.type === "takePot") {
    if (room.centerPot > 0) {
      player.chips += room.centerPot;
      io.to(roomId).emit("chipTransfer", { fromSeat: null, toSeat: seat, type: "takePot" });
    }
    room.centerPot = 0;
  }

  if (choice.type === "steal3") {
    let steals = 3;
    for (let i = 0; i < 4 && steals > 0; i++) {
      if (i === seat) continue;
      const target = room.players[i];
      if (target && target.chips > 0) {
        const amount = Math.min(target.chips, steals);
        target.chips -= amount;
        player.chips += amount;
        steals -= amount;
        io.to(roomId).emit("chipTransfer", { fromSeat: i, toSeat: seat, type: "steal3" });
      }
    }
  }

  finalizeTurn(roomId, seat);
}

function finalizeTurn(roomId, seat) {
  const room = rooms[roomId];
  const player = room.players[seat];
  const playersWithChips = countPlayersWithChips(room);

  // Clear danger if player recovered chips
  if (player.chips > 0) {
    player.danger = false;
    const graceKey = `${roomId}-${seat}`;
    graceRoundPlayers.delete(graceKey);
  }

  // Game ends ONLY when exactly 1 player has chips
  if (playersWithChips === 1) {
    const winnerSeat = getLastPlayerWithChips(room);
    const winner = room.players[winnerSeat];

    io.to(roomId).emit("gameOver", {
      winnerSeat,
      winnerName: winner.name,
      pot: room.centerPot
    });

    // Winner takes pot
    if (winner) {
      winner.chips += room.centerPot;
    }
    room.centerPot = 0;

    broadcastState(roomId);
    console.log(`🏆 ${winner.name} WINS ${roomId}! Final chips: ${winner.chips}`);
    return;
  }

  // Always continue clockwise, skipping eliminated / 0-chip players
  room.currentPlayer = getNextSeat(room, seat);
  while (
    room.players[room.currentPlayer]?.eliminated ||
    room.players[room.currentPlayer]?.chips === 0
  ) {
    room.currentPlayer = getNextSeat(room, room.currentPlayer);
  }

  console.log(
    `➡️ Turn → ${room.players[room.currentPlayer]?.name || "Seat " + room.currentPlayer
    } (seat ${room.currentPlayer}) - ${playersWithChips} players remain`
  );

  broadcastState(roomId);
}

/* ============================================================
START SERVER
============================================================ */

server.listen(PORT, () => {
  console.log(`🚀 Thousanaire server running on port ${PORT}`);
  console.log(`📱 Test at: http://localhost:${PORT}`);
});
