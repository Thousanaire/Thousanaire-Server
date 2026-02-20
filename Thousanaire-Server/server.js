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

// 🚀 COMPLETE FIXED SERVER - MOBILE FRIENDLY + IMMORTAL PLAYERS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 1200000, // 20 minutes before disconnect
  pingInterval: 25000,  
  connectTimeout: 10000 
});

const PORT = process.env.PORT || 10000;
let rooms = {};

// Auto-clean empty rooms after 5 minutes
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const seatedCount = room.players.filter(p => p !== null).length;
    if (seatedCount === 0 && !room.gameStarted) {
      console.log(`🧹 Auto-cleaning empty room: ${roomId}`);
      delete rooms[roomId];
    }
  }
}, 5 * 60 * 1000);

io.on("connection", (socket) => {
  console.log(`🔌 CONNECT: ${socket.id}`);

  // CREATE ROOM
  socket.on("createRoom", ({ roomId, playerName }) => {
    console.log(`🏠 CREATE: ${playerName} creates ${roomId}`);
    
    rooms[roomId] = {
      players: [null, null, null, null],
      currentPlayer: 0,
      gameStarted: false,
      hostSocketId: socket.id
    };
    
    rooms[roomId].players[0] = {
      name: playerName,
      socketId: socket.id,
      chips: 0,
      eliminated: false
    };
    
    socket.join(roomId);
    socket.emit("roomCreated", { roomId, mySeat: 0 });
    io.to(roomId).emit("roomUpdate", getRoomState(roomId));
  });

  // JOIN ROOM
  socket.on("joinRoom", ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    const seat = room.players.findIndex(p => p === null);
    if (seat === -1) {
      socket.emit("error", { message: "Room full" });
      return;
    }

    room.players[seat] = {
      name: playerName,
      socketId: socket.id,
      chips: 0,
      eliminated: false
    };

    socket.join(roomId);
    console.log(`👤 ${playerName} joined ${roomId} (seat ${seat})`);
    
    socket.emit("joinedRoom", { roomId, mySeat: seat });
    io.to(roomId).emit("roomUpdate", getRoomState(roomId));
  });

  // 🎯 ROLL BUTTON FIX + FULL TURN LOGIC
  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.currentPlayer === undefined) return;
    
    const player = room.players[room.currentPlayer];
    if (!player || player.eliminated) return;
    
    console.log(`🎲 ${player.name} (seat ${room.currentPlayer}) ROLLING...`);
    
    // Roll 3 dice
    const diceFaces = ["Dot", "Dot", "Dot", "Left", "Right", "Wild", "Hub"];
    const rollResults = [];
    
    for (let i = 0; i < 3; i++) {
      rollResults.push(diceFaces[Math.floor(Math.random() * diceFaces.length)]);
    }
    
    // 🎯 BROADCAST DICE ROLL + FULL STATE
    io.to(roomId).emit("playerTurn", {
      currentPlayer: room.currentPlayer,
      chips: room.players.map(p => p ? p.chips : 0),
      gameStarted: true
    });
    
    io.to(roomId).emit("diceRoll", {
      seat: room.currentPlayer,
      results: rollResults
    });
    
    console.log(`🎲 Roll: ${rollResults.join(", ")}`);
    
    // HANDLE DOTS (gain chips)
    const dots = rollResults.filter(r => r === "Dot").length;
    if (dots > 0 && player.chips < 3) {
      const chipsToGain = Math.min(dots, 3 - player.chips);
      player.chips += chipsToGain;
      io.to(roomId).emit("chipsGained", { 
        seat: room.currentPlayer, 
        count: chipsToGain 
      });
    }
    
    // 🎯 PERFECT WILD + HUB LOGIC
    const wildCount = rollResults.filter(r => r === "Wild").length;
    const leftCount = rollResults.filter(r => r === "Left").length;
    const rightCount = rollResults.filter(r => r === "Right").length;
    const hubCount = rollResults.filter(r => r === "Hub").length;
    
    if (wildCount > 0) {
      // Wild: Player chooses action
      io.to(roomId).emit("wildActions", { 
        seat: room.currentPlayer, 
        outcomes: rollResults 
      });
    } else {
      // Auto-apply directional actions
      applyDirectionalActions(roomId, rollResults);
    }
  });

  // START GAME
  socket.on("startGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostSocketId !== socket.id) return;
    
    room.gameStarted = true;
    io.to(roomId).emit("gameStarted", { 
      currentPlayer: 0,
      chips: room.players.map(p => p ? p.chips : 0),
      gameStarted: true 
    });
  });

  // WILD ACTION COMPLETE → NEXT TURN
  socket.on("wildActionComplete", ({ roomId, action }) => {
    console.log(`🎯 Wild action complete: ${action}`);
    nextPlayer(roomId);
  });

  // 🎯 TRUE IMMORTAL DISCONNECT - Screen timeouts DON'T unseat
  socket.on("disconnect", (reason) => {
    console.log(`🔌 DISCONNECT: ${socket.id} (${reason})`);
    
    // 🛡️ IMMORTAL: Ignore ALL timeouts/screen locks
    if (reason.includes("timeout") || reason.includes("ping") || 
        reason === "transport close" || reason === "io server disconnect") {
      console.log(`🛡️ IMMORTAL MODE: ${socket.id} stays seated (${reason})`);
      return;  // STAYS SEATED FOREVER!
    }
    
    // ONLY deliberate browser close unseats
    for (const roomId in rooms) {
      const room = rooms[roomId];
      for (let seat = 0; seat < 4; seat++) {
        if (room.players[seat] && room.players[seat].socketId === socket.id) {
          console.log(`👤 "${room.players[seat].name}" unseated from seat ${seat}`);
          room.players[seat] = null;
          io.to(roomId).emit("roomUpdate", getRoomState(roomId));
          break;
        }
      }
    }
  });
});

