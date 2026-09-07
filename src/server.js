import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server as SocketIOServer } from "socket.io";
import {
  addChat,
  addLog,
  canPlaceToken,
  cleanupExpiredRooms,
  createRoom,
  findFreePlacement,
  makeScene,
  makeStartZone,
  makeToken,
  normalizePosition,
  normalizeRoomCode,
  playerTokenFor,
  publicRoom,
  roomChannel,
  rooms,
  sanitizeAvatar,
  sanitizeImageUrl,
  sanitizeText,
  tokenSize,
  touch,
} from "./game.js";

const PORT = Number(process.env.PORT || 8080);
const DEFAULT_ORIGINS = [
  "https://pip-2d20.fun",
  "https://www.pip-2d20.fun",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const allowedOrigins = new Set([
  ...DEFAULT_ORIGINS,
  ...String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
]);

function originAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (/^https:\/\/pipboy-privacy-qmfg-[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  return false;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => {
  res.json({
    service: "pip2d20-game-server",
    ok: true,
    rooms: rooms.size,
    now: Date.now(),
  });
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin(origin, callback) {
      if (originAllowed(origin)) return callback(null, true);
      return callback(new Error("CORS_NOT_ALLOWED"));
    },
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1_000_000,
});

function ackOk(ack, payload = {}) {
  if (typeof ack === "function") ack({ ok: true, ...payload });
}

function ackError(ack, error, extra = {}) {
  if (typeof ack === "function") ack({ ok: false, error, ...extra });
}

function currentRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) || null : null;
}

function requireRoom(socket, ack) {
  const room = currentRoom(socket);
  if (!room) {
    ackError(ack, "NOT_IN_ROOM");
    return null;
  }
  return room;
}

function requireGm(socket, ack) {
  const room = requireRoom(socket, ack);
  if (!room) return null;
  if (socket.data.role !== "gm" || room.gm.clientId !== socket.data.clientId) {
    ackError(ack, "GM_ONLY");
    return null;
  }
  return room;
}

function emitRoom(room) {
  io.to(roomChannel(room.code)).emit("room:state", publicRoom(room));
}

function joinSocketToRoom(socket, room, role, clientId) {
  if (socket.data.roomCode) socket.leave(roomChannel(socket.data.roomCode));
  socket.data.roomCode = room.code;
  socket.data.role = role;
  socket.data.clientId = clientId;
  socket.join(roomChannel(room.code));
}

function markPlayerOnline(room, { clientId, playerName, avatar, socketId }) {
  const id = sanitizeText(clientId || randomUUID(), 120);
  const existing = room.players.get(id);
  const player = {
    clientId: id,
    name: sanitizeText(playerName || existing?.name || "Player", 60) || "Player",
    avatar: sanitizeAvatar(avatar) || existing?.avatar || "",
    online: true,
    socketId,
    joinedAt: existing?.joinedAt || Date.now(),
  };
  room.players.set(id, player);
  touch(room);
  return player;
}

function removeSocketPresence(socket) {
  const room = currentRoom(socket);
  if (!room) return;

  if (socket.data.role === "gm" && room.gm.clientId === socket.data.clientId && room.gm.socketId === socket.id) {
    room.gm.online = false;
    room.gm.socketId = null;
    addLog(room, "gm_offline", { clientId: room.gm.clientId });
    emitRoom(room);
    return;
  }

  if (socket.data.role === "player") {
    const player = room.players.get(socket.data.clientId);
    if (player && player.socketId === socket.id) {
      player.online = false;
      player.socketId = null;
      addLog(room, "player_offline", { clientId: player.clientId, name: player.name });
      emitRoom(room);
    }
  }
}

