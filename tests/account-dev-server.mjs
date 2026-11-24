// The account server on this computer, for the browser walk-through (tests/ui): the real
// worker (server/worker.js with server/accounts.js) over a database in memory, with a list
// in place of the mail service. Nothing here is the live server and nothing leaves the Mac.
//
//   node tests/account-dev-server.mjs [port]          (default 8791)
//
// Beside the worker's own routes it answers two of its own, for the test to read and steer:
//   GET /__test/code?email=...     the code last "sent" to that address
//   GET /__test/ways?email=0|1     switch the e-mail way off or on
//   GET /__test/clock?add=<ms>     move the server's clock forward (codes are limited to one a minute)
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../server/worker.js';

const port = Number(process.argv[2]) || 8791;
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
const prepare = (sql) => {
  let args = [];
  const st = {
    bind: (...a) => { args = a; return st; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  };
  return st;
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const sent = new Map(); // address -> the code last sent to it
let mailOn = true;
let ahead = 0; // how far the test has moved the clock
const env = {
  DB: { prepare, batch: async (list) => { for (const s of list) await s.run(); } },
  ALLOWED_ORIGINS: '',
  now: () => Date.now() + ahead,
  get sendMail() { return mailOn ? async (to, mail) => { sent.set(to, mail.text.match(/\b(\d{6})\b/)?.[1] || ''); } : undefined; },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.pathname === '/__test/code') { res.writeHead(200, cors); res.end(sent.get(String(url.searchParams.get('email')).toLowerCase()) || ''); return; }
  if (url.pathname === '/__test/clock') { ahead += Number(url.searchParams.get('add')) || 0; res.writeHead(200, cors); res.end('ok'); return; }
  if (url.pathname === '/__test/ways') { mailOn = url.searchParams.get('email') !== '0'; res.writeHead(200, cors); res.end('ok'); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host') headers.set(k, v);
  const answer = await worker.fetch(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  res.end(Buffer.from(await answer.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`account dev server on http://127.0.0.1:${port}`));
