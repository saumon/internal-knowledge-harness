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

// ---------- databases ----------

const DB_URL = 'https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const rowUrl = (n) => `https://app.notion.com/p/${String(n).padStart(32, 'c')}`;
const rowKey = (n) => String(n).padStart(32, 'c');
const dbFile = (rows, extra = {}) => {
  const f = path.join(root, '.kb/db.json');
  fs.writeFileSync(f, JSON.stringify({
    url: DB_URL, title: 'db: Ideas', path: 'Home / Ideas', title_property: 'idea', edited_property: 'update date',
    columns: ['idea', 'state', 'userDefined:URL', 'update date'], rows, ...extra,
  }));
  return f;
};
const row = (n, state, edited, extra = {}) => ({ url: rowUrl(n), properties: { idea: `Idea ${n}`, state, 'userDefined:URL': `https://x/${n}`, 'update date': edited, ...extra } });
const database = (rows, extra) => JSON.parse(kb('database', dbFile(rows, extra)));
const index = () => fs.readFileSync(path.join(root, 'context/notion/db-ideas-aaaaaaaa.md'), 'utf8');

test('a database gets an index of every row, and rows to fetch are listed', () => {
  kb('start');
  const out = database([row(1, 'wip', 't1'), row(2, 'done', 't1')]);
  assert.equal(out.rows, 2);
  assert.deepEqual(out.fetch_now, [rowKey(1), rowKey(2)]);
  assert.equal(out.index, 'context/notion/db-ideas-aaaaaaaa.md', 'database id comes from the path, not the ?v= view id');
  assert.match(index(), /type: database/);
  assert.match(index(), /\| idea \| state \| URL \| update date \| Page \|/);
  assert.match(index(), /\| \[Idea 1\]\(https:\/\/app\.notion\.com\/p\/c+1\) \| wip \| https:\/\/x\/1 \| t1 \|  \|/);
  assert.equal(fs.existsSync(path.join(root, '.kb/db.json')), false, 'input file is consumed');
});

test('fetched rows with a body get a file listed in the index; empty rows stay index-only', () => {
  kb('start');
  database([row(1, 'wip', 't1'), row(2, 'done', 't1')]);
  assert.equal(kb('check', rowKey(1), 't1'), 'new');
  kb('record', rowKey(1), 't1', 'Idea 1', rowUrl(1), page('idea-1'));
  assert.equal(kb('record-empty', rowKey(2), 't1'), 'recorded (new, index only)');
  kb('finish');
  assert.match(index(), /\| wip \| https:\/\/x\/1 \| t1 \| `context\/notion\/idea-1\.md` \|/);
  assert.deepEqual(lastRun().new, ['Idea 1', 'Idea 2']);
});

test('the next sync skips unchanged rows without fetching them', () => {
  kb('start');
  database([row(1, 'wip', 't1'), row(2, 'done', 't1')]);
  kb('record', rowKey(1), 't1', 'Idea 1', rowUrl(1), page('idea-1'));
  kb('record-empty', rowKey(2), 't1');
  kb('finish');

  kb('start');
  const out = database([row(1, 'wip', 't1'), row(2, 'done', 't2')]);
  assert.deepEqual(out.fetch_now, [rowKey(2)], 'only the row whose edit time moved');
  assert.equal(out.unchanged, 1);
  assert.equal(kb('check', rowKey(2), 't2'), 'changed');
});

test('property changes show in the index even before the row is fetched again', () => {
  kb('start');
  database([row(1, 'wip', 't1')]);
  kb('record-empty', rowKey(1), 't1');
  kb('finish');
  kb('start');
  database([row(1, 'done', 't2')]);
  assert.match(index(), /\| \[Idea 1\]\([^)]+\) \| done \|/);
});

test('rows beyond the fetch budget are queued for the next run', () => {
  fs.writeFileSync(path.join(root, '.kb/sources.json'), JSON.stringify({ roots: [{ title: 'Ideas', url: DB_URL }], max_pages: 2 }));
  kb('start');
  const out = database([row(1, 'a', 't1'), row(2, 'a', 't1'), row(3, 'a', 't1')]);
  assert.equal(out.fetch_now.length, 2);
  assert.equal(out.queued_for_next_run, 1);
  kb('finish');
  assert.equal(lastRun().status, 'incomplete');
  assert.deepEqual(JSON.parse(kb('sources')).resume, [rowKey(3)]);
  kb('start');
  assert.equal(kb('check', rowKey(3), 't1'), 'new', 'a queued row is fetched on resume');
});

test('a row deleted from the database leaves the index and is reported after a full walk', () => {
  kb('start');
  database([row(1, 'a', 't1'), row(2, 'a', 't1')]);
  kb('record-empty', rowKey(1), 't1');
  kb('record-empty', rowKey(2), 't1');
  kb('finish');
  kb('start');
  database([row(1, 'a', 't1')]);
  kb('finish');
  assert.doesNotMatch(index(), /Idea 2/);
  assert.deepEqual(lastRun().not_found_in_notion, ['Idea 2']);
});

test('index cells are escaped and redacted', () => {
  kb('start');
  database([row(1, 'a | b', 't1', { idea: '**Bold [x]**', 'userDefined:URL': 'https://x/?token=abc123' })]);
  const md = index();
  assert.match(md, /\| \[Bold \\\[x\\\]\]\(/);
  assert.match(md, /\| a \\\| b \|/);
  assert.match(md, /\?token=\[REDACTED\]/);
});

test('record-empty refuses pages that are not database rows', () => {
  kb('start');
  const r = kbFails('record-empty', 'p1', 't1');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a known database row/);
});
