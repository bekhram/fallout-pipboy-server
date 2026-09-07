import { randomBytes, randomUUID } from "node:crypto";

const MAX_CHAT = 100;
const MAX_LOG = 200;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SCENE_IMAGE_LENGTH = 850000;

export const rooms = new Map();

export function now() {
  return Date.now();
}

export function sanitizeText(value, max = 120) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function sanitizeAvatar(value) {
  const avatar = String(value || "");
  if (!avatar || avatar.length > 950000) return "";
  return /^data:image\/(?:png|jpe?g|webp);base64,/i.test(avatar) ? avatar : "";
}

export function sanitizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^https:\/\//i.test(url) && url.length <= 2048) return url;
  if (url.length <= MAX_SCENE_IMAGE_LENGTH && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(url)) return url;
  return "";
}

export function createRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomBytes(3).toString("hex").toUpperCase();
    if (!rooms.has(code)) return code;
  }
  return randomUUID().slice(0, 8).toUpperCase();
}

export function normalizeRoomCode(value) {
  return sanitizeText(value, 16).replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export function makeStartZone(cols, rows) {
  const result = [];
  const startY = Math.max(0, rows - 3);
  for (let y = startY; y < rows; y += 1) {
    for (let x = 0; x < Math.min(3, cols); x += 1) result.push({ x, y });
  }
  return result;
}

export function makeScene(cols = 12, rows = 12) {
  const safeCols = Math.max(4, Math.min(40, Number(cols) || 12));
  const safeRows = Math.max(4, Math.min(40, Number(rows) || 12));
  return {
    active: false,
    sceneId: `scene-${now()}`,
    cols: safeCols,
    rows: safeRows,
    startZone: makeStartZone(safeCols, safeRows),
    backgroundUrl: "",
    backgroundName: "",
    tokens: [],
    revision: 1,
  };
}

export function createRoom({ roomCode, gmName, gmClientId, socketId }) {
  const code = normalizeRoomCode(roomCode) || createRoomCode();
  if (rooms.has(code)) throw new Error("ROOM_EXISTS");

  const gmSecret = randomBytes(24).toString("hex");
  const room = {
    code,
    gmSecret,
    gm: {
      clientId: sanitizeText(gmClientId || randomUUID(), 120),
      name: sanitizeText(gmName || "GM", 60) || "GM",
      socketId,
      online: true,
    },
    players: new Map(),
    scene: makeScene(),
    chat: [],
    log: [],
    createdAt: now(),
    updatedAt: now(),
  };

  rooms.set(code, room);
  addLog(room, "room_created", { by: room.gm.name });
  return room;
}

export function addLog(room, type, payload = {}) {
  room.log.push({
    id: randomUUID(),
    type,
    payload,
    at: now(),
  });
  if (room.log.length > MAX_LOG) room.log.splice(0, room.log.length - MAX_LOG);
  touch(room);
}

export function addChat(room, message) {
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  touch(room);
}

export function touch(room) {
  room.updatedAt = now();
}

export function roomChannel(code) {
  return `room:${code}`;
}

export function tokenSize(token) {
  return Number(token?.size) === 2 ? 2 : 1;
}

export function tokenCells(token, x = token?.x, y = token?.y, size = tokenSize(token)) {
  const cells = [];
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) cells.push(`${Number(x) + dx}:${Number(y) + dy}`);
  }
  return cells;
}

export function canPlaceToken(scene, tokenId, x, y, size) {
  const safeX = Number(x);
  const safeY = Number(y);
  if (!Number.isInteger(safeX) || !Number.isInteger(safeY)) return false;
  if (safeX < 0 || safeY < 0 || safeX + size > scene.cols || safeY + size > scene.rows) return false;

  const occupied = new Set();
  for (const token of scene.tokens || []) {
    if (token.id === tokenId) continue;
    for (const cell of tokenCells(token)) occupied.add(cell);
  }
  return tokenCells({ x: safeX, y: safeY, size }).every((cell) => !occupied.has(cell));
}

export function findFreePlacement(scene, size = 1, preferred = []) {
  for (const cell of preferred) {
    if (canPlaceToken(scene, null, cell.x, cell.y, size)) return { x: cell.x, y: cell.y };
  }
  for (let y = 0; y <= scene.rows - size; y += 1) {
    for (let x = 0; x <= scene.cols - size; x += 1) {
      if (canPlaceToken(scene, null, x, y, size)) return { x, y };
    }
  }
  return null;
}

export function normalizePosition(scene, token, x, y) {
  const size = tokenSize(token);
  return {
    x: Math.max(0, Math.min(scene.cols - size, Math.floor(Number(x) || 0))),
    y: Math.max(0, Math.min(scene.rows - size, Math.floor(Number(y) || 0))),
  };
}

export function playerTokenFor(room, clientId) {
  return room.scene.tokens.find((token) => token.kind === "player" && token.ownerClientId === clientId) || null;
}

export function publicRoom(room) {
  return {
    code: room.code,
    gm: {
      clientId: room.gm.clientId,
      name: room.gm.name,
      online: Boolean(room.gm.online),
    },
    players: [...room.players.values()].map((player) => ({
      clientId: player.clientId,
      name: player.name,
      avatar: player.avatar || "",
      online: Boolean(player.online),
      joinedAt: player.joinedAt,
    })),
    scene: room.scene,
    chat: room.chat,
    log: room.log,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

export function cleanupExpiredRooms() {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [code, room] of rooms.entries()) {
    const anyPlayerOnline = [...room.players.values()].some((player) => player.online);
    if (!room.gm.online && !anyPlayerOnline && room.updatedAt < cutoff) rooms.delete(code);
  }
}

export function makeToken({ kind, name, avatar, size = 1, x = 0, y = 0, ownerClientId = null, npcId = null, stats = null }) {
  return {
    id: `${kind}-${randomUUID()}`,
    kind,
    ownerClientId,
    npcId: npcId ? sanitizeText(npcId, 120) : null,
    name: sanitizeText(name || (kind === "player" ? "Player" : "NPC"), 80) || "Token",
    avatar: sanitizeAvatar(avatar),
    size: Number(size) === 2 ? 2 : 1,
    x: Number(x) || 0,
    y: Number(y) || 0,
    stats: stats && typeof stats === "object" ? stats : null,
  };
}