// 🔄 PERFECT CLOCKWISE TURN ROTATION (SKIPS ELIMINATED)
function nextPlayer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  
  let attempts = 0;
  do {
    room.currentPlayer = (room.currentPlayer + 1) % 4;
    attempts++;
  } while (room.players[room.currentPlayer]?.eliminated && attempts < 4);
  
  console.log(`🔄 Next player: seat ${room.currentPlayer} (${room.players[room.currentPlayer]?.name || 'EMPTY'})`);
  
  io.to(roomId).emit("playerTurn", {
    currentPlayer: room.currentPlayer,
    chips: room.players.map(p => p ? p.chips : 0),
    gameStarted: true
  });
}

// 🎯 DIRECTIONAL ACTIONS (Left/Right/Hub)
function applyDirectionalActions(roomId, rollResults) {
  const room = rooms[roomId];
  if (!room) return;
  
  const currentSeat = room.currentPlayer;
  let targetSeat = currentSeat;
  
  // Hub: Everyone loses 1 chip (if they have any)
  const hubCount = rollResults.filter(r => r === "Hub").length;
  if (hubCount > 0) {
    console.log(`🌐 HUB ATTACK! Everyone loses 1 chip`);
    room.players.forEach((player, seat) => {
      if (player && player.chips > 0) {
        player.chips = Math.max(0, player.chips - 1);
        io.to(roomId).emit("chipsLost", { seat, count: 1 });
      }
    });
  }
  
  // Left/Right: Steal chips from neighbor
  const leftCount = rollResults.filter(r => r === "Left").length;
  const rightCount = rollResults.filter(r => r === "Right").length;
  
  if (leftCount > 0) {
    targetSeat = (currentSeat - 1 + 4) % 4; // Previous player
  } else if (rightCount > 0) {
    targetSeat = (currentSeat + 1) % 4; // Next player
  }
  
  const targetPlayer = room.players[targetSeat];
  if (targetPlayer && targetPlayer.chips > 0) {
    const chipsStolen = Math.min(1, targetPlayer.chips);
    targetPlayer.chips -= chipsStolen;
    room.players[currentSeat].chips += chipsStolen;
    
    io.to(roomId).emit("chipsStolen", { 
      fromSeat: targetSeat, 
      toSeat: currentSeat, 
      count: chipsStolen 
    });
  }
  
  setTimeout(() => nextPlayer(roomId), 1500);
}

// HELPERS
function getRoomState(roomId) {
  const room = rooms[roomId];
  return {
    players: room.players.map(p => p ? { 
      name: p.name, 
      chips: p.chips, 
      eliminated: p.eliminated 
    } : null),
    currentPlayer: room.currentPlayer,
    gameStarted: room.gameStarted
  };
}

server.listen(PORT, () => {
  console.log(`🎮 Server running on port ${PORT}`);
});
