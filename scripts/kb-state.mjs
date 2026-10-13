#!/usr/bin/env node
// Run history + ingest ledger for kb-sync. No dependencies.
//
//   node scripts/kb-state.mjs sources                  -> sync roots from .kb/sources.json
//   node scripts/kb-state.mjs start                    -> begin a run
//   node scripts/kb-state.mjs check <id> <last_edited> -> new | changed | unchanged
//   node scripts/kb-state.mjs record <id> <last_edited> <title> <url> <file>
//   node scripts/kb-state.mjs skip <id>                -> unchanged page seen this run
//   node scripts/kb-state.mjs fail <id> <reason>
//   node scripts/kb-state.mjs pending <id...>          -> unvisited pages when max_pages is hit
//   node scripts/kb-state.mjs finish                   -> close run, append to history
//   node scripts/kb-state.mjs abort [reason]           -> close an interrupted run
//   node scripts/kb-state.mjs history [n]              -> last n runs
//   node scripts/kb-state.mjs redact <file...>         -> redact secrets in existing files

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from './redact.mjs';

// KB_ROOT lets tests point the script at a scratch folder.
const ROOT = process.env.KB_ROOT ? path.resolve(process.env.KB_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, '.kb');
const STATE = path.join(KB, 'sync-state.json');
const RUNS = path.join(KB, 'sync-runs.jsonl');
const CURRENT = path.join(KB, 'current-run.json');
const SOURCES = path.join(KB, 'sources.json');
const QUEUE = path.join(KB, 'sync-queue.json');
fs.mkdirSync(KB, { recursive: true });

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const normId = (id) => String(id).replace(/-/g, '').toLowerCase();
const die = (msg) => { console.error(msg); process.exit(1); };

function redactFile(file) {
  const { text, count } = redactText(fs.readFileSync(file, 'utf8'));
  if (count) fs.writeFileSync(file, text);
  return count;
}

function currentRun() {
  const run = readJson(CURRENT, null);
  if (!run) die('No run in progress. Call `start` first.');
  return run;
}

const [cmd, ...args] = process.argv.slice(2);
const state = readJson(STATE, {});

