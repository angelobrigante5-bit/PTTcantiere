const http    = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 256 * 1024   // 256KB — sufficiente per chunk 44100Hz
});

app.get("/",     (_, res) => res.send("PTT SERVER ONLINE ✅"));
app.get("/ping", (_, res) => res.send("pong"));

// ══════════════════════════════════════════════════════════════
//  STATO — solo chi è in quale stanza, nessun lock speaker
// ══════════════════════════════════════════════════════════════
function getUsersInRoom(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    return room ? room.size : 0;
}

function emitUsers(roomId) {
    io.to(roomId).emit("users", { count: getUsersInRoom(roomId) });
}

// ══════════════════════════════════════════════════════════════
//  CONNESSIONI
// ══════════════════════════════════════════════════════════════
io.on("connection", (socket) => {

    console.log("🔥 CONNESSO:", socket.id);
    socket.data.roomId = null;
    socket.data.name   = "?";

    // ── JOIN ──────────────────────────────────────────────────
    socket.on("join", (payload) => {
        const roomId = typeof payload === "string" ? payload : payload.roomId;
        const name   = typeof payload === "object"  ? (payload.name || "?") : "?";

        if (socket.data.roomId && socket.data.roomId !== roomId) {
            socket.leave(socket.data.roomId);
            setTimeout(() => emitUsers(socket.data.roomId), 100);
        }

        socket.data.roomId = roomId;
        socket.data.name   = name;
        socket.join(roomId);

        console.log(`JOIN: ${name} → ${roomId}`);
        emitUsers(roomId);
        socket.emit("status", "ONLINE");

        // Avvisa tutti nella stanza che è entrato qualcuno
        socket.to(roomId).emit("user_joined", { name });
    });

    // ── LEAVE ─────────────────────────────────────────────────
    socket.on("leave", (roomId) => {
        socket.leave(roomId);
        setTimeout(() => emitUsers(roomId), 100);
    });

    socket.on("request_users", () => {
        if (socket.data.roomId) emitUsers(socket.data.roomId);
    });

    // ══════════════════════════════════════════════════════════
    //  AUDIO FULL-DUPLEX
    //  Chiunque manda audio — il server lo broadcast a tutti
    //  gli altri nella stessa stanza. Nessun lock, nessuna coda.
    // ══════════════════════════════════════════════════════════
    socket.on("audio_chunk", (chunk) => {
        const { roomId } = socket.data;
        if (!roomId) return;
        // Rimanda a tutti gli altri (non al mittente — evita echo)
        socket.to(roomId).emit("audio_chunk", chunk);
    });

    // ── DISCONNECT ────────────────────────────────────────────
    socket.on("disconnect", () => {
        const { roomId, name } = socket.data;
        console.log(`❌ DISCONNECT: ${name} (${socket.id})`);

        if (roomId) {
            socket.to(roomId).emit("user_left", { name });
            setTimeout(() => emitUsers(roomId), 300);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 PTT SERVER ON PORT ${PORT}`);
});
