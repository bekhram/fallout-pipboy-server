import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRoom, publicRoom, rooms } from '../src/game.js';

// Evaluate the actual production room:create handler without opening a port.
// This catches forwarding regressions between the client payload and game.js.
const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const begin = source.indexOf('  socket.on("room:create"');
const end = source.indexOf('  socket.on("room:resume-gm"', begin);
assert.ok(begin >= 0 && end > begin);
const handlerSource = source.slice(begin, end);

function issueCreate(payload) {
  const callbacks = new Map();
  const socket = {
    id: 'gm-socket-test',
    on(event, handler) { callbacks.set(event, handler); },
  };
  vm.runInNewContext(handlerSource, {
    socket,
    createRoom,
    publicRoom,
    joinSocketToRoom: () => {},
    emitRoom: () => {},
    ackOk: (ack, result = {}) => ack({ ok: true, ...result }),
    ackError: (ack, error) => ack({ ok: false, error }),
  });
  let response;
  callbacks.get('room:create')(payload, result => { response = result; });
  return response;
}

afterEach(() => rooms.clear());

test('GM-authoritative protocol 3 creates a lightweight relay room with campaignId', () => {
  const response = issueCreate({
    clientId: 'gm-client',
    gmName: 'GM',
    protocol: 3,
    campaignId: 'campaign-active',
  });
  assert.equal(response.ok, true);
  assert.equal(response.state.protocol, 2);
  assert.equal(response.state.campaignId, 'campaign-active');
  assert.equal(rooms.get(response.roomCode).campaignId, 'campaign-active');
  assert.equal(rooms.get(response.roomCode).gm.clientId, 'gm-client');
  assert.equal(Object.hasOwn(response.state, 'scene'), false);
});

test('legacy room creation still returns the legacy presence payload', () => {
  const response = issueCreate({ clientId: 'legacy-gm' });
  assert.equal(response.ok, true);
  assert.equal(response.state.protocol, 1);
  assert.equal(response.state.campaignId, '');
  assert.equal(Object.hasOwn(response.state, 'scene'), true);
});

test('campaign IDs are sanitized and cannot exceed 120 characters', () => {
  const response = issueCreate({ protocol: 3, campaignId: 'z'.repeat(300) });
  assert.equal(response.ok, true);
  assert.equal(response.state.campaignId.length, 120);
});
