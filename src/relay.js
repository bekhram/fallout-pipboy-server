export function registerGmRelay(io, socket, rooms) {
  const ackOk = (ack, payload = {}) => {
    if (typeof ack === "function") ack({ ok: true, ...payload });
  };
  const ackError = (ack, error) => {
    if (typeof ack === "function") ack({ ok: false, error });
  };
  const currentRoom = () => {
    const code = socket.data.roomCode;
    return code ? rooms.get(code) || null : null;
  };
  const safeType = (value) => String(value || "").trim().slice(0, 80);

  socket.on("relay:to-gm", (payload = {}, ack) => {
    const room = currentRoom();
    if (!room) return ackError(ack, "NOT_IN_ROOM");
    if (socket.data.role !== "player") return ackError(ack, "PLAYER_ONLY");
    const type = safeType(payload.type);
    if (!type) return ackError(ack, "INVALID_RELAY_TYPE");

    // Joining an existing room must not fail just because the GM is currently
    // offline. A cached manifest lets returning players restore the last state
    // from their local resource cache. First-time players remain connected and
    // receive the fresh manifest automatically when the GM reconnects.
    if (!room.gm?.online || !room.gm?.socketId) {
      if (type === "sync:hello") {
        if (room.lastManifest) {
          socket.emit("relay:player", {
            type: "sync:manifest",
            fromClientId: room.gm?.clientId || "gm",
            data: room.lastManifest,
          });
        }
        return ackOk(ack, {
          gmOffline: true,
          cachedManifest: Boolean(room.lastManifest),
        });
      }
      return ackError(ack, "GM_OFFLINE");
    }

    const player = room.players.get(socket.data.clientId);
    io.to(room.gm.socketId).emit("relay:gm", {
      type,
      fromClientId: socket.data.clientId,
      fromName: player?.name || "Player",
      data: payload.data ?? null,
    });
    ackOk(ack);
  });

  socket.on("relay:to-player", (payload = {}, ack) => {
    const room = currentRoom();
    if (!room) return ackError(ack, "NOT_IN_ROOM");
    if (socket.data.role !== "gm" || room.gm?.clientId !== socket.data.clientId) return ackError(ack, "GM_ONLY");
    const type = safeType(payload.type);
    const targetClientId = String(payload.targetClientId || "").trim();
    if (!type || !targetClientId) return ackError(ack, "INVALID_RELAY_TARGET");

    if (type === "sync:manifest" && payload.data && typeof payload.data === "object") {
      room.lastManifest = payload.data;
      room.updatedAt = Date.now();
    }

    const player = room.players.get(targetClientId);
    if (!player?.online || !player?.socketId) return ackError(ack, "PLAYER_OFFLINE");

    io.to(player.socketId).emit("relay:player", {
      type,
      fromClientId: room.gm.clientId,
      data: payload.data ?? null,
    });
    ackOk(ack);
  });

  socket.on("relay:broadcast", (payload = {}, ack) => {
    const room = currentRoom();
    if (!room) return ackError(ack, "NOT_IN_ROOM");
    if (socket.data.role !== "gm" || room.gm?.clientId !== socket.data.clientId) return ackError(ack, "GM_ONLY");
    const type = safeType(payload.type);
    if (!type) return ackError(ack, "INVALID_RELAY_TYPE");

    if (type === "sync:manifest" && payload.data && typeof payload.data === "object") {
      room.lastManifest = payload.data;
      room.updatedAt = Date.now();
    }

    let delivered = 0;
    for (const player of room.players.values()) {
      if (!player?.online || !player?.socketId) continue;
      io.to(player.socketId).emit("relay:player", {
        type,
        fromClientId: room.gm.clientId,
        data: payload.data ?? null,
      });
      delivered += 1;
    }
    ackOk(ack, { delivered });
  });
}
