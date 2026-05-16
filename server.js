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

app.get("/ping", (req, res) => {
    res.send("pong");
});

// ══════════════════════════════════════════════════════════════
//  STATO — speaker lock PER STANZA
//  { "cantiere_1": { id: "socketId", name: "Mario" }, ... }
// ══════════════════════════════════════════════════════════════
const speakers = {};

function getSpeaker(roomId) {
    return speakers[roomId] || null;
}

function setSpeaker(roomId, socketId, name) {
    speakers[roomId] = { id: socketId, name: name || "Sconosciuto" };
}

function clearSpeaker(roomId) {
    speakers[roomId] = null;
}

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
    socket.data.name   = "Sconosciuto";

    // ── JOIN — accetta sia stringa (vecchio) che oggetto (nuovo) ──
    socket.on("join", (payload) => {
        let roomId, name;

        if (typeof payload === "string") {
            roomId = payload;
            name   = "Sconosciuto";
        } else {
            roomId = payload.roomId;
            name   = payload.name || "Sconosciuto";
        }

        socket.data.roomId = roomId;
        socket.data.name   = name;
        socket.join(roomId);

        console.log(`JOIN: ${name} (${socket.id}) → ${roomId}`);
        emitUsers(roomId);
        socket.emit("status", "ONLINE");
    });

    // ── LEAVE ─────────────────────────────────────────────────
    socket.on("leave", (roomId) => {
        console.log(`LEAVE: ${socket.data.name} (${socket.id}) ← ${roomId}`);

        if (getSpeaker(roomId)?.id === socket.id) {
            clearSpeaker(roomId);
            socket.to(roomId).emit("speaker_stopped");
            io.to(roomId).emit("speaker_free");
        }

        socket.leave(roomId);
        emitUsers(roomId);
    });

    socket.on("request_users", () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        emitUsers(roomId);
    });

    // ══════════════════════════════════════════════════════════
    //  LOCK TRASMISSIONE
    // ══════════════════════════════════════════════════════════
    socket.on("talking", () => {
        const roomId = socket.data.roomId;
        const name   = socket.data.name;
        if (!roomId) return;

        const speaker = getSpeaker(roomId);

        if (speaker === null) {
            setSpeaker(roomId, socket.id, name);
            console.log(`🎤 SPEAKER: ${name} in ${roomId}`);
            socket.emit("speaker_granted");
            // Invia il nome a tutti gli altri → UI mostra "MARIO sta trasmettendo"
            socket.to(roomId).emit("speaker_busy", { name });

        } else if (speaker.id === socket.id) {
            socket.emit("speaker_granted");

        } else {
            socket.emit("speaker_denied");
        }
    });

    socket.on("stop_talking", () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        if (getSpeaker(roomId)?.id === socket.id) {
            console.log(`🔇 FREE: ${roomId}`);
            clearSpeaker(roomId);
            socket.to(roomId).emit("speaker_stopped");
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
        console.log("❌ DISCONNECT:", socket.data.name, socket.id);

        const roomId = socket.data.roomId;

        if (roomId && getSpeaker(roomId)?.id === socket.id) {
            clearSpeaker(roomId);
            socket.to(roomId).emit("speaker_stopped");
            io.to(roomId).emit("speaker_free");
            console.log(`🔇 AUTO-FREE: ${roomId}`);
        }

        if (roomId) {
            setTimeout(() => emitUsers(roomId), 300);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 PTT SERVER RUNNING ON PORT ${PORT}`);
});
