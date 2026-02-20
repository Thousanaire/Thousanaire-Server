const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Serve frontend from project root
app.use(express.static(__dirname));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

console.log("🚀 Serving files from:", __dirname);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 1200000,
  pingInterval: 25000,
  connectTimeout: 10000,
});

const PORT = process.env.PORT || 10000;

let rooms = {};

/* ============================================================
   ROOM / ID HELPERS
   ============================================================ */

function createRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* ============================================================
   GAME HELPERS
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
  return Object.values(room.players).filter((p) => p && p.chips > 0).length;
}

function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const players = room.players.map((p) => (p ? p.name : null));
  const chips = room.players.map((p) => (p ? p.chips : 0));
  const avatars = room.players.map((p) => (p ? p.avatar : null));
  const colors = room.players.map((p) => (p ? p.color : null));
  const eliminated = room.players.map((p) => (p ? !!p.eliminated : false));
  const danger = room.players.map((p) => (p ? p.chips === 1 : false));

  const state = {
    players,
    chips,
    avatars,
    colors,
    eliminated,
    danger,
    centerPot: room.centerPot || 0,
    currentPlayer: room.gameState === "playing" ? room.currentPlayer : null,
    gameStarted: room.gameState === "playing",
  };

  io.to(roomId).emit("stateUpdate", state);
}

function finalizeTurn(roomId, seat) {
  const room = rooms[roomId];
  if (!room) return;

  const player = room.players[seat];
  if (!player) return;

  // Eliminate player if no chips
  if (player.chips <= 0 && !player.eliminated) {
    player.eliminated = true;
    console.log(`🎲 Player ${player.name} eliminated`);
    io.to(roomId).emit("playerEliminated", {
      seat,
      name: player.name,
    });
  }

  // Check win condition
  const activePlayers = countPlayersWithChips(room);
  if (activePlayers <= 1) {
    let winnerSeat = null;
    let winnerName = null;
    for (let i = 0; i < 4; i++) {
      if (room.players[i] && room.players[i].chips > 0) {
        winnerSeat = i;
        winnerName = room.players[i].name;
        break;
      }
    }

    io.to(roomId).emit("gameOver", {
      winnerSeat,
      winnerName,
      pot: room.centerPot || 0,
    });
    return;
  }

  // Move to next player
  room.currentPlayer = getNextSeat(room, seat);

  // Broadcast updated state
  broadcastState(roomId);
}

/* 🔥 WILD LOGIC - OLD CLIENT FORMAT (actions array) + NEW FORMAT BACKUP */
function applyWildActions(roomId, seat, outcomes, cancels = [], steals = []) {
  const room = rooms[roomId];
  if (!room) return;

  const player = room.players[seat];
  if (!player) return;

  // OLD FORMAT: outcomes is actually actions array
  if (!Array.isArray(outcomes)) {
    const actions = outcomes;
    if (Array.isArray(actions)) {
      actions.forEach((a) => {
        if (a && a.type === "steal") {
          const target = room.players[a.from];
          if (target && target.chips > 0) {
            target.chips--;
            player.chips++;
            io.to(roomId).emit("chipTransfer", {
              fromSeat: a.from,
              toSeat: seat,
              type: "steal",
            });
          }
        } else if (a && a.type === "cancel") {
          // client-side cancel just prevents some Left/Right/Hub; here we do nothing extra
        }
      });
    }
    finalizeTurn(roomId, seat);
    return;
  }

  // NEW FORMAT (kept for compatibility, not used by current client)
  const canceledIndices = new Set(cancels || []);

  // 1) Apply steals first
  steals.forEach((s) => {
    const target = room.players[s.from];
    if (target && target.chips > 0) {
      target.chips--;
      player.chips++;
      io.to(roomId).emit("chipTransfer", {
        fromSeat: s.from,
        toSeat: seat,
        type: "steal",
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
      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: leftSeat,
        type: "left",
      });
    } else if (o === "Right" && player.chips > 0) {
      const rightSeat = getNextSeat(room, seat + 2);
      player.chips--;
      room.players[rightSeat].chips++;
      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: rightSeat,
        type: "right",
      });
    } else if (o === "Hub" && player.chips > 0) {
      player.chips--;
      room.centerPot = (room.centerPot || 0) + 1;
      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: null,
        type: "hub",
      });
    }
  });

  io.to(roomId).emit("historyEntry", {
    playerName: player.name,
    outcomesText: outcomes.join(", "),
  });

  finalizeTurn(roomId, seat);
}

