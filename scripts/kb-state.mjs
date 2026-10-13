#!/usr/bin/env node
// Run history + ingest ledger for kb-sync. No dependencies.
//
//   node scripts/kb-state.mjs sources                  -> sync roots from .kb/sources.json
//   node scripts/kb-state.mjs start                    -> begin a run
//   node scripts/kb-state.mjs check <id> <last_edited> -> new | changed | unchanged
//   node scripts/kb-state.mjs record <id> <last_edited> <title> <url> <file>
//   node scripts/kb-state.mjs record-empty <id> <last_edited>  -> database row with no body: lives in the index only
//   node scripts/kb-state.mjs database <rows.json>     -> index a database, print the rows to fetch
//   node scripts/kb-state.mjs skip <id>                -> unchanged page seen this run
//   node scripts/kb-state.mjs fail <id> <reason>
//   node scripts/kb-state.mjs pending <id...>          -> unvisited pages when max_pages is hit
//   node scripts/kb-state.mjs finish                   -> close run, rebuild touched indexes, append to history
//   node scripts/kb-state.mjs abort [reason]           -> close an interrupted run
//   node scripts/kb-state.mjs history [n]              -> last n runs
//   node scripts/kb-state.mjs redact <file...>         -> redact secrets in existing files
//
// State entries are keyed by Notion id (no dashes). `kind` is page, row or database.
// Rows carry `database_id` and `properties`; a row with no body has `file: null`.

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
fs.mkdirSync(path.join(KB, 'incoming'), { recursive: true }); // kb-sync drops database rows here

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const normId = (id) => String(id).replace(/-/g, '').toLowerCase();
// Last Notion id in the URL path. The query string is ignored: `?v=` holds a view id, not the page's.
const idFromUrl = (url) => {
  const ids = String(url).split(/[?#]/)[0].match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return ids ? ids.at(-1).replace(/-/g, '').toLowerCase() : '';
};
const die = (msg) => { console.error(msg); process.exit(1); };
const abs = (file) => path.join(ROOT, file);
const exists = (file) => Boolean(file) && fs.existsSync(abs(file));
const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';

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

const touch = (run, entry) => {
  if (entry?.database_id) run.databases = [...new Set([...(run.databases || []), entry.database_id])];
};
const fetchBudgetLeft = (run) => {
  const max = Number(readJson(SOURCES, {}).max_pages) || Infinity;
  return Math.max(0, max - (run.fetched || 0));
};

// ---------- database index (one Markdown table per database) ----------

const plain = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(plain).filter(Boolean).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const cell = (v) => plain(v).replace(/\*\*/g, '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
const columnLabel = (name) => name.replace(/^userDefined:/, '');

function buildIndex(dbKey) {
  const db = state[dbKey];
  if (!db || db.kind !== 'database') return 0;
  const rows = db.row_ids.map((k) => state[k]).filter(Boolean);
  const cols = db.columns.filter((c) => c !== db.title_property);
  const head = [columnLabel(db.title_property), ...cols.map(columnLabel), 'Page'];
  const lines = rows.map((r) => {
    const title = cell(r.properties?.[db.title_property] ?? r.title).replace(/[[\]]/g, '\\$&') || 'Untitled';
    return `| [${title}](${r.url}) | ${cols.map((c) => cell(r.properties?.[c])).join(' | ')} | ${exists(r.file) ? `\`${r.file}\`` : ''} |`;
  });
  const md = [
    '---',
    `notion_id: ${dbKey}`,
    `title: ${db.title}`,
    `url: ${db.url}`,
    'type: database',
    `rows: ${rows.length}`,
    `last_edited: ${db.last_edited || ''}`,
    `path: ${db.path || ''}`,
    '---',
    '',
    `# ${db.title}`,
    '',
    `Notion database with ${rows.length} rows. Rows that have their own notes list their file in the Page column.`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...lines,
    '',
  ].join('\n');
  const { text, count } = redactText(md);
  fs.writeFileSync(abs(db.file), text);
  return count;
}

// ---------- commands ----------

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
      new: [], changed: [], unchanged: 0, failed: [], seen: [], fetched: 0,
    };
    writeJson(CURRENT, run);
    console.log(run.run_id);
    break;
  }

  case 'check': {
    const [id, lastEdited] = args;
    if (!id || !lastEdited) die('usage: check <id> <last_edited>');
    const prev = state[normId(id)];
    if (!prev || !prev.ingested_at) console.log('new');                 // unknown, or a row listed but never fetched
    else if (prev.needs_check) console.log('changed');                   // database said its edit time moved
    else if (prev.file ? !exists(prev.file) : prev.kind !== 'row') console.log('new');
    else if (prev.last_edited !== lastEdited) console.log('changed');
    else console.log('unchanged');
    break;
  }

  case 'record': {
    const [id, lastEdited, title, url, file] = args;
    if (!file) die('usage: record <id> <last_edited> <title> <url> <file>');
    if (!exists(file)) die(`File not found: ${file}. Write it before recording.`);
    const redacted = redactFile(abs(file));
    const run = currentRun();
    const key = normId(id);
    const prev = state[key];
    // Page was renamed -> remove the old file so it is not answered from twice.
    if (prev?.file && prev.file !== file && exists(prev.file)) fs.unlinkSync(abs(prev.file));
    const wasIngested = Boolean(prev?.ingested_at);
    state[key] = { kind: 'page', ...prev, title, url, file, last_edited: lastEdited, needs_check: false, ingested_at: new Date().toISOString(), run_id: run.run_id };
    writeJson(STATE, state);
    (wasIngested ? run.changed : run.new).push(title);
    run.seen.push(key);
    run.fetched = (run.fetched || 0) + 1;
    run.redacted = (run.redacted || 0) + redacted;
    touch(run, state[key]);
    writeJson(CURRENT, run);
    console.log(`${wasIngested ? 'recorded (changed)' : 'recorded (new)'}${redacted ? `, ${redacted} secret(s) redacted by safety net` : ''}`);
    break;
  }

  case 'record-empty': {
    // A database row whose page has no body: its properties already live in the index.
    const [id, lastEdited] = args;
    if (!lastEdited) die('usage: record-empty <id> <last_edited>');
    const key = normId(id);
    const prev = state[key];
    if (prev?.kind !== 'row') die(`${id} is not a known database row. Use record for pages.`);
    const run = currentRun();
    if (prev.file && exists(prev.file)) fs.unlinkSync(abs(prev.file));
    const wasIngested = Boolean(prev.ingested_at);
    state[key] = { ...prev, file: null, last_edited: lastEdited, needs_check: false, ingested_at: new Date().toISOString(), run_id: run.run_id };
    writeJson(STATE, state);
    (wasIngested ? run.changed : run.new).push(prev.title);
    run.seen.push(key);
    run.fetched = (run.fetched || 0) + 1;
    touch(run, prev);
    writeJson(CURRENT, run);
    console.log(wasIngested ? 'recorded (changed, index only)' : 'recorded (new, index only)');
    break;
  }

  case 'database': {
    // Input: JSON written by kb-sync from notion-query-data-sources results.
    //   { id, title, url, path, title_property, edited_property|null, columns: [...], rows: [{ url, properties }] }
    const [jsonFile] = args;
    if (!jsonFile) die('usage: database <rows.json>');
    const db = readJson(path.resolve(jsonFile), null);
    if (!db?.rows || !db.title_property || !Array.isArray(db.columns)) die(`Invalid database file: ${jsonFile}`);
    const run = currentRun();
    const dbKey = normId(db.id || idFromUrl(db.url));
    const prevDb = state[dbKey];
    const file = `context/notion/${slugify(db.title)}-${dbKey.slice(0, 8)}.md`;
    if (prevDb?.file && prevDb.file !== file && exists(prevDb.file)) fs.unlinkSync(abs(prevDb.file));

    const rowIds = [];
    const toFetch = [];
    let unchanged = 0;
    let latest = '';
    for (const row of db.rows) {
      const key = normId(row.id || idFromUrl(row.url));
      if (!key || rowIds.includes(key)) continue;
      rowIds.push(key);
      const edited = db.edited_property ? plain(row.properties?.[db.edited_property]) || null : null;
      if (edited && edited > latest) latest = edited;
      const prev = state[key];
      const meta = { kind: 'row', database_id: dbKey, title: cell(row.properties?.[db.title_property]) || 'Untitled', url: row.url.replace(/\?.*$/, ''), properties: row.properties || {} };
      const current = prev?.ingested_at && edited && prev.last_edited === edited && !prev.needs_check && (prev.file === null || exists(prev.file));
      if (current) {
        state[key] = { ...prev, ...meta };
        run.seen.push(key);
        unchanged++;
      } else {
        // Keep the last fetched edit time; `check` compares against it after the fetch.
        state[key] = { ...prev, ...meta, needs_check: Boolean(prev?.ingested_at && edited && prev.last_edited !== edited) };
        toFetch.push(key);
      }
    }

    state[dbKey] = {
      kind: 'database', title: db.title, url: db.url.replace(/\?.*$/, ''), path: db.path || '', file,
      title_property: db.title_property, edited_property: db.edited_property || null,
      columns: db.columns, row_ids: rowIds, last_edited: latest || null,
      ingested_at: new Date().toISOString(), run_id: run.run_id,
    };
    writeJson(STATE, state);
    const redacted = buildIndex(dbKey);

    // Spend the remaining fetch budget on rows; queue the rest for the next run.
    const budget = fetchBudgetLeft(run);
    const now = toFetch.slice(0, budget);
    const later = toFetch.slice(budget);
    run.seen.push(dbKey);
    run.unchanged += unchanged;
    run.redacted = (run.redacted || 0) + redacted;
    run.databases = [...new Set([...(run.databases || []), dbKey])];
    if (later.length) run.pending = [...new Set([...(run.pending || []), ...later])];
    writeJson(CURRENT, run);
    fs.rmSync(path.resolve(jsonFile), { force: true });

    console.log(JSON.stringify({ database: db.title, index: file, rows: rowIds.length, unchanged, fetch_now: now, queued_for_next_run: later.length }, null, 2));
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
    run.fetched = (run.fetched || 0) + 1;
    writeJson(CURRENT, run);
    console.log('skipped');
    break;
  }

  case 'fail': {
    const run = currentRun();
    run.failed.push({ id: normId(args[0]), reason: args.slice(1).join(' ') });
    run.seen.push(normId(args[0]));
    run.fetched = (run.fetched || 0) + 1;
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
    // Row files written this run change the index's Page column: rebuild touched indexes.
    for (const dbKey of run.databases || []) run.redacted = (run.redacted || 0) + buildIndex(dbKey);
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
    for (const dbKey of run.databases || []) buildIndex(dbKey);
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
    die('commands: sources | start | check | record | record-empty | database | skip | fail | pending | finish | abort | history | redact');
}
