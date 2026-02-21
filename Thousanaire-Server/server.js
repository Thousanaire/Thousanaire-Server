const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

/* ============================================================
   BACKEND ONLY – NO FRONTEND SERVING
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

  // GRACE LOGIC
  if (player.chips <= 0) {
    if (!player.onGrace && !player.eliminated) {
      player.onGrace = true;
      io.to(roomId).emit("playerGrace", {
        seat,
        name: player.name,
      });
    } else if (player.onGrace && !player.eliminated) {
      player.eliminated = true;
      player.onGrace = false;
      io.to(roomId).emit("playerEliminated", {
        seat,
        name: player.name,
      });
    }
  } else {
    if (player.onGrace) {
      player.onGrace = false;
    }
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
   WILD / OUTCOME LOGIC (CORRECTED)
   ============================================================ */

function applyOutcomesOnlyServer(roomId, seat, outcomes) {
  const room = rooms[roomId];
  if (!room) return;
  const player = room.players[seat];
  if (!player) return;

  outcomes.forEach((o) => {
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
   CORRECTED WILD LOGIC (DROP‑IN REPLACEMENT)
   ============================================================ */

function applyWildActionsFromActions(roomId, seat, actions) {
  const room = rooms[roomId];
  if (!room) return;
  const player = room.players[seat];
  if (!player) return;

  const lastRoll =
    room.lastRoll && room.lastRoll.seat === seat
      ? room.lastRoll.outcomes
      : null;

  if (!lastRoll) {
    finalizeTurn(roomId, seat);
    return;
  }

  const outcomes = lastRoll.slice();

  const wildIndices = outcomes
    .map((o, i) => (o === "Wild" ? i : null))
    .filter((i) => i !== null);

  const canceledIndices = new Set();
  const wildUsedAsCancel = new Set();
  const wildUsedAsSteal = new Set();

  actions.forEach((a) => {
    if (!a) return;

    if (a.type === "cancel") {
      const target = a.target;
      const idx = outcomes.findIndex(
        (o, i) => o === target && !canceledIndices.has(i)
      );
      if (idx !== -1) {
        canceledIndices.add(idx);
        if (typeof a.wildIndex === "number") {
          wildUsedAsCancel.add(a.wildIndex);
        }
      }
    }

    if (a.type === "steal") {
      const fromSeat = a.from;
      const target = room.players[fromSeat];

      if (target && target.chips > 0) {
        target.chips--;
        player.chips++;

        io.to(roomId).emit("chipTransfer", {
          fromSeat,
          toSeat: seat,
          type: "steal",
        });

        if (typeof a.wildIndex === "number") {
          wildUsedAsSteal.add(a.wildIndex);
        }
      }
    }
  });

  outcomes.forEach((o, i) => {
    if (canceledIndices.has(i)) return;

    if (wildIndices.includes(i)) {
      if (wildUsedAsCancel.has(i)) return;
      if (wildUsedAsSteal.has(i)) return;
      return;
    }

    if (o === "Left" && player.chips > 0) {
      const leftSeat = getNextSeat(room, seat);
      player.chips--;
      room.players[leftSeat].chips++;
      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: leftSeat,
        type: "left",
      });
    }

    if (o === "Right" && player.chips > 0) {
      const rightSeat = getNextSeat(room, seat + 2);
      player.chips--;
      room.players[rightSeat].chips++;
      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: rightSeat,
        type: "right",
      });
    }

    if (o === "Hub" && player.chips > 0) {
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
   MAIN WILD ENTRY
   ============================================================ */

function applyWildActions(roomId, seat, outcomesOrActions) {
  if (Array.isArray(outcomesOrActions)) {
    applyOutcomesOnlyServer(roomId, seat, outcomesOrActions);
  } else {
    const actions = outcomesOrActions;
    if (!Array.isArray(actions)) {
      finalizeTurn(roomId, seat);
      return;
    }
    applyWildActionsFromActions(roomId, seat, actions);
  }
}

/* ============================================================
   SOCKET.IO CONNECTION HANDLING
   ============================================================ */

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("disconnect", () => {
    const DISCONNECT_TIMEOUT_MS = 30 * 60 * 1000;

    setTimeout(() => {
      for (const roomId in rooms) {
        const room = rooms[roomId];
        for (let seat = 0; seat < 4; seat++) {
          const p = room.players[seat];
          if (p && p.socketId === socket.id) {
            if (p.socketId === socket.id) {
              room.players[seat] = null;
              room.seatedCount = Math.max(0, room.seatedCount - 1);
              broadcastState(roomId);
            }
            break;
          }
        }
      }
    }, DISCONNECT_TIMEOUT_MS);
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
      lastRoll: null,
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
      onGrace: false,
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

    const diceToRoll = Math.min(player.chips, 3);
    if (diceToRoll <= 0) {
      finalizeTurn(roomId, seat);
      broadcastState(roomId);
      return;
    }

    for (let i = 0; i < diceToRoll; i++) {
      rollResults.push(
        diceFaces[Math.floor(Math.random() * diceFaces.length)]
      );
    }

    const outcomesText = rollResults.join(", ");

    room.lastRoll = { seat, outcomes: rollResults };

    io.to(roomId).emit("rollResult", {
      seat,
      outcomes: rollResults,
      outcomesText,
    });

    let dots = rollResults.filter((r) => r === "Dottt").length;
    if (dots > 0 && player.chips > 0) {
      const chipsToGain = Math.min(dots, 3 - player.chips);
      if (chipsToGain > 0) {
        player.chips += chipsToGain;
        io.to(roomId).emit("chipsGained", {
          seat,
          count: chipsToGain,
        });
      }
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
     RESOLVE WILDS — ⭐ FIXED ⭐
     ============================================================ */

  socket.on("resolveWilds", ({ roomId, seat, actions }) => {
    const room = rooms[roomId];
    if (!room) return;

    // ⭐ FIX: Use the correct Wild-action engine
    applyWildActionsFromActions(roomId, seat, actions);

    broadcastState(roomId);
  });

  /* ============================================================
     TRIPLE WILD CHOICE — ⭐ PATCHED ⭐
     ============================================================ */

  socket.on("tripleWildChoice", ({ roomId, seat, choice }) => {
    const room = rooms[roomId];
    if (!room) return;

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
        room.players[i].onGrace = false;
      }
    }

    room.currentPlayer = 0;
    room.centerPot = 0;
    room.gameState = "playing";
    room.lastRoll = null;

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