io.on("connection", (socket) => {
  socket.on("room:create", (payload = {}, ack) => {
    try {
      const room = createRoom({
        roomCode: payload.roomCode,
        gmName: payload.gmName,
        gmClientId: payload.clientId,
        socketId: socket.id,
      });
      joinSocketToRoom(socket, room, "gm", room.gm.clientId);
      ackOk(ack, { roomCode: room.code, gmSecret: room.gmSecret, state: publicRoom(room) });
      emitRoom(room);
    } catch (error) {
      ackError(ack, error?.message || "ROOM_CREATE_FAILED");
    }
  });

  socket.on("room:resume-gm", (payload = {}, ack) => {
    const code = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(code);
    if (!room) return ackError(ack, "ROOM_NOT_FOUND");
    if (!payload.gmSecret || payload.gmSecret !== room.gmSecret) return ackError(ack, "INVALID_GM_SECRET");

    const clientId = sanitizeText(payload.clientId || room.gm.clientId, 120) || room.gm.clientId;
    room.gm.clientId = clientId;
    room.gm.name = sanitizeText(payload.gmName || room.gm.name, 60) || room.gm.name;
    room.gm.socketId = socket.id;
    room.gm.online = true;
    joinSocketToRoom(socket, room, "gm", clientId);
    addLog(room, "gm_online", { clientId, name: room.gm.name });
    ackOk(ack, { roomCode: room.code, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:join", (payload = {}, ack) => {
    const code = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(code);
    if (!room) return ackError(ack, "ROOM_NOT_FOUND");

    const player = markPlayerOnline(room, {
      clientId: payload.clientId,
      playerName: payload.playerName,
      avatar: payload.avatar,
      socketId: socket.id,
    });
    joinSocketToRoom(socket, room, "player", player.clientId);
    addLog(room, "player_online", { clientId: player.clientId, name: player.name });
    ackOk(ack, { roomCode: room.code, clientId: player.clientId, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:leave", (_payload = {}, ack) => {
    const room = currentRoom(socket);
    if (!room) return ackOk(ack);

    const channel = roomChannel(room.code);
    if (socket.data.role === "player") {
      const player = room.players.get(socket.data.clientId);
      if (player) {
        room.players.delete(player.clientId);
        room.scene.tokens = room.scene.tokens.filter((token) => token.ownerClientId !== player.clientId);
        room.scene.revision += 1;
        addLog(room, "player_left", { clientId: player.clientId, name: player.name });
      }
    } else if (socket.data.role === "gm") {
      room.gm.online = false;
      room.gm.socketId = null;
      addLog(room, "gm_left", { clientId: room.gm.clientId });
    }

    socket.leave(channel);
    socket.data.roomCode = null;
    socket.data.role = null;
    socket.data.clientId = null;
    ackOk(ack);
    emitRoom(room);
  });

  socket.on("state:request", (_payload = {}, ack) => {
    const room = requireRoom(socket, ack);
    if (!room) return;
    ackOk(ack, { state: publicRoom(room) });
  });

  socket.on("scene:enable", (payload = {}, ack) => {
    const room = requireGm(socket, ack);
    if (!room) return;

    const cols = Math.max(4, Math.min(40, Number(payload.cols || room.scene.cols || 12)));
    const rows = Math.max(4, Math.min(40, Number(payload.rows || room.scene.rows || 12)));
    const previous = room.scene;
    const keepNpcs = (previous.tokens || []).filter((token) => token.kind !== "player");
    const next = makeScene(cols, rows);
    next.active = true;
    next.sceneId = `scene-${Date.now()}`;
    next.backgroundUrl = sanitizeImageUrl(payload.backgroundUrl) || previous.backgroundUrl || "";
    next.backgroundName = sanitizeText(payload.backgroundName || previous.backgroundName, 160);
    next.startZone = Array.isArray(payload.startZone) && payload.startZone.length
      ? payload.startZone
          .map((cell) => ({ x: Math.floor(Number(cell?.x)), y: Math.floor(Number(cell?.y)) }))
          .filter((cell) => Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.y >= 0 && cell.x < cols && cell.y < rows)
      : makeStartZone(cols, rows);
    next.tokens = payload.keepNpcs === false ? [] : keepNpcs.filter((token) => token.x < cols && token.y < rows);
    next.revision = Number(previous.revision || 0) + 1;
    room.scene = next;
    addLog(room, "scene_enabled", { sceneId: next.sceneId, cols, rows });
    ackOk(ack, { state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("scene:disable", (_payload = {}, ack) => {
    const room = requireGm(socket, ack);
    if (!room) return;
    room.scene.active = false;
    room.scene.revision += 1;
    addLog(room, "scene_disabled", { sceneId: room.scene.sceneId });
    ackOk(ack, { state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("scene:update", (payload = {}, ack) => {
    const room = requireGm(socket, ack);
    if (!room) return;

    if (Object.prototype.hasOwnProperty.call(payload, "backgroundUrl")) {
      room.scene.backgroundUrl = sanitizeImageUrl(payload.backgroundUrl);
      room.scene.backgroundName = sanitizeText(payload.backgroundName, 160);
    }
    if (Array.isArray(payload.startZone)) {
      room.scene.startZone = payload.startZone
        .map((cell) => ({ x: Math.floor(Number(cell?.x)), y: Math.floor(Number(cell?.y)) }))
        .filter((cell) => Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.y >= 0 && cell.x < room.scene.cols && cell.y < room.scene.rows);
    }
    room.scene.revision += 1;
    touch(room);
    ackOk(ack, { state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("token:create-player", (payload = {}, ack) => {
    const room = requireRoom(socket, ack);
    if (!room) return;
    if (socket.data.role !== "player") return ackError(ack, "PLAYER_ONLY");
    if (!room.scene.active) return ackError(ack, "SCENE_INACTIVE");

    const existing = playerTokenFor(room, socket.data.clientId);
    if (existing) return ackOk(ack, { token: existing, state: publicRoom(room) });

    const player = room.players.get(socket.data.clientId);
    if (!player) return ackError(ack, "PLAYER_NOT_FOUND");
    const placement = findFreePlacement(room.scene, 1, room.scene.startZone);
    if (!placement) return ackError(ack, "NO_FREE_CELL");

    const token = makeToken({
      kind: "player",
      ownerClientId: player.clientId,
      name: payload.name || player.name,
      avatar: payload.avatar || player.avatar,
      size: 1,
      ...placement,
    });
    room.scene.tokens.push(token);
    room.scene.revision += 1;
    addLog(room, "player_token_created", { clientId: player.clientId, tokenId: token.id });
    ackOk(ack, { token, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("token:create-npc", (payload = {}, ack) => {
    const room = requireGm(socket, ack);
    if (!room) return;

    const size = Number(payload.size) === 2 ? 2 : 1;
    const requested = { x: Math.floor(Number(payload.x)), y: Math.floor(Number(payload.y)) };
    const validRequested = Number.isInteger(requested.x) && Number.isInteger(requested.y)
      && canPlaceToken(room.scene, null, requested.x, requested.y, size);
    const placement = validRequested ? requested : findFreePlacement(room.scene, size, []);
    if (!placement) return ackError(ack, "NO_FREE_CELL");

    const token = makeToken({
      kind: "npc",
      name: payload.name || "NPC",
      avatar: payload.avatar,
      size,
      npcId: payload.npcId,
      stats: payload.stats,
      ...placement,
    });
    room.scene.tokens.push(token);
    room.scene.revision += 1;
    addLog(room, "npc_token_created", { tokenId: token.id, name: token.name });
    ackOk(ack, { token, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("token:update", (payload = {}, ack) => {
    const room = requireRoom(socket, ack);
    if (!room) return;
    const token = room.scene.tokens.find((item) => item.id === payload.tokenId);
    if (!token) return ackError(ack, "TOKEN_NOT_FOUND");

    const isGm = socket.data.role === "gm";
    const isOwner = token.kind === "player" && token.ownerClientId === socket.data.clientId;
    if (!isGm && !isOwner) return ackError(ack, "TOKEN_FORBIDDEN");

    if (Object.prototype.hasOwnProperty.call(payload, "avatar")) token.avatar = sanitizeAvatar(payload.avatar);
    if (isGm && Object.prototype.hasOwnProperty.call(payload, "name")) token.name = sanitizeText(payload.name, 80) || token.name;
    if (isGm && Object.prototype.hasOwnProperty.call(payload, "stats") && payload.stats && typeof payload.stats === "object") token.stats = payload.stats;
    if (isGm && Object.prototype.hasOwnProperty.call(payload, "size")) {
      const nextSize = Number(payload.size) === 2 ? 2 : 1;
      if (canPlaceToken(room.scene, token.id, token.x, token.y, nextSize)) token.size = nextSize;
    }
    room.scene.revision += 1;
    touch(room);
    ackOk(ack, { token, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("token:move", (payload = {}, ack) => {
    const room = requireRoom(socket, ack);
    if (!room) return;
    if (!room.scene.active && socket.data.role !== "gm") return ackError(ack, "SCENE_INACTIVE");

    const token = room.scene.tokens.find((item) => item.id === payload.tokenId);
    if (!token) return ackError(ack, "TOKEN_NOT_FOUND");
    const isGm = socket.data.role === "gm";
    const isOwner = token.kind === "player" && token.ownerClientId === socket.data.clientId;
    if (!isGm && !isOwner) return ackError(ack, "TOKEN_FORBIDDEN");

    const target = normalizePosition(room.scene, token, payload.x, payload.y);
    const size = tokenSize(token);
    if (!canPlaceToken(room.scene, token.id, target.x, target.y, size)) return ackError(ack, "CELL_BLOCKED");

    token.x = target.x;
    token.y = target.y;
    room.scene.revision += 1;
    touch(room);
    ackOk(ack, { token, revision: room.scene.revision });
    emitRoom(room);
  });

  socket.on("token:delete", (payload = {}, ack) => {
    const room = requireRoom(socket, ack);
    if (!room) return;
    const token = room.scene.tokens.find((item) => item.id === payload.tokenId);
    if (!token) return ackError(ack, "TOKEN_NOT_FOUND");

    const isGm = socket.data.role === "gm";
    const isOwner = token.kind === "player" && token.ownerClientId === socket.data.clientId;
    if (!isGm && !isOwner) return ackError(ack, "TOKEN_FORBIDDEN");

    room.scene.tokens = room.scene.tokens.filter((item) => item.id !== token.id);
    room.scene.revision += 1;
    addLog(room, "token_deleted", { tokenId: token.id, kind: token.kind });
    ackOk(ack, { state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("chat:message", (payload = {}, ack) => {
    const room = requireRoom(socket, ack);
    if (!room) return;
    const text = sanitizeText(payload.text, 1200);
    if (!text) return ackError(ack, "EMPTY_MESSAGE");

    let authorName = room.gm.name;
    if (socket.data.role === "player") authorName = room.players.get(socket.data.clientId)?.name || "Player";
    const message = {
      id: randomUUID(),
      authorClientId: socket.data.clientId,
      authorRole: socket.data.role,
      authorName,
      text,
      at: Date.now(),
    };
    addChat(room, message);
    io.to(roomChannel(room.code)).emit("chat:message", message);
    ackOk(ack, { message });
  });

  socket.on("dice:result", (payload = {}, ack) => {
    const room = requireRoom(socket, ack);
    if (!room) return;
    const entry = {
      clientId: socket.data.clientId,
      role: socket.data.role,
      name: socket.data.role === "gm" ? room.gm.name : room.players.get(socket.data.clientId)?.name || "Player",
      label: sanitizeText(payload.label || "Dice", 120),
      result: payload.result ?? null,
    };
    addLog(room, "dice_result", entry);
    io.to(roomChannel(room.code)).emit("dice:result", { ...entry, at: Date.now() });
    ackOk(ack);
    emitRoom(room);
  });

  socket.on("disconnect", () => removeSocketPresence(socket));
});

const cleanupTimer = setInterval(cleanupExpiredRooms, 10 * 60 * 1000);
cleanupTimer.unref?.();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[pip2d20] realtime server listening on :${PORT}`);
});

function shutdown(signal) {
  console.log(`[pip2d20] ${signal} received, shutting down`);
  clearInterval(cleanupTimer);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 8000).unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
