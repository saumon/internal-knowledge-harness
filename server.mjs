#!/usr/bin/env node
// Local web UI for the harness. No dependencies: `node server.mjs`, then open http://localhost:3737
//
// Send -> `claude -p "/kb-answer <question>"` (read-only tools, no MCP, no web)
// Sync -> `claude -p "/kb-sync"`              (Notion read + writes limited to context/notion/)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redactText } from './scripts/redact.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3737);
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.KB_MODEL || 'sonnet'; // model for Send and Sync; override with e.g. KB_MODEL=opus
const KB = path.join(ROOT, '.kb');
for (const dir of [KB, path.join(ROOT, 'context/notion'), path.join(ROOT, 'context/feedback')]) fs.mkdirSync(dir, { recursive: true });

const ASK_ARGS = [
  '--allowedTools', 'Read,Glob,Grep',
  '--disallowedTools', 'Bash,Edit,Write,WebFetch,WebSearch',
  '--strict-mcp-config', // no MCP servers at all while answering
];
const SYNC_ARGS = [
  '--allowedTools', [
    'Read', 'Edit(./context/notion/**)', 'Bash(node scripts/kb-state.mjs *)',
    'mcp__claude_ai_Notion__notion-fetch', 'mcp__claude_ai_Notion__notion-query-data-sources',
    'mcp__notion__notion-fetch', 'mcp__notion__notion-query-data-sources',
  ].join(','),
  '--disallowedTools', 'WebFetch,WebSearch',
];

// ---------- helpers ----------

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

function frontmatter(file) {
  try {
    const head = fs.readFileSync(path.join(ROOT, file), 'utf8').match(/^---\n([\s\S]*?)\n---/);
    if (!head) return {};
    return Object.fromEntries(head[1].split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
  } catch { return {}; }
}

function sourceInfo(file) {
  const fm = frontmatter(file);
  return { file, title: fm.title || path.basename(file, '.md'), url: fm.url || null, path: fm.path || null };
}

function status() {
  const state = readJson(path.join(KB, 'sync-state.json'), {});
  const queue = readJson(path.join(KB, 'sync-queue.json'), []);
  let lastRun = null;
  try {
    const lines = fs.readFileSync(path.join(KB, 'sync-runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) lastRun = JSON.parse(lines.at(-1));
  } catch {}
  const feedbackFiles = fs.readdirSync(path.join(ROOT, 'context/feedback')).filter((f) => f.endsWith('.md')).length;
  return {
    pages: Object.keys(state).length,
    notes: feedbackFiles,
    pending: queue.length,
    lastRun: lastRun && { status: lastRun.status, finished_at: lastRun.finished_at, new: lastRun.new.length, changed: lastRun.changed.length, unchanged: lastRun.unchanged },
    syncing: Boolean(sync.child),
  };
}

function runClaude(prompt, extraArgs) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...extraArgs];
  if (MODEL) args.push('--model', MODEL);
  return spawn(CLAUDE, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Turn claude's stream-json into {type:'tool', name, input} / {type:'result', ...} events.
function onEvents(child, handler) {
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') {
        for (const part of ev.message?.content || []) {
          if (part.type === 'tool_use') handler({ type: 'tool', name: part.name, input: part.input || {} });
        }
      } else if (ev.type === 'result') {
        handler({ type: 'result', ok: ev.subtype === 'success' && !ev.is_error, text: ev.result || '', ms: ev.duration_ms, cost: ev.total_cost_usd });
      }
    }
  });
}

// ---------- ask ----------

function describeAskTool({ name, input }) {
  if (name === 'Grep') return `Searching for “${input.pattern}”`;
  if (name === 'Glob') return 'Listing your pages';
  if (name === 'Read') {
    const rel = path.relative(ROOT, path.resolve(ROOT, input.file_path || ''));
    return `Reading “${sourceInfo(rel).title}”`;
  }
  return null;
}

