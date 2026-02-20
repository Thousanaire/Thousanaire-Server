const express = require("express");
const http = require("http");
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// 🎯 RENDER.COM READY: Serve ALL frontend files from project root
app.use(express.static(__dirname));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

console.log("🚀 Serving files from:", __dirname);

// 🚀 COMPLETE FIXED SERVER INITIALIZATION - MOBILE FRIENDLY + IMMORTAL
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 1200000,
  pingInterval: 25000,  
  connectTimeout: 10000 
});

const PORT = process.env.PORT || 10000;
let graceRoundPlayers = new Set();
let rooms = {};

// Auto-clean empty rooms
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
HELPER FUNCTIONS - UNCHANGED
============================================================ */
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

function finalizeTurn(roomId, seat) {
  const room = rooms[roomId];
  if (!room) return;
  
  if (room.players[seat].chips <= 0) {
    room.players[seat].eliminated = true;
    console.log(`🎲 Player ${room.players[seat].name} eliminated`);
  }
  
  room.currentPlayer = getNextSeat(room, seat);
  
  const activePlayers = countPlayersWithChips(room);
  if (activePlayers <= 1) {
    for (let i = 0; i < 4; i++) {
      if (room.players[i] && room.players[i].chips > 0) {
        io.to(roomId).emit("gameOver", { winner: room.players[i].name });
        break;
      }
    }
    return;
  }
  
  io.to(roomId).emit("playerTurn", {
    currentPlayer: room.currentPlayer,
    chips: room.players.map(p => p ? p.chips : 0),
    gameStarted: true
  });
  
  console.log(`📡 Turn ${room.currentPlayer}: ${room.players[room.currentPlayer]?.name || 'EMPTY'}`);
}

