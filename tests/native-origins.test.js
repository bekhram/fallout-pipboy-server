import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Evaluate the actual CORS policy without starting a listening production server.
const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const policy = source.slice(source.indexOf('const DEFAULT_ORIGINS ='), source.indexOf('const app ='));
const allows = vm.runInNewContext(`${policy}\noriginAllowed;`, {
  process: { env: { ALLOWED_ORIGINS: ' https://example.test ' } },
});

test('bundled Capacitor Android and iOS apps can open multiplayer connections', () => {
  for (const origin of ['https://localhost', 'http://localhost', 'capacitor://localhost']) {
    assert.equal(allows(origin), true, origin);
  }
});

test('production, supported previews, development and configured origins remain allowed', () => {
  for (const origin of ['https://pip-2d20.fun', 'https://www.pip-2d20.fun',
    'https://pipboy-privacy-qmfg-123-bekhrams-projects.vercel.app',
    'http://localhost:5173', 'http://127.0.0.1:5173', 'https://example.test', undefined]) {
    assert.equal(allows(origin), true, origin);
  }
});

test('native support does not permit unrelated sites or local-origin lookalikes', () => {
  for (const origin of ['https://attacker.test', 'https://localhost.attacker.test',
    'capacitor://attacker.test', 'https://localhost:9999', 'null',
    'https://www.pip-2d20.fun.attacker.test']) {
    assert.equal(allows(origin), false, origin);
  }
});
