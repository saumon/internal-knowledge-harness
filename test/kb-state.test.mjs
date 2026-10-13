// Run history + ingest ledger: the guarantees behind "nothing re-ingests".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/kb-state.mjs');
let root;

const kb = (...args) => execFileSync('node', [SCRIPT, ...args], { env: { ...process.env, KB_ROOT: root }, encoding: 'utf8' }).trim();
const kbFails = (...args) => spawnSync('node', [SCRIPT, ...args], { env: { ...process.env, KB_ROOT: root }, encoding: 'utf8' });
const page = (name, body = 'content') => {
  const rel = `context/notion/${name}.md`;
  fs.writeFileSync(path.join(root, rel), body);
  return rel;
};
const runs = () => fs.readFileSync(path.join(root, '.kb/sync-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastRun = () => runs().at(-1);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  fs.mkdirSync(path.join(root, 'context/notion'), { recursive: true });
  fs.mkdirSync(path.join(root, '.kb'), { recursive: true });
});

test('a page is new, then unchanged on the next run with the same edit time', () => {
  kb('start');
  assert.equal(kb('check', 'abc-123', 't1'), 'new');
  kb('record', 'abc-123', 't1', 'Page', 'https://x', page('page-abc'));
  kb('finish');

  kb('start');
  assert.equal(kb('check', 'abc123', 't1'), 'unchanged', 'ids are compared without dashes');
  kb('skip', 'abc123');
  kb('finish');
  assert.equal(lastRun().unchanged, 1);
  assert.deepEqual(lastRun().new, []);
});

test('an edited page is changed, and a rename removes the old file', () => {
  kb('start');
  const old = page('old-name');
  kb('record', 'p1', 't1', 'Old name', 'u', old);
  kb('finish');

  kb('start');
  assert.equal(kb('check', 'p1', 't2'), 'changed');
  kb('record', 'p1', 't2', 'New name', 'u', page('new-name'));
  kb('finish');
  assert.equal(fs.existsSync(path.join(root, old)), false);
  assert.deepEqual(lastRun().changed, ['New name']);
});

test('a page whose local file was deleted is treated as new again', () => {
  kb('start');
  const f = page('p');
  kb('record', 'p1', 't1', 'P', 'u', f);
  kb('finish');
  fs.unlinkSync(path.join(root, f));
  assert.equal(kb('check', 'p1', 't1'), 'new');
});

test('record refuses a file that was not written', () => {
  kb('start');
  const r = kbFails('record', 'p1', 't1', 'P', 'u', 'context/notion/missing.md');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /File not found/);
});

test('record runs the secret safety net on the written file', () => {
  kb('start');
  const f = page('creds', 'api_key: sk-proj-FAKEfake1234567890abcdef\n');
  assert.match(kb('record', 'p1', 't1', 'Creds', 'u', f), /1 secret/);
  assert.equal(fs.readFileSync(path.join(root, f), 'utf8'), 'api_key: [REDACTED]\n');
});

test('a capped run saves the queue and the next run resumes from it', () => {
  fs.writeFileSync(path.join(root, '.kb/sources.json'), JSON.stringify({ roots: [{ title: 'Root', url: 'u' }], max_pages: 1 }));
  kb('start');
  kb('record', 'p1', 't1', 'P1', 'u', page('p1'));
  kb('pending', 'p2', 'p3');
  kb('finish');
  assert.equal(lastRun().status, 'incomplete');
  assert.deepEqual(JSON.parse(kb('sources')).resume, ['p2', 'p3']);

  kb('start');
  kb('record', 'p2', 't1', 'P2', 'u', page('p2'));
  kb('record', 'p3', 't1', 'P3', 'u', page('p3'));
  kb('finish');
  assert.equal(lastRun().status, 'ok');
  assert.deepEqual(JSON.parse(kb('sources')).resume, []);
});

test('pages missing from Notion are reported only after a complete walk', () => {
  kb('start');
  kb('record', 'p1', 't1', 'P1', 'u', page('p1'));
  kb('record', 'p2', 't1', 'P2', 'u', page('p2'));
  kb('pending', 'p9');
  kb('finish');

  kb('start'); // resumed run: it didn't see p1/p2, but that proves nothing
  kb('skip', 'p9');
  kb('finish');
  assert.deepEqual(lastRun().not_found_in_notion, []);

  kb('start'); // full walk: p2 is gone
  kb('skip', 'p1');
  kb('finish');
  assert.deepEqual(lastRun().not_found_in_notion, ['P2']);
  assert.ok(fs.existsSync(path.join(root, 'context/notion/p2.md')), 'local file is kept');
});

test('abort keeps recorded pages and logs the run as aborted', () => {
  kb('start');
  kb('record', 'p1', 't1', 'P1', 'u', page('p1'));
  kb('abort', 'stopped by test');
  assert.equal(lastRun().status, 'aborted');
  assert.equal(kb('check', 'p1', 't1'), 'unchanged');
});

test('starting over a crashed run closes it as aborted first', () => {
  kb('start');
  kb('start');
  kb('finish');
  assert.deepEqual(runs().map((r) => r.status), ['aborted', 'ok']);
});

test('sources explains how to configure when missing', () => {
  const r = kbFails('sources');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sources\.example\.json/);
});
