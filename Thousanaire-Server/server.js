const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

/* ============================================================
   FIX: Backend should NOT serve index.html
   (Prevents ENOENT crash on Render)
   ============================================================ */

app.get("/", (req, res) => {
  res.send("Thousanaire server is running.");
});

console.log("🚀 Backend running without static file serving");

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

  if (player.chips <= 0 && !player.eliminated) {
    player.eliminated = true;
    io.to(roomId).emit("playerEliminated", {
      seat,
      name: player.name,
    });
  }

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

  room.currentPlayer = getNextSeat(room, seat);
  broadcastState(roomId);
}

/* ============================================================
   WILD LOGIC (auto‑resolve already correct)
   ============================================================ */

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
        }
      });
    }
    finalizeTurn(roomId, seat);
    return;
  }

  // NEW FORMAT (kept for compatibility)
  const canceledIndices = new Set(cancels || []);

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

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      for (let seat = 0; seat < 4; seat++) {
        if (room.players[seat] && room.players[seat].socketId === socket.id) {
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

    broadcastState(roomId);

    if (room.seatedCount === 4) {
      room.gameState = "playing";
      room.currentPlayer = 0;
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

    const diceFaces = ["Dottt", "Dottt", "Dottt", "Left", "Right", "Wild", "Hub"];
    const rollResults = [];

    for (let i = 0; i < 3; i++) {
      rollResults.push(
        diceFaces[Math.floor(Math.random() * diceFaces.length)]
      );
    }

    const outcomesText = rollResults.join(", ");

    io.to(roomId).emit("rollResult", {
      seat,
      outcomes: rollResults,
      outcomesText,
    });

    let dots = rollResults.filter((r) => r === "Dottt").length;
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
      io.to(roomId).emit("requestWildChoice", {
        seat,
        outcomes: rollResults,
      });
    } else {
      applyWildActions(roomId, seat, rollResults);
    }

    broadcastState(roomId);
  });

  /* ============================================================
     AUTO‑RESOLVE WILDS
     ============================================================ */

  socket.on("resolveWilds", ({ roomId, actions }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = room.currentPlayer;

    applyWildActions(roomId, seat, actions);

    broadcastState(roomId);
  });

  /* ============================================================
     TRIPLE WILD CHOICE
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
  });
});

/* ============================================================
   SERVER START
   ============================================================ */

server.listen(PORT, () => {
  console.log(`🚀 Thousanaire server running on port ${PORT}`);
});
