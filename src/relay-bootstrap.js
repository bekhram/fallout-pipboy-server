import { Server as SocketIOServer } from "socket.io";
import { rooms } from "./game.js";
import { registerGmRelay } from "./relay.js";

const PATCH_FLAG = Symbol.for("pip2d20.gmRelayPatched");

if (!SocketIOServer.prototype[PATCH_FLAG]) {
  const originalOn = SocketIOServer.prototype.on;
  SocketIOServer.prototype.on = function patchedOn(event, listener) {
    if (event !== "connection" || typeof listener !== "function") {
      return originalOn.call(this, event, listener);
    }
    const io = this;
    return originalOn.call(this, event, (socket) => {
      registerGmRelay(io, socket, rooms);
      return listener(socket);
    });
  };
  Object.defineProperty(SocketIOServer.prototype, PATCH_FLAG, { value: true });
}