switch (cmd) {
  case 'sources': {
    const src = readJson(SOURCES, null);
    if (!src || !src.roots?.length) die('No sources configured. Copy .kb/sources.example.json to .kb/sources.json and list your Notion root pages.');
    // `resume` = pages left over when the previous run hit max_pages.
    console.log(JSON.stringify({ ...src, resume: readJson(QUEUE, []) }, null, 2));
    break;
  }

  case 'start': {
    if (fs.existsSync(CURRENT)) {
      // A previous run crashed; close it as failed so history stays honest.
      const stale = readJson(CURRENT, {});
      fs.appendFileSync(RUNS, JSON.stringify({ ...stale, finished_at: new Date().toISOString(), status: 'aborted' }) + '\n');
    }
    const run = {
      run_id: new Date().toISOString().replace(/[:.]/g, '-'),
      started_at: new Date().toISOString(),
      new: [], changed: [], unchanged: 0, failed: [], seen: [],
    };
    writeJson(CURRENT, run);
    console.log(run.run_id);
    break;
  }

  case 'check': {
    const [id, lastEdited] = args;
    if (!id || !lastEdited) die('usage: check <id> <last_edited>');
    const prev = state[normId(id)];
    const file = prev && path.join(ROOT, prev.file);
    if (!prev || !fs.existsSync(file)) console.log('new');
    else if (prev.last_edited !== lastEdited) console.log('changed');
    else console.log('unchanged');
    break;
  }

  case 'record': {
    const [id, lastEdited, title, url, file] = args;
    if (!file) die('usage: record <id> <last_edited> <title> <url> <file>');
    if (!fs.existsSync(path.join(ROOT, file))) die(`File not found: ${file}. Write it before recording.`);
    const redacted = redactFile(path.join(ROOT, file));
    const run = currentRun();
    const key = normId(id);
    const prev = state[key];
    // Page was renamed -> remove the old file so it is not answered from twice.
    if (prev && prev.file !== file && fs.existsSync(path.join(ROOT, prev.file))) {
      fs.unlinkSync(path.join(ROOT, prev.file));
    }
    state[key] = { title, url, file, last_edited: lastEdited, ingested_at: new Date().toISOString(), run_id: run.run_id };
    writeJson(STATE, state);
    (prev ? run.changed : run.new).push(title);
    run.seen.push(key);
    writeJson(CURRENT, run);
    run.redacted = (run.redacted || 0) + redacted;
    writeJson(CURRENT, run);
    console.log(`${prev ? 'recorded (changed)' : 'recorded (new)'}${redacted ? `, ${redacted} secret(s) redacted by safety net` : ''}`);
    break;
  }

  case 'redact': {
    // One-off pass over existing files: node scripts/kb-state.mjs redact context/notion/*.md
    let total = 0;
    for (const f of args) {
      const n = redactFile(path.resolve(f));
      if (n) console.log(`${n}\t${path.relative(ROOT, path.resolve(f))}`);
      total += n;
    }
    console.log(`total: ${total}`);
    break;
  }

  case 'skip': {
    const run = currentRun();
    run.unchanged += 1;
    run.seen.push(normId(args[0]));
    writeJson(CURRENT, run);
    console.log('skipped');
    break;
  }

  case 'fail': {
    const run = currentRun();
    run.failed.push({ id: normId(args[0]), reason: args.slice(1).join(' ') });
    run.seen.push(normId(args[0]));
    writeJson(CURRENT, run);
    console.log('noted');
    break;
  }

  case 'pending': {
    // Page ids still unvisited when max_pages was reached. Saved by `finish`.
    const run = currentRun();
    run.pending = [...new Set([...(run.pending || []), ...args.map(normId)])];
    writeJson(CURRENT, run);
    console.log(`${run.pending.length} pending`);
    break;
  }

  case 'finish': {
    const run = currentRun();
    const pending = run.pending || [];
    const seen = new Set(run.seen);
    // Only a complete walk can tell which pages vanished from Notion.
    const missing = pending.length || readJson(QUEUE, []).length
      ? []
      : Object.entries(state).filter(([k]) => !seen.has(k)).map(([, v]) => v.title);
    const { seen: _, pending: __, ...summary } = run;
    const entry = {
      ...summary,
      finished_at: new Date().toISOString(),
      status: pending.length ? 'incomplete' : run.failed.length ? 'partial' : 'ok',
      pending: pending.length,
      not_found_in_notion: missing,
    };
    fs.appendFileSync(RUNS, JSON.stringify(entry) + '\n');
    fs.unlinkSync(CURRENT);
    if (pending.length) writeJson(QUEUE, pending);
    else fs.rmSync(QUEUE, { force: true });
    console.log(JSON.stringify(entry, null, 2));
    break;
  }

  case 'abort': {
    // Close an interrupted run. Pages already recorded stay ingested.
    const run = currentRun();
    const { seen: _, ...summary } = run;
    const entry = { ...summary, finished_at: new Date().toISOString(), status: 'aborted', reason: args.join(' ') || 'stopped' };
    fs.appendFileSync(RUNS, JSON.stringify(entry) + '\n');
    fs.unlinkSync(CURRENT);
    console.log(`aborted run ${run.run_id}: ${run.new.length} new, ${run.changed.length} changed kept`);
    break;
  }

  case 'history': {
    const n = Number(args[0] || 10);
    const lines = fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean) : [];
    console.log(JSON.stringify(lines.slice(-n).map((l) => JSON.parse(l)), null, 2));
    break;
  }

  default:
    die('commands: sources | start | check | record | skip | fail | pending | finish | abort | history | redact');
}