function applyWildActions(roomId, seat, outcomes, cancels = [], steals = []) {
  const room = rooms[roomId];
  if (!room) return;
  
  const player = room.players[seat];
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
              fromSeat: a.from,
              toSeat: seat,
              type: "steal"
            });
          }
        }
      });
    }
    finalizeTurn(roomId, seat);
    return;
  }

  const canceledIndices = new Set(cancels || []);
  steals.forEach(s => {
    const target = room.players[s.from];
    if (target && target.chips > 0) {
      target.chips--;
      player.chips++;
      io.to(roomId).emit("chipTransfer", {
        fromSeat: s.from,
        toSeat: seat,
        type: "steal"
      });
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

// 🎮 SOCKET CONNECTIONS - ALL FIXED
io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  // 🛡️ IMMORTAL DISCONNECT
  socket.on("disconnect", (reason) => {
    console.log(`🔌 DISCONNECT: ${socket.id} (${reason})`);
    if (reason.includes("timeout") || reason.includes("ping") || 
        reason === "transport close" || reason === "io server disconnect" || reason === "transport error") {
      console.log(`🛡️ IMMORTAL: ${socket.id} stays seated (${reason})`);
      return;
    }
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      for (let seat = 0; seat < 4; seat++) {
        if (room.players[seat] && room.players[seat].socketId === socket.id) {
          console.log(`👤 "${room.players[seat].name}" unseated from seat ${seat}`);
          room.players[seat] = null;
          room.seatedCount = (room.seatedCount || 4) - 1;
          io.to(roomId).emit("playerUpdate", getFullRoomState(roomId));
          break;
        }
      }
    }
  });
  
  // 👥 JOIN LOBBY
  socket.on("joinRoom", (data) => {
    if (!data?.roomId) return socket.emit("error", { message: "Missing roomId" });
    
    const room = rooms[data.roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    
    socket.join(data.roomId);
    socket.emit("roomJoined", getFullRoomState(data.roomId));
    console.log(`👥 Lobby: ${data.roomId} (${room.seatedCount || 0}/4)`);
  });
  
  // ✅ JOIN SEAT - **ROLL BUTTON + NAMES FIXED**
  socket.on("joinSeat", (data) => {
    if (!data?.roomId || !data.name) {
      return socket.emit("error", { message: "Missing roomId or name" });
    }
    
    const { roomId, name, avatar, color } = data;
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    
    const openSeat = room.players.findIndex(p => p === null);
    if (openSeat === -1) return socket.emit("error", { message: "Room full" });
    
    // 🎯 SEAT PLAYER
    room.players[openSeat] = {
      name,
      socketId: socket.id,
      avatar: avatar || null,
      color: color || null,
      chips: 3,
      eliminated: false
    };
    room.seatedCount = (room.seatedCount || 0) + 1;
    
    socket.join(roomId);
    socket.emit("joinedRoom", { roomId, seat: openSeat });
    
    // 🎯 BROADCAST FULL STATE - NAMES APPEAR!
    io.to(roomId).emit("playerUpdate", getFullRoomState(roomId));
    
    console.log(`✅ "${name}" seated at ${openSeat} (${room.seatedCount}/4) in ${roomId}`);
    
    // 🎮 AUTO-START GAME + ROLL BUTTON
    if (room.seatedCount === 4) {
      room.gameState = "playing";
      room.gameStarted = true;
      room.currentPlayer = 0;
      
      io.to(roomId).emit("gameStart", getFullRoomState(roomId));
      
      // 🎯 HOST ROLL BUTTON GREEN!
      io.to(roomId).emit("playerTurn", {
        currentPlayer: 0,
        chips: room.players.map(p => p ? p.chips : 0),
        gameStarted: true
      });
      
      console.log(`🎮 ${roomId}: Game started - Quay (seat 0) turn! 🎲`);
    }
  });
  
  // 🏠 CREATE ROOM
  socket.on("createRoom", () => {
    const roomId = createRoomId();
    rooms[roomId] = {
      id: roomId,
      players: [null, null, null, null],
      seatedCount: 0,
      currentPlayer: 0,
      centerPot: 0,
      gameState: "waiting",
      gameStarted: false
    };
    
    socket.join(roomId);
    socket.emit("roomCreated", { roomId });
    console.log(`🏠 Room created: ${roomId}`);
  });
  
  // 🎲 ROLL DICE - FULLY FIXED
  socket.on("rollDice", (data) => {
    if (!data?.roomId) return console.log("❌ rollDice: no roomId");
    
    const room = rooms[data.roomId];
    if (!room || room.currentPlayer === undefined) return;
    
    const player = room.players[room.currentPlayer];
    if (!player || player.eliminated) return;
    
    console.log(`🎲 ${player.name} (seat ${room.currentPlayer}) ROLLING...`);
    
    const diceFaces = ["Dot", "Dot", "Dot", "Left", "Right", "Wild", "Hub"];
    const rollResults = Array(3).fill().map(() => diceFaces[Math.floor(Math.random() * diceFaces.length)]);
    
    io.to(data.roomId).emit("playerTurn", {
      currentPlayer: room.currentPlayer,
      chips: room.players.map(p => p ? p.chips : 0),
      gameStarted: true
    });
    
    io.to(data.roomId).emit("diceRoll", { seat: room.currentPlayer, results: rollResults });
    
    // Dots
    const dots = rollResults.filter(r => r === "Dot").length;
    if (dots > 0 && player.chips < 3) {
      const chipsToGain = Math.min(dots, 3 - player.chips);
      player.chips += chipsToGain;
      io.to(data.roomId).emit("chipsGained", { seat: room.currentPlayer, count: chipsToGain });
    }
    
    // Wild
    const wildCount = rollResults.filter(r => r === "Wild").length;
    if (wildCount > 0) {
      io.to(data.roomId).emit("wildActions", { seat: room.currentPlayer, outcomes: rollResults });
    } else {
      applyWildActions(data.roomId, room.currentPlayer, rollResults);
    }
  });
  
  socket.on("wildActions", (data) => {
    if (!data?.roomId || !data.seat) return;
    applyWildActions(data.roomId, data.seat, data.outcomes, data.cancels || [], data.steals || []);
  });
  
  socket.on("resetGame", (data) => {
    if (!data?.roomId) return;
    const room = rooms[data.roomId];
    if (!room) return;
    
    for (let i = 0; i < 4; i++) {
      if (room.players[i]) {
        room.players[i].chips = 3;
        room.players[i].eliminated = false;
      }
    }
    
    room.currentPlayer = 0;
    room.centerPot = 0;
    room.gameState = "playing";
    room.gameStarted = true;
    
    io.to(data.roomId).emit("gameReset", getFullRoomState(data.roomId));
    io.to(data.roomId).emit("playerTurn", {
      currentPlayer: 0,
      chips: room.players.map(p => p ? p.chips : 0),
      gameStarted: true
    });
  });
});

// 🎯 HELPER - FULL ROOM STATE (NAMES + CHIPS + STATUS)
function getFullRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  
  return {
    players: room.players.map(p => p ? {
      name: p.name,
      chips: p.chips,
      avatar: p.avatar,
      color: p.color,
      eliminated: p.eliminated || false
    } : null),
    seatedCount: room.seatedCount || 0,
    currentPlayer: room.currentPlayer || 0,
    gameStarted: room.gameStarted || false,
    gameState: room.gameState || "waiting"
  };
}

server.listen(PORT, () => {
  console.log(`🚀 Thousanaire server running on port ${PORT}`);
  console.log(`📱 Test: http://localhost:${PORT}`);
  console.log(`🌐 Render: https://thousanaire-server.onrender.com`);
});
