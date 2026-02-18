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

// Store rooms and game states
let rooms = {}; 
// rooms = { roomId: { players: [], state: {} } }

function createRoom() {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms[id] = { players: [], state: {} };
  return id;
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Create room
  socket.on("createRoom", () => {
    const roomId = createRoom();
    socket.join(roomId);

    rooms[roomId].players.push(socket.id);

    socket.emit("roomCreated", { roomId });
    console.log("Room created:", roomId);
  });

  // Join room
  socket.on("joinRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    if (room.players.length >= 4) {
      socket.emit("errorMessage", "Room is full");
      return;
    }

    socket.join(roomId);
    room.players.push(socket.id);

    io.to(roomId).emit("playerJoined", {
      count: room.players.length
    });

    console.log(`Player ${socket.id} joined room ${roomId}`);
  });

  // Receive game state updates from a client
  socket.on("updateState", ({ roomId, state }) => {
    if (!rooms[roomId]) return;

    rooms[roomId].state = state;

    // Broadcast to everyone else in the room
    socket.to(roomId).emit("stateUpdate", state);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const roomId in rooms) {
      const room = rooms[roomId];
      room.players = room.players.filter(id => id !== socket.id);

      if (room.players.length === 0) {
        delete rooms[roomId];
        console.log("Room deleted:", roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
