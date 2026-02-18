const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

// Create a basic HTTP server so Render keeps the service alive
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WebSocket server is running");
});

// Attach WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });

let rooms = {}; // { roomId: { players: [], state: {} } }

function createRoom() {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms[id] = { players: [], state: {} };
  return id;
}

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    // Create room
    if (data.type === "createRoom") {
      const roomId = createRoom();
      ws.roomId = roomId;
      rooms[roomId].players.push(ws);

      ws.send(JSON.stringify({ type: "roomCreated", roomId }));
    }

    // Join room
    if (data.type === "joinRoom") {
      const room = rooms[data.roomId];
      if (!room) {
        return ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
      }
      if (room.players.length >= 4) {
        return ws.send(JSON.stringify({ type: "error", message: "Room full" }));
      }

      ws.roomId = data.roomId;
      room.players.push(ws);

      room.players.forEach((p) =>
        p.send(
          JSON.stringify({
            type: "playerJoined",
            count: room.players.length,
          })
        )
      );
    }

    // Broadcast updates
    if (data.type === "update") {
      const room = rooms[ws.roomId];
      if (!room) return;

      room.players.forEach((p) => {
        if (p !== ws)
          p.send(
            JSON.stringify({
              type: "update",
              payload: data.payload,
            })
          );
      });
    }
  });

  ws.on("close", () => {
    const room = rooms[ws.roomId];
    if (!room) return;

    room.players = room.players.filter((p) => p !== ws);

    if (room.players.length === 0) delete rooms[ws.roomId];
  });
});

// Start the HTTP server (this keeps Render from killing your app)
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
