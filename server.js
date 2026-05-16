const http    = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 64 * 1024,   // 64KB — sufficiente per chunk 16000Hz
    // Riduce overhead di trasporto: preferisce WebSocket diretto, salta polling
    transports: ["websocket"],
    pingInterval: 10000,
    pingTimeout:  5000
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
    socket.data.roomId    = null;
    socket.data.name      = "?";
    socket.data.speaking  = false;

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
        // Se stava parlando, libera il canale
        if (socket.data.speaking) {
            socket.data.speaking = false;
            socket.to(roomId).emit("speaker_free");
        }
        socket.leave(roomId);
        setTimeout(() => emitUsers(roomId), 100);
    });

    socket.on("request_users", () => {
        if (socket.data.roomId) emitUsers(socket.data.roomId);
    });

    // ══════════════════════════════════════════════════════════
    //  AUDIO FULL-DUPLEX — relay immediato, zero buffering
    //
    //  Fix latenza:
    //  - niente array, niente setTimeout, niente accumulo
    //  - socket.to() è sincrono nel processo Node — latenza ~0ms server-side
    //  - speaker_busy/free per UI, non bloccano l'audio
    // ══════════════════════════════════════════════════════════
    socket.on("audio_chunk", (chunk) => {
        const { roomId, name } = socket.data;
        if (!roomId) return;

        // Prima trasmissione di questo speaker → notifica UI
        if (!socket.data.speaking) {
            socket.data.speaking = true;
            socket.to(roomId).emit("speaker_busy", { name });
        }

        // Relay immediato — zero buffering, zero elaborazione
        socket.to(roomId).emit("audio_chunk", chunk);

        // Reset timer silenzioo: se non arrivano chunk per 400ms → speaker_free
        clearTimeout(socket.data.silenceTimer);
        socket.data.silenceTimer = setTimeout(() => {
            if (socket.data.speaking) {
                socket.data.speaking = false;
                socket.to(roomId).emit("speaker_free");
            }
        }, 400);
    });

    // ── DISCONNECT ────────────────────────────────────────────
    socket.on("disconnect", () => {
        const { roomId, name } = socket.data;
        console.log(`❌ DISCONNECT: ${name} (${socket.id})`);

        clearTimeout(socket.data.silenceTimer);

        if (roomId) {
            // Se stava parlando, libera il canale
            if (socket.data.speaking) {
                socket.to(roomId).emit("speaker_free");
            }
            socket.to(roomId).emit("user_left", { name });
            setTimeout(() => emitUsers(roomId), 300);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 PTT SERVER ON PORT ${PORT}`);
});
