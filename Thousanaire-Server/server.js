const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 1200000,
  pingInterval: 25000,
  connectTimeout: 10000
});

const PORT = process.env.PORT || 10000;
let graceRoundPlayers = new Set();
let rooms = {};

setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const seatedPlayers = Object.values(room.players).filter(p => p !== null).length;
    if (seatedPlayers === 0) {
      for (let key of graceRoundPlayers) {
        if (key.startsWith(roomId + '-')) graceRoundPlayers.delete(key);
      }
      delete rooms[roomId];
      console.log("🧹 Auto-deleted empty room:", roomId);
    }
  }
}, 5 * 60 * 1000);

function createRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getNextSeat(room, seat) {
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
  const arr = Object.entries(room.players).filter(([seat, p]) => p && p.chips > 0);
  return arr.length === 1 ? parseInt(arr[0][0]) : null;
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
    centerPot: room.centerPot || 0,
    currentPlayer: room.currentPlayer || 0,
    gameStarted: room.gameStarted || false
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

function finalizeTurn(roomId, seat) {
  const room = rooms[roomId];
  if (!room || !room.players[seat]) return;
  
  const player = room.players[seat];
  const playersWithChips = countPlayersWithChips(room);

  if (player.chips <= 0) {
    player.eliminated = true;
    console.log(`🎲 Player ${player.name} eliminated`);
  }

  if (playersWithChips <= 1) {
    const winnerSeat = getLastPlayerWithChips(room);
    if (winnerSeat !== null) {
      const winner = room.players[winnerSeat];
      io.to(roomId).emit("gameOver", { 
        winnerSeat, 
        winnerName: winner.name, 
        pot: room.centerPot 
      });
    }
    return;
  }

  room.currentPlayer = getNextSeat(room, seat);
  io.to(roomId).emit("playerTurn", {
    currentPlayer: room.currentPlayer,
    chips: Object.values(room.players).map(p => p ? p.chips : 0)
  });
  
  console.log(`📡 Broadcasting to ${roomId}: currentPlayer=${room.currentPlayer}`);
  broadcastState(roomId);
}

/* 🔥 BACKWARDS COMPATIBLE WILD LOGIC */
function applyWildActions(roomId, seat, outcomes, cancels = [], steals = []) {
  const room = rooms[roomId];
  if (!room || !room.players[seat]) return;
  
  const player = room.players[seat];

  // BACKWARDS COMPAT: Handle old {actions} OR new {outcomes,cancels,steals}
  if (!Array.isArray(outcomes)) {
    const actions = outcomes;
    if (Array.isArray(actions)) {
      actions.forEach(a => {
        if (a && a.type === "steal") {
          const target = room.players[a.from];
          if (target && target.chips > 0) {
            target.chips--;
            player.chips++;
            io.to(roomId).emit("chipTransfer", {
              fromSeat: a.from, toSeat: seat, type: "steal"
            });
          }
        }
      });
    }
    finalizeTurn(roomId, seat);
    return;
  }

  // NEW FORMAT: Full wild logic
  const canceledIndices = new Set(cancels);
  steals.forEach(s => {
    const target = room.players[s.from];
    if (target && target.chips > 0) {
      target.chips--;
      player.chips++;
      io.to(roomId).emit("chipTransfer", { fromSeat: s.from, toSeat: seat, type: "steal" });
    }
  });

  outcomes.forEach((o, i) => {
    if (canceledIndices.has(i) || o === "Wild") return;
    
    if (o === "Left" && player.chips > 0) {
      const leftSeat = getNextSeat(room, seat);
      player.chips--;
      room.players[leftSeat].chips++;
      io.to(roomId).emit("chipTransfer", { fromSeat: seat, toSeat: leftSeat, type: "left" });
    } else if (o === "Right" && player.chips > 0) {
      const rightSeat = getNextSeat(room, seat + 2);
      player.chips--;
      room.players[rightSeat].chips++;
      io.to(roomId).emit("chipTransfer", { fromSeat: seat, toSeat: rightSeat, type: "right" });
    } else if (o === "Hub" && player.chips > 0) {
      player.chips--;
      room.centerPot = (room.centerPot || 0) + 1;
      io.to(roomId).emit("chipTransfer", { fromSeat: seat, toSeat: null, type: "hub" });
    }
  });

  io.to(roomId).emit("historyEntry", {
    playerName: player.name,
    outcomesText: outcomes.join(", ")
  });

  finalizeTurn(roomId, seat);
}

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  socket.on("disconnect", (reason) => {
    console.log(`🔌 DISCONNECT: ${socket.id} (${reason})`);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      for (let seat = 0; seat < 4; seat++) {
        if (room.players[seat] && room.players[seat].socketId === socket.id) {
          console.log(`👤 Player "${room.players[seat].name}" unseated from ${seat} in ${roomId}`);
          room.players[seat] = null;
          broadcastState(roomId);
          break;
        }
      }
    }
  });

  // ✅ OLD CLIENT COMPATIBLE: createRoom → roomJoined
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
    socket.emit("roomJoined", { roomId });
    console.log(`🏠 Room created: ${roomId}`);
  });

  socket.on("joinRoom", ({ roomId, playerName }) => {
    const raw = (roomId || "").trim().toUpperCase();
    const room = rooms[raw];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }
    
    const openSeat = Object.values(room.players).filter(p => p === null).length;
    if (openSeat === 0) {
      socket.emit("error", { message: "Room full" });
      return;
    }

    socket.join(raw);
    socket.emit("roomJoined", { roomId: raw });
    console.log(`✅ Client joined lobby: ${raw}`);
  });

  // ✅ Roll dice (backwards compatible)
  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    
    const seatEntry = Object.entries(room.players).find(([s, p]) => p && p.socketId === socket.id);
    if (!seatEntry || parseInt(seatEntry[0]) !== room.currentPlayer) return;

    const playerSeat = parseInt(seatEntry[0]);
    const player = room.players[playerSeat];
    if (player.eliminated) return;

    console.log(`🎲 ${player.name} (seat ${playerSeat}) ROLLING...`);
    
    const diceFaces = ["Dot", "Dot", "Dot", "Left", "Right", "Wild", "Hub"];
    const rollResults = [];
    for (let i = 0; i < 3; i++) {
      rollResults.push(diceFaces[Math.floor(Math.random() * diceFaces.length)]);
    }

    io.to(roomId).emit("diceRoll", { seat: playerSeat, results: rollResults });
    console.log(`🎲 Roll: ${rollResults.join(", ")}`);

    // Dots
    let dots = rollResults.filter(r => r === "Dot").length;
    if (dots > 0 && player.chips < 3) {
      const gain = Math.min(dots, 3 - player.chips);
      player.chips += gain;
      io.to(roomId).emit("chipsGained", { seat: playerSeat, count: gain });
    }

    // Wilds
    const wildCount = rollResults.filter(r => r === "Wild").length;
    if (wildCount > 0) {
      io.to(roomId).emit("wildActions", { seat: playerSeat, outcomes: rollResults });
    } else {
      applyWildActions(roomId, playerSeat, rollResults);
    }
  });

  socket.on("wildActions", (data) => {
    applyWildActions(data.roomId, data.seat, data.outcomes, data.cancels || [], data.steals || []);
  });

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
    console.log(`🔄 Game reset: ${roomId}`);
  });

  // Add your joinSeat handler from old code here if needed
});

server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📱 http://localhost:${PORT}`);
});
