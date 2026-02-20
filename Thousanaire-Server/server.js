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

// 🚀 COMPLETE FIXED SERVER INITIALIZATION - MOBILE FRIENDLY
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // 🎯 MOBILE TIMEOUT FIX - Survives screen timeout (20 minutes)
  pingTimeout: 1200000, // 20 minutes before disconnect (default: 20s)
  pingInterval: 25000,  // Ping every 25 seconds
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

function finalizeTurn(roomId, seat) {
  const room = rooms[roomId];
  if (!room) return;
  
  // Eliminate player if no chips
  if (room.players[seat].chips <= 0) {
    room.players[seat].eliminated = true;
    console.log(`🎲 Player ${room.players[seat].name} eliminated`);
  }
  
  // Move to next player
  room.currentPlayer = getNextSeat(room, seat);
  
  // Check win condition
  const activePlayers = countPlayersWithChips(room);
  if (activePlayers <= 1) {
    // Find winner
    for (let i = 0; i < 4; i++) {
      if (room.players[i] && room.players[i].chips > 0) {
        io.to(roomId).emit("gameOver", { winner: room.players[i].name });
        break;
      }
    }
    return;
  }
  
  // Broadcast game state
  io.to(roomId).emit("playerTurn", {
    currentPlayer: room.currentPlayer,
    chips: room.players.map(p => p ? p.chips : 0)
  });
  
  console.log(`📡 Broadcasting to ${roomId}: currentPlayer=${room.currentPlayer}, chips=${room.players.map(p => p ? p.chips : 0)}`);
}

