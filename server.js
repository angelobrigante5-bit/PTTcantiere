const http    = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" },
    // Chunk audio fino a 64KB — più che sufficiente per 20ms di Opus/PCM
    maxHttpBufferSize: 64 * 1024
});

app.get("/",     (_, res) => res.send("PTT SERVER ONLINE ✅"));
app.get("/ping", (_, res) => res.send("pong"));

// ══════════════════════════════════════════════════════════════
//  STATO
// ══════════════════════════════════════════════════════════════
// speakers[roomId] = { id, name } oppure null
const speakers = {};

function getSpeaker(roomId)            { return speakers[roomId] || null; }
function setSpeaker(roomId, id, name)  { speakers[roomId] = { id, name: name || "?" }; }
function clearSpeaker(roomId)          { speakers[roomId] = null; }

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

        // Lascia stanza precedente se esiste
        if (socket.data.roomId && socket.data.roomId !== roomId) {
            handleLeave(socket, socket.data.roomId);
        }

        socket.data.roomId = roomId;
        socket.data.name   = name;
        socket.join(roomId);

        console.log(`JOIN: ${name} → ${roomId}`);
        emitUsers(roomId);
        socket.emit("status", "ONLINE");
    });

    // ── LEAVE ─────────────────────────────────────────────────
    socket.on("leave", (roomId) => {
        handleLeave(socket, roomId);
    });

    socket.on("request_users", () => {
        if (socket.data.roomId) emitUsers(socket.data.roomId);
    });

    // ── LOCK TRASMISSIONE ─────────────────────────────────────
    socket.on("talking", () => {
        const { roomId, name } = socket.data;
        if (!roomId) return;

        const speaker = getSpeaker(roomId);

        if (!speaker) {
            setSpeaker(roomId, socket.id, name);
            console.log(`🎤 ${name} → ${roomId}`);
            socket.emit("speaker_granted");
            socket.to(roomId).emit("speaker_busy", { name });

        } else if (speaker.id === socket.id) {
            socket.emit("speaker_granted");

        } else {
            socket.emit("speaker_denied");
        }
    });

    socket.on("stop_talking", () => {
        const { roomId } = socket.data;
        if (!roomId) return;
        if (getSpeaker(roomId)?.id !== socket.id) return;

        console.log(`🔇 FREE: ${roomId}`);
        clearSpeaker(roomId);
        socket.to(roomId).emit("speaker_stopped");
        io.to(roomId).emit("speaker_free");
    });

    // ══════════════════════════════════════════════════════════
    //  AUDIO STREAMING
    //  Il telefono che parla manda chunk Buffer (PCM 16bit mono)
    //  Il server li rimanda a tutti gli altri nella stessa stanza
    // ══════════════════════════════════════════════════════════
    socket.on("audio_chunk", (chunk) => {
        const { roomId } = socket.data;
        if (!roomId) return;
        // Solo il current speaker può mandare audio
        if (getSpeaker(roomId)?.id !== socket.id) return;
        // Broadcast a tutti gli altri nella stanza (non al mittente)
        socket.to(roomId).emit("audio_chunk", chunk);
    });

    // ── DISCONNECT ────────────────────────────────────────────
    socket.on("disconnect", () => {
        console.log("❌ DISCONNECT:", socket.data.name, socket.id);
        if (socket.data.roomId) {
            handleLeave(socket, socket.data.roomId);
        }
    });
});

function handleLeave(socket, roomId) {
    if (getSpeaker(roomId)?.id === socket.id) {
        clearSpeaker(roomId);
        socket.to(roomId).emit("speaker_stopped");
        io.to(roomId).emit("speaker_free");
    }
    socket.leave(roomId);
    setTimeout(() => emitUsers(roomId), 300);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 PTT SERVER ON PORT ${PORT}`);
});
