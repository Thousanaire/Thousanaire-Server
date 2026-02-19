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

function handleZeroChipsOnTurn(roomId, seat) {
  const room = rooms[roomId];
  const player = room.players[seat];
  if (!player) return;

  if (player.chips === 0) {
    if (player.danger) {
      player.eliminated = true;
    } else {
      player.danger = true;
    }
  }

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
    return true;
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
    // Host gets roomCreated (client shows alert + hides overlay)
    socket.emit("roomCreated", { roomId });
    console.log("Room created:", roomId);
  });

  /* ---------------- JOIN ROOM (code from overlay) ---------------- */
  socket.on("joinRoom", ({ roomId }) => {
    // Normalize the room code a bit to be forgiving
    const raw = (roomId || "").trim().toUpperCase();
    const direct = rooms[raw] ? raw : null;

    if (!direct) {
      socket.emit("errorMessage", "Room not found");
      console.log("JoinRoom failed. Requested:", roomId, "Existing:", Object.keys(rooms));
      return;
    }

    const room = rooms[direct];
    const seatsTaken = Object.values(room.players).filter(p => p !== null).length;
    if (seatsTaken >= 4) {
      socket.emit("errorMessage", "Room is full");
      return;
    }

    socket.join(direct);
    // This is the event your original client was using for host after create,
    // but we'll use it as the "you are in the lobby, now fill name/avatar/color"
    socket.emit("roomJoined", { roomId: direct });
    console.log(`Client ${socket.id} joined room lobby:`, direct);
  });

  /* ---------------- JOIN SEAT (ONE-TIME) ---------------- */
  socket.on("joinSeat", ({ roomId, name, avatar, color }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    // Prevent same socket from joining multiple seats
    const existingSeat = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (existingSeat) {
      socket.emit("errorMessage", "You already joined this game.");
      return;
    }

    // First player (host) gets seat 0 (top), others clockwise 1,2,3
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

    // Dedicated seat event so client can set mySeat
    socket.emit("joinedRoom", { roomId, seat });

    broadcastState(roomId);
    console.log(`Player ${name} seated at ${seat} in room ${roomId}`);
  });

  /* ---------------- ROLL DICE ---------------- */
  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seatEntry = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (!seatEntry) return;

    const playerSeat = parseInt(seatEntry[0]);
    if (playerSeat !== room.currentPlayer) return;

    const player = room.players[playerSeat];
    if (player.eliminated) return;

    // If player has 0 chips at start of turn, handle danger/elimination
    if (player.chips === 0) {
      const ended = handleZeroChipsOnTurn(roomId, playerSeat);
      if (!ended) {
        // Turn passed; no roll
      }
      return;
    }

    room.gameStarted = true;

    const numDice = Math.min(player.chips, 3);
    const faces = ["Left", "Right", "Hub", "Dottt", "Wild"];
    const outcomes = [];

    for (let i = 0; i < numDice; i++) {
      outcomes.push(faces[Math.floor(Math.random() * faces.length)]);
    }

    // Tell clients to animate dice + history
    io.to(roomId).emit("rollResult", {
      seat: playerSeat,
      outcomes,
      outcomesText: outcomes.join(", ")
    });

    const wildCount = outcomes.filter(o => o === "Wild").length;

    if (wildCount === 3) {
      io.to(player.socketId).emit("requestTripleWildChoice", {
        roomId,
        seat: playerSeat
      });
      return;
    }

    if (wildCount > 0) {
      io.to(player.socketId).emit("requestWildChoice", {
        roomId,
        seat: playerSeat,
        outcomes
      });
      return;
    }

    applyOutcomes(roomId, playerSeat, outcomes);
  });

  /* ---------------- RESOLVE NORMAL WILDS ---------------- */
  socket.on("resolveWilds", ({ roomId, actions }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seatEntry = Object.entries(room.players)
      .find(([s, p]) => p && p.socketId === socket.id);
    if (!seatEntry) return;

    const playerSeat = parseInt(seatEntry[0]);
    applyWildActions(roomId, playerSeat, actions);
  });

  /* ---------------- TRIPLE WILD CHOICE ---------------- */
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

      // OPTIONAL: keep rooms instead of deleting; comment out delete if you want codes to persist
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

      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: leftSeat,
        type: "left"
      });
    }
    if (o === "Right" && player.chips > 0) {
      const rightSeat = getNextSeat(room, seat - 2);
      player.chips--;
      room.players[rightSeat].chips++;

      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: rightSeat,
        type: "right"
      });
    }
    if (o === "Hub" && player.chips > 0) {
      player.chips--;
      room.centerPot++;

      io.to(roomId).emit("chipTransfer", {
        fromSeat: seat,
        toSeat: null,
        type: "hub"
      });
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
    if (a.type === "cancel") {
      // Cancel is implicit: we just don't apply that outcome
    }
    if (a.type === "steal") {
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

  finalizeTurn(roomId, seat);
}

function applyTripleWild(roomId, seat, choice) {
  const room = rooms[roomId];
  const player = room.players[seat];

  if (choice.type === "takePot") {
    if (room.centerPot > 0) {
      player.chips += room.centerPot;

      io.to(roomId).emit("chipTransfer", {
        fromSeat: null,
        toSeat: seat,
        type: "takePot"
      });
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

        io.to(roomId).emit("chipTransfer", {
          fromSeat: i,
          toSeat: seat,
          type: "steal3"
        });
      }
    }
  }

  finalizeTurn(roomId, seat);
}

function finalizeTurn(roomId, seat) {
  const room = rooms[roomId];
  const player = room.players[seat];

  if (player.chips === 0) {
    if (player.danger) {
      player.eliminated = true;
    } else {
      player.danger = true;
    }
  } else {
    player.danger = false;
  }

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

  room.currentPlayer = getNextSeat(room, seat);
  broadcastState(roomId);
}

/* ============================================================
   START SERVER
   ============================================================ */

server.listen(PORT, () => {
  console.log(`Authoritative game server running on port ${PORT}`);
});