function citedSources(text) {
  const files = [...new Set(text.match(/context\/(?:notion|feedback)\/[^\s`\]\),]+\.md/g) || [])];
  return files.filter((f) => fs.existsSync(path.join(ROOT, f))).map(sourceInfo);
}

function handleAsk(req, res, body) {
  const question = String(body.question || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!question) return sendJson(res, 400, { error: 'Type a question first.' });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const send = (ev) => res.write(JSON.stringify(ev) + '\n');
  const id = crypto.randomUUID();
  const child = runClaude(`/kb-answer ${question}`, ASK_ARGS);
  let finished = false;

  onEvents(child, (ev) => {
    if (ev.type === 'tool') {
      const text = describeAskTool(ev);
      if (text) send({ type: 'step', text });
    } else if (ev.type === 'result') {
      finished = true;
      if (ev.ok) send({ type: 'answer', id, question, markdown: ev.text, sources: citedSources(ev.text), ms: ev.ms });
      else send({ type: 'error', text: `Claude stopped before answering: ${ev.text || 'unknown error'}` });
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.on('error', (err) => { finished = true; send({ type: 'error', text: `Could not start claude (${err.code}). Is it on your PATH? Set CLAUDE_BIN to its full path.` }); res.end(); });
  child.on('close', (code) => {
    if (!finished) send({ type: 'error', text: `claude exited with code ${code}. ${stderr.trim().split('\n').at(-1) || ''}` });
    res.end();
  });
  res.on('close', () => { if (!finished) child.kill(); }); // browser went away
}

// ---------- feedback ----------

const FEEDBACK_LOG = path.join(KB, 'feedback.jsonl');
const FEEDBACK_DIR = path.join(ROOT, 'context/feedback');
const logFeedback = (entry) => fs.appendFileSync(FEEDBACK_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const clean = (v, max) => String(v || '').trim().slice(0, max);

function handleRating(res, body) {
  const rating = body.rating;
  if (!['up', 'down'].includes(rating) || !body.id) return sendJson(res, 400, { error: 'Missing answer id or rating.' });
  logFeedback({
    type: 'rating', id: clean(body.id, 64), rating,
    question: clean(body.question, 2000), answer: clean(body.answer, 20000),
    sources: Array.isArray(body.sources) ? body.sources.map((s) => clean(s, 300)).slice(0, 50) : [],
  });
  sendJson(res, 200, { ok: true });
}

function slugify(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';
}

// A thumbs-down note becomes a context file that kb-answer reads and prefers.
function handleAddContext(res, body) {
  const question = clean(body.question, 2000);
  const raw = clean(body.text, 20000);
  if (!raw) return sendJson(res, 400, { error: 'Write the missing information first.' });
  const { text, count } = redactText(raw);

  const date = new Date().toISOString().slice(0, 10);
  let name = `${date}-${slugify(question)}.md`;
  for (let i = 2; fs.existsSync(path.join(FEEDBACK_DIR, name)); i++) name = `${date}-${slugify(question)}-${i}.md`;
  const file = `context/feedback/${name}`;
  const title = question.replace(/\s+/g, ' ');
  fs.writeFileSync(path.join(ROOT, file), [
    '---',
    `title: ${title}`,
    `added: ${new Date().toISOString()}`,
    `answer_id: ${clean(body.id, 64)}`,
    'source: added by you after a thumbs-down',
    '---',
    '',
    `# ${title}`,
    '',
    text,
    '',
  ].join('\n'));
  logFeedback({ type: 'context_added', id: clean(body.id, 64), question, file, redacted: count });
  sendJson(res, 200, { file, title, redacted: count });
}

// ---------- sync (one at a time, survives page reloads) ----------

const sync = { child: null, log: [], listeners: new Set(), result: null };

function syncEmit(ev) {
  sync.log.push(ev);
  for (const l of sync.listeners) l.write(JSON.stringify(ev) + '\n');
}

function titleForId(id) {
  const state = readJson(path.join(KB, 'sync-state.json'), {});
  return state[String(id).replace(/-/g, '').toLowerCase()]?.title;
}

function describeSyncTool({ name, input }) {
  if (name.endsWith('notion-fetch')) return { kind: 'fetch', text: 'Reading a page in Notion' };
  if (name.endsWith('notion-query-data-sources')) return { kind: 'fetch', text: 'Listing database rows in Notion' };
  if (name !== 'Bash') return null;
  const cmd = input.command || '';
  let m;
  if ((m = cmd.match(/kb-state\.mjs record \S+ \S+ (?:"([^"]*)"|'([^']*)')/))) return { kind: 'saved', text: `Saved “${m[1] ?? m[2]}”` };
  if ((m = cmd.match(/kb-state\.mjs skip (\S+)/))) return { kind: 'skipped', text: `Unchanged “${titleForId(m[1]) || m[1]}”` };
  if ((m = cmd.match(/kb-state\.mjs fail (\S+) (.*)/))) return { kind: 'failed', text: `Failed: ${m[2]}` };
  if (/kb-state\.mjs pending/.test(cmd)) return { kind: 'info', text: 'Batch limit reached; the rest is saved for the next sync' };
  if (/kb-state\.mjs start/.test(cmd)) return { kind: 'info', text: 'Sync started' };
  return null;
}

function startSync() {
  if (sync.child) return false;
  sync.log = []; sync.result = null;
  const child = runClaude('/kb-sync', SYNC_ARGS);
  sync.child = child;
  syncEmit({ type: 'step', kind: 'info', text: 'Starting Claude Code' });
  onEvents(child, (ev) => {
    if (ev.type === 'tool') {
      const d = describeSyncTool(ev);
      if (d) syncEmit({ type: 'step', ...d });
    } else if (ev.type === 'result') {
      sync.result = { type: 'done', ok: ev.ok, markdown: ev.text, ms: ev.ms };
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.on('error', (err) => { sync.result = { type: 'done', ok: false, markdown: `Could not start claude (${err.code}).` }; });
  child.on('close', (code, signal) => {
    sync.child = null;
    if (signal || sync.stopped) {
      // Close the interrupted run so the history stays honest. Saved pages stay ingested.
      try { execFileSync('node', ['scripts/kb-state.mjs', 'abort', 'stopped from the web UI'], { cwd: ROOT }); } catch {}
      sync.result = { type: 'done', ok: false, stopped: true, markdown: 'Pages saved so far are kept. The next sync picks up where this one stopped.' };
    }
    sync.stopped = false;
    syncEmit(sync.result || { type: 'done', ok: false, markdown: `Sync ended unexpectedly (exit ${code}). ${stderr.trim().split('\n').at(-1) || ''}` });
    syncEmit({ type: 'status', status: status() });
    for (const l of sync.listeners) l.end();
    sync.listeners.clear();
  });
  return true;
}

function handleSyncEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  for (const ev of sync.log) res.write(JSON.stringify(ev) + '\n'); // replay for reloaded pages
  if (!sync.child) return res.end();
  sync.listeners.add(res);
  res.on('close', () => sync.listeners.delete(res));
}

// ---------- http ----------

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Only this page may drive the server: blocks other websites and DNS-rebinding tricks.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function trusted(req) {
  if (!HOSTS.has(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  return origin && HOSTS.has(origin.replace(/^http:\/\//, '')) && req.headers['content-type']?.startsWith('application/json');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(ROOT, 'public/index.html')).pipe(res);
  }
  if (route === 'GET /api/status') return sendJson(res, 200, status());
  if (route === 'POST /api/ask') return handleAsk(req, res, await readBody(req));
  if (route === 'POST /api/feedback') return handleRating(res, await readBody(req));
  if (route === 'POST /api/feedback/context') return handleAddContext(res, await readBody(req));
  if (route === 'POST /api/sync') return sendJson(res, startSync() ? 202 : 409, status());
  if (route === 'GET /api/sync/events') return handleSyncEvents(req, res);
  if (route === 'POST /api/sync/stop') {
    if (sync.child) { sync.stopped = true; sync.child.kill('SIGTERM'); }
    return sendJson(res, 202, { stopping: true });
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already in use, probably by another copy of this server.`);
  console.error(`Stop it, or start on another port: PORT=${PORT + 1} npm start`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Knowledge harness running at http://localhost:${PORT} (model: ${MODEL})`);
});

process.on('SIGINT', () => { sync.child?.kill('SIGTERM'); process.exit(0); });
