# PIP-2D20 Realtime Game Server

Realtime multiplayer backend for `pip-2d20.fun`.

## Stack

- Node.js 22
- Express
- Socket.IO
- Cloud Run
- In-memory room state (v1)

## Health checks

- `GET /`
- `GET /healthz`

## Local start

```bash
npm install
npm start
```

Default port: `8080`.

## Cloud Run deployment

Recommended v1 settings:

- Service name: `pip2d20-game-server`
- Region: `europe-west1`
- Source: this GitHub repository, branch `main`
- Build: Dockerfile
- Authentication: allow unauthenticated access
- Container port: `8080`
- Request timeout: `3600` seconds
- Minimum instances: `0`
- Maximum instances: `1`
- CPU: `1`
- Memory: `512 MiB`

The `max instances = 1` setting is important for v1 because active rooms are kept in process memory. When we add Redis, this restriction can be removed.

## Environment variables

Optional:

```text
ALLOWED_ORIGINS=https://pip-2d20.fun,https://www.pip-2d20.fun
```

The production PIP-2D20 domains and localhost development origins are already allowed by default.

## Socket events

### Room

- `room:create`
- `room:resume-gm`
- `room:join`
- `room:leave`
- `room:state`
- `state:request`

### Tactical scene

- `scene:enable`
- `scene:disable`
- `scene:update`

### Tokens

- `token:create-player`
- `token:create-npc`
- `token:update`
- `token:move`
- `token:delete`

### Shared session

- `chat:message`
- `dice:result`

## Reconnect model

Players use a persistent `clientId`. The GM additionally receives a `gmSecret` after `room:create`; the frontend stores it locally and uses `room:resume-gm` after reconnecting.

## Current persistence model

Rooms are in memory. If the Cloud Run instance restarts, active rooms are lost. For the first multiplayer test this is acceptable. The next infrastructure step is Redis (or another shared state store) for room persistence and multi-instance scaling.
