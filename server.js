const http    = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

app.get("/", (req, res) => {
    res.send("PTT SERVER ONLINE ✅");
});

// ── Ping endpoint — mantiene Railway sveglio (chiamato ogni 5 min) ──
app.get("/ping", (req, res) => {
    res.send("pong");
});

// ══════════════════════════════════════════════════════════════
//  STATO — speaker lock PER STANZA (fix bug critico)
//  { "cantiere_1": "socketId", "cantiere_2": null, ... }
// ══════════════════════════════════════════════════════════════
const speakers = {};

function getSpeaker(roomId) {
    return speakers[roomId] || null;
}

function setSpeaker(roomId, socketId) {
    speakers[roomId] = socketId;
}

function clearSpeaker(roomId) {
    speakers[roomId] = null;
}

// ── Utenti online per stanza ───────────────────────────────────
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

    // ── JOIN ──────────────────────────────────────────────────
    socket.on("join", (roomId) => {
        socket.data.roomId = roomId;
        socket.join(roomId);
        console.log(`JOIN: ${socket.id} → ${roomId}`);
        emitUsers(roomId);
        socket.emit("status", "ONLINE");
    });

    // ── LEAVE (cambio stanza dall'app) ────────────────────────
    socket.on("leave", (roomId) => {
        console.log(`LEAVE: ${socket.id} ← ${roomId}`);

        // Se stava parlando, libera il microfono
        if (getSpeaker(roomId) === socket.id) {
            clearSpeaker(roomId);
            io.to(roomId).emit("speaker_free");
        }

        socket.leave(roomId);
        emitUsers(roomId);
    });

    // ── UTENTI ────────────────────────────────────────────────
    socket.on("request_users", () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        emitUsers(roomId);
    });

    // ══════════════════════════════════════════════════════════
    //  LOCK TRASMISSIONE — per stanza
    // ══════════════════════════════════════════════════════════
    socket.on("talking", () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        const speaker = getSpeaker(roomId);

        if (speaker === null) {
            // Canale libero → concedi
            setSpeaker(roomId, socket.id);
            console.log(`🎤 SPEAKER: ${socket.id} in ${roomId}`);
            socket.emit("speaker_granted");
            socket.to(roomId).emit("speaker_busy");

        } else if (speaker === socket.id) {
            // Stava già parlando lui (es. ritrasmissione)
            socket.emit("speaker_granted");

        } else {
            // Occupato da qualcun altro
            socket.emit("speaker_denied");
        }
    });

    socket.on("stop_talking", () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        if (getSpeaker(roomId) === socket.id) {
            console.log(`🔇 FREE: ${roomId}`);
            clearSpeaker(roomId);
            io.to(roomId).emit("speaker_free");
        }
    });

    // ══════════════════════════════════════════════════════════
    //  WEBRTC SIGNALING
    // ══════════════════════════════════════════════════════════
    socket.on("offer", (data) => {
        socket.to(data.roomId).emit("offer", data.sdp);
    });

    socket.on("answer", (data) => {
        socket.to(data.roomId).emit("answer", data.sdp);
    });

    socket.on("ice", (data) => {
        socket.to(data.roomId).emit("ice", data);
    });

    // ══════════════════════════════════════════════════════════
    //  DISCONNECT
    // ══════════════════════════════════════════════════════════
    socket.on("disconnect", () => {
        console.log("❌ DISCONNECT:", socket.id);

        const roomId = socket.data.roomId;

        // Libera il microfono se stava parlando
        if (roomId && getSpeaker(roomId) === socket.id) {
            clearSpeaker(roomId);
            io.to(roomId).emit("speaker_free");
            console.log(`🔇 AUTO-FREE: ${roomId}`);
        }

        // Aggiorna conteggio utenti dopo un breve delay
        // (Socket.IO impiega ~100ms a rimuoverlo dalla room)
        if (roomId) {
            setTimeout(() => emitUsers(roomId), 300);
        }
    });
});

// ── Avvio ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 PTT SERVER RUNNING ON PORT ${PORT}`);
});