/* 🔥 BACKWARDS COMPATIBLE WILD LOGIC - Handles BOTH old/new client formats */
function applyWildActions(roomId, seat, outcomes, cancels = [], steals = []) {
  const room = rooms[roomId];
  if (!room) return;
  
  const player = room.players[seat];

  // 🔥 BACKWARDS COMPATIBILITY: Handle old {actions} format OR new {outcomes,cancels,steals}
  if (!Array.isArray(outcomes)) {
    // OLD FORMAT: {roomId, actions} - just do steals like before
    const actions = outcomes; // repurpose param
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

  // NEW FORMAT: {roomId, outcomes, cancels, steals} - full wild logic
  const canceledIndices = new Set(cancels || []);

  // 1) Apply steals first
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

  // 2) Apply remaining non-canceled Left/Right/Hub
  outcomes.forEach((o, i) => {
    if (canceledIndices.has(i)) return;
    if (o === "Wild") return;

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

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Graceful disconnect handling
  socket.on("disconnect", (reason) => {
    console.log(`🔌 DISCONNECT: ${socket.id} (${reason})`);
    
    // Find if this socket belongs to a seated player
    for (const roomId in rooms) {
      const room = rooms[roomId];
      for (let seat = 0; seat < 4; seat++) {
        if (room.players[seat] && room.players[seat].socketId === socket.id) {
          console.log(`👤 Player "${room.players[seat].name}" (${room.players[seat].name}) unseated from seat ${seat} in ${roomId}`);
          room.players[seat] = null;
          break;
        }
      }
    }
  });
  
  // 🎯 ROOM LOBBY ENTRY - Friends enter code first
  socket.on("joinRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }
    
    socket.join(roomId);
    socket.emit("roomJoined", { 
      roomId, 
      players: room.players.map(p => p ? { name: p.name, chips: p.chips } : null),
      seatedCount: room.seatedCount 
    });
    
    console.log(`👥 Client entered lobby: ${roomId} (${room.seatedCount}/4 seated)`);
  });
  
  // 🎯 JOIN SEAT - After name/avatar/color selection
  socket.on("joinSeat", ({ roomId, name, avatar, color }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }
    
    const openSeat = room.players.findIndex(p => p === null);
    if (openSeat === -1) {
      socket.emit("error", { message: "Room full" });
      return;
    }
    
    room.players[openSeat] = {
      name,
      socketId: socket.id,
      avatar: avatar || null,
      color: color || null,
      chips: 3,
      eliminated: false
    };
    room.seatedCount++;
    
    socket.join(roomId);
    socket.emit("joinedRoom", { roomId, seat: openSeat });
    
    io.to(roomId).emit("playerUpdate", {
      players: room.players.map(p => p ? { name: p.name, chips: p.chips, avatar: p.avatar, color: p.color } : null),
      seatedCount: room.seatedCount
    });
    
    console.log(`✅ "${name}" (${avatar ? 'avatar' : 'no avatar'}) seated at ${openSeat} (${room.seatedCount}/4) in ${roomId}`);
    
    if (room.seatedCount === 4) {
      room.gameState = "playing";
      io.to(roomId).emit("gameStart", { 
        currentPlayer: 0,
        chips: room.players.map(p => p.chips)
      });
      console.log(`🎮 Game started in ${roomId}`);
    }
  });
  
  socket.on("createRoom", () => {
    const roomId = createRoomId();
    rooms[roomId] = {
      id: roomId,
      players: [null, null, null, null],
      seatedCount: 0,
      currentPlayer: 0,
      centerPot: 0,
      gameState: "waiting"
    };
    
    socket.join(roomId);
    socket.emit("roomCreated", { roomId });
    console.log(`🏠 Room created: ${roomId}`);
  });
  
  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.currentPlayer === undefined) return;
    
    const player = room.players[room.currentPlayer];
    if (!player || player.eliminated) return;
    
    console.log(`🎲 ${player.name} (seat ${room.currentPlayer}) ROLLING...`);
    
    // Simulate dice roll (Dot, Dot, Dot, Left, Right, Wild, Hub)
    const diceFaces = ["Dot", "Dot", "Dot", "Left", "Right", "Wild", "Hub"];
    const rollResults = [];
    
    for (let i = 0; i < 3; i++) {
      rollResults.push(diceFaces[Math.floor(Math.random() * diceFaces.length)]);
    }
    
    io.to(roomId).emit("diceRoll", {
      seat: room.currentPlayer,
      results: rollResults
    });
    
    console.log(`🎲 Roll results for ${player.name}: ${rollResults.join(", ")}`);
    
    // Apply dots first
    let dots = rollResults.filter(r => r === "Dot").length;
    if (dots > 0 && player.chips > 0) {
      const chipsToGain = Math.min(dots, 3 - player.chips);
      player.chips += chipsToGain;
      io.to(roomId).emit("chipsGained", {
        seat: room.currentPlayer,
        count: chipsToGain
      });
    }
    
    // Handle wild actions
    const wildCount = rollResults.filter(r => r === "Wild").length;
    if (wildCount > 0) {
      io.to(roomId).emit("wildActions", {
        seat: room.currentPlayer,
        outcomes: rollResults
      });
    } else {
      applyWildActions(roomId, room.currentPlayer, rollResults);
    }
  });
  
  socket.on("wildActions", (data) => {
    applyWildActions(data.roomId, data.seat, data.outcomes, data.cancels || [], data.steals || []);
  });
  
  socket.on("resetGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    
    // Reset all players
    for (let i = 0; i < 4; i++) {
      if (room.players[i]) {
        room.players[i].chips = 3;
        room.players[i].eliminated = false;
      }
    }
    
    room.currentPlayer = 0;
    room.centerPot = 0;
    room.gameState = "playing";
    
    io.to(roomId).emit("gameReset", {
      currentPlayer: 0,
      chips: room.players.map(p => p ? p.chips : 0)
    });
    
    console.log(`🔄 Game reset in ${roomId}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Thousanaire server running on port ${PORT}`);
  console.log(`📱 Test at: http://localhost:${PORT}`);
  console.log(`🌐 Render: https://thousanaire-server.onrender.com`);
});
