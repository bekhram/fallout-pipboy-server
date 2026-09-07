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
    if (!room.gm?.online || !room.gm?.socketId) return ackError(ack, "GM_OFFLINE");
    const type = safeType(payload.type);
    if (!type) return ackError(ack, "INVALID_RELAY_TYPE");

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