/* ============================================================
   SOCKET.IO CONNECTION HANDLING
   ============================================================ */

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Disconnect cleanup
  socket.on("disconnect", (reason) => {
    console.log(`🔌 DISCONNECT: ${socket.id} (${reason})`);

    for (const roomId in rooms) {
      const room = rooms[roomId];
      for (let seat = 0; seat < 4; seat++) {
        if (
          room.players[seat] &&
          room.players[seat].socketId === socket.id
        ) {
          console.log(
            `👤 Player "${room.players[seat].name}" unseated from seat ${seat} in ${roomId}`
          );
          room.players[seat] = null;
          room.seatedCount = Math.max(0, room.seatedCount - 1);
          broadcastState(roomId);
          break;
        }
      }
    }
  });

  /* ============================================================
     ROOM FLOW
     ============================================================ */

  socket.on("createRoom", () => {
    const roomId = createRoomId();
    rooms[roomId] = {
      id: roomId,
      players: [null, null, null, null],
      seatedCount: 0,
      currentPlayer: 0,
      centerPot: 0,
      gameState: "waiting",
    };

    socket.join(roomId);
    socket.emit("roomCreated", { roomId });
    console.log(`🏠 Room created: ${roomId}`);
  });

  socket.on("joinRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    socket.join(roomId);
    socket.emit("roomJoined", {
      roomId,
      players: room.players.map((p) =>
        p ? { name: p.name, chips: p.chips } : null
      ),
      seatedCount: room.seatedCount,
    });

    console.log(
      `👥 Client entered lobby: ${roomId} (${room.seatedCount}/4 seated)`
    );
  });

  socket.on("joinSeat", ({ roomId, name, avatar, color }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    const openSeat = room.players.findIndex((p) => p === null);
    if (openSeat === -1) {
      socket.emit("errorMessage", "Room full");
      return;
    }

    room.players[openSeat] = {
      name: name.substring(0, 12),
      socketId: socket.id,
      avatar: avatar || null,
      color: color || null,
      chips: 3,
      eliminated: false,
    };
    room.seatedCount++;

    socket.join(roomId);
    socket.emit("joinedRoom", { roomId, seat: openSeat });

    io.to(roomId).emit("playerUpdate", {
      players: room.players.map((p) =>
        p
          ? {
              name: p.name,
              chips: p.chips,
              avatar: p.avatar,
              color: p.color,
            }
          : null
      ),
      seatedCount: room.seatedCount,
    });

    console.log(
      `✅ "${name}" seated at ${openSeat} (${room.seatedCount}/4) in ${roomId}`
    );

    // Always broadcast full state so names/avatars show up
    broadcastState(roomId);

    // Start game when 4 seated
    if (room.seatedCount === 4) {
      room.gameState = "playing";
      room.currentPlayer = 0;
      room.centerPot = room.centerPot || 0;

      console.log(`🎮 Game started in ${roomId}`);
      broadcastState(roomId);
    }
  });

  /* ============================================================
     ROLL DICE
     ============================================================ */

  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.currentPlayer === undefined) return;

    const seat = room.currentPlayer;
    const player = room.players[seat];
    if (!player || player.eliminated) return;

    console.log(`🎲 ${player.name} (seat ${seat}) ROLLING...`);

    const diceFaces = ["Dottt", "Dottt", "Dottt", "Left", "Right", "Wild", "Hub"];
    const rollResults = [];

    for (let i = 0; i < 3; i++) {
      rollResults.push(
        diceFaces[Math.floor(Math.random() * diceFaces.length)]
      );
    }

    const outcomesText = rollResults.join(", ");

    // Send roll result to all
    io.to(roomId).emit("rollResult", {
      seat,
      outcomes: rollResults,
      outcomesText,
    });

    console.log(
      `🎲 Roll results for ${player.name}: ${outcomesText}`
    );

    // Apply dots first
    let dots = rollResults.filter((r) => r === "Dot").length;
    if (dots > 0 && player.chips > 0) {
      const chipsToGain = Math.min(dots, 3 - player.chips);
      player.chips += chipsToGain;
      io.to(roomId).emit("chipsGained", {
        seat,
        count: chipsToGain,
      });
    }

    const wildCount = rollResults.filter((r) => r === "Wild").length;

    if (wildCount > 0) {
      // Ask client to choose wild actions (old format)
      io.to(roomId).emit("requestWildChoice", {
        seat,
        outcomes: rollResults,
      });
    } else {
      // No wilds: apply standard Left/Right/Hub immediately
      applyWildActions(roomId, seat, rollResults);
    }

    broadcastState(roomId);
  });

  /* ============================================================
     RESOLVE WILDS (old client format: actions array)
     ============================================================ */

  socket.on("resolveWilds", ({ roomId, actions }) => {
    const room = rooms[roomId];
    if (!room) return;
    const seat = room.currentPlayer;
    console.log(
      `🧠 Resolving wilds for seat ${seat} in ${roomId}:`,
      actions
    );
    applyWildActions(roomId, seat, actions);
    broadcastState(roomId);
  });

  /* ============================================================
     TRIPLE WILD CHOICE (optional, used by your client)
     ============================================================ */

  socket.on("tripleWildChoice", ({ roomId, choice }) => {
    const room = rooms[roomId];
    if (!room) return;
    const seat = room.currentPlayer;
    const player = room.players[seat];
    if (!player) return;

    if (choice.type === "takePot") {
      const pot = room.centerPot || 0;
      player.chips += pot;
      room.centerPot = 0;
    } else if (choice.type === "steal3") {
      let remaining = 3;
      for (let i = 0; i < 4 && remaining > 0; i++) {
        if (i === seat) continue;
        const target = room.players[i];
        if (target && target.chips > 0) {
          target.chips--;
          player.chips++;
          remaining--;
          io.to(roomId).emit("chipTransfer", {
            fromSeat: i,
            toSeat: seat,
            type: "steal",
          });
        }
      }
    }

    finalizeTurn(roomId, seat);
    broadcastState(roomId);
  });

  /* ============================================================
     RESET GAME
     ============================================================ */

  socket.on("resetGame", ({ roomId }) => {
    const room = rooms[roomId];
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

    io.to(roomId).emit("resetGame");
    broadcastState(roomId);

    console.log(`🔄 Game reset in ${roomId}`);
  });
});

/* ============================================================
   SERVER START
   ============================================================ */

server.listen(PORT, () => {
  console.log(`🚀 Thousanaire server running on port ${PORT}`);
  console.log(`📱 Test at: http://localhost:${PORT}`);
  console.log(`🌐 Render: https://thousanaire-server.onrender.com`);
});

