// HTTP guards. Never calls Claude: only routes that reject or read status are exercised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server.mjs');
const PORT = 38000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
let proc;

before(async () => {
  proc = spawn('node', [SERVER], { env: { ...process.env, PORT: String(PORT), CLAUDE_BIN: '/nonexistent/claude' } });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('running') && resolve());
    proc.on('exit', (code) => reject(new Error(`server exited (${code})`)));
  });
});
after(() => proc.kill());

const post = (url, { origin = BASE, type = 'application/json', body = '{}' } = {}) =>
  fetch(BASE + url, { method: 'POST', headers: { Origin: origin, 'Content-Type': type }, body });

test('serves the page and status', async () => {
  assert.equal((await fetch(BASE + '/')).status, 200);
  const s = await (await fetch(BASE + '/api/status')).json();
  for (const key of ['pages', 'notes', 'pending', 'syncing']) assert.ok(key in s, key);
});

test('rejects requests from other websites', async () => {
  assert.equal((await post('/api/sync', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/ask', { origin: 'null' })).status, 403);
});

test('rejects form-encoded cross-site posts', async () => {
  assert.equal((await post('/api/sync', { type: 'text/plain' })).status, 403);
});

test('rejects DNS-rebinding hosts', async () => {
  const res = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      request({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: { Host: `attacker.example:${PORT}` } }, resolve).end();
    });
  });
  assert.equal(res.statusCode, 403);
});

test('validates input before running anything', async () => {
  assert.equal((await post('/api/ask', { body: '{"question":"  "}' })).status, 400);
  assert.equal((await post('/api/feedback', { body: '{"rating":"meh"}' })).status, 400);
  assert.equal((await post('/api/feedback/context', { body: '{"id":"x","text":""}' })).status, 400);
});

test('unknown routes are 404', async () => {
  assert.equal((await fetch(BASE + '/nope')).status, 404);
});
