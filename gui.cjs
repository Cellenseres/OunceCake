#!/usr/bin/env node
// Local web GUI for OunceCake. Usage: node gui.cjs [--port 8765]
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { exec } = require('node:child_process');
const { titleId, withCleanup } = require('./engine/protocol.cjs');
const { attachGame } = require('./engine/session.cjs');
const { discoverGames } = require('./engine/content.cjs');
const { prepareGame } = require('./engine/mounts.cjs');
const { dumpAllNcas } = require('./engine/nca-dump.cjs');
const { deployServer, readImage } = require('./engine/server.cjs');

const storageNames = { 2: 'Game card', 4: 'Internal', 5: 'SD' };
const token = crypto.randomBytes(16).toString('hex');

const state = {
  phase: 'idle', // idle | connecting | ready | working | serving | error
  message: '',
  games: [],
  serverUrl: null,
  logs: [],
};
let attachment = null;
let cancellation = null;

function log(line) {
  state.logs.push(line);
  if (state.logs.length > 500) state.logs.shift();
}

for (const level of ['log', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    log(args.join(' '));
    original(...args);
  };
}

const publicState = () => ({
  phase: state.phase,
  message: state.message,
  serverUrl: state.serverUrl,
  logs: state.logs,
  games: state.games.map((g) => ({
    title: g.title,
    name: g.name || 'Unknown title',
    storages: g.storages.map((id) => storageNames[id] || 'Storage ' + id),
  })),
});

async function closeAttachment() {
  const current = attachment;
  attachment = null;
  if (current) await current.close();
}

function fail(error) {
  state.phase = 'error';
  state.message = error.message.split('\n')[0];
  log('Error: ' + error.message);
}

async function connect({ run }) {
  if (state.phase !== 'idle' && state.phase !== 'error') throw new Error('Busy');
  if (!run || typeof run !== 'string') throw new Error('Enter the run directory');
  state.phase = 'connecting';
  state.message = '';
  state.games = [];
  state.logs = [];
  cancellation = new AbortController();
  const shouldStop = () => cancellation.signal.aborted;
  (async () => {
    try {
      attachment = await attachGame(path.resolve(run));
      const games = await discoverGames({ ...attachment, shouldStop });
      if (shouldStop()) throw new Error('Cancelled');
      if (!games.length) throw new Error('No games were found');
      state.games = games;
      state.phase = 'ready';
    } catch (error) {
      await closeAttachment().catch(() => {});
      if (cancellation.signal.aborted) {
        state.phase = 'idle';
        state.message = '';
      } else {
        fail(error);
      }
    }
  })();
}

async function start(options) {
  if (state.phase !== 'ready') throw new Error('Connect first');
  const title = titleId(options.title);
  const port = Number(options.port || 8080);
  if (!options.nca && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error('Port must be 1024-65535');
  }
  const out = path.resolve(options.out || 'nca-dump');
  state.phase = 'working';
  state.message = '';
  cancellation = new AbortController();
  const shouldStop = () => cancellation.signal.aborted;
  let server;
  (async () => {
    try {
      await withCleanup(async () => {
        if (options.nca) {
          const results = await dumpAllNcas({
            attachment, title, outDir: out, skipProgram: Boolean(options.skipProgram), shouldStop,
          });
          for (const r of results) console.log('Dumped: ' + r.name + ' -> ' + r.path + ' (' + r.size + ' bytes)');
          state.message = 'NCA export finished: ' + out;
          return;
        }
        const image = await readImage();
        const prepared = await prepareGame({ attachment, title, baseOnly: Boolean(options.baseOnly), shouldStop });
        if (shouldStop()) return;
        server = await deployServer({ attachment, image, ...prepared, port });
        state.serverUrl = 'http://' + (server.address || '<console ip>') + ':' + port + '/';
        state.phase = 'serving';
        console.log('Serving on ' + state.serverUrl);
        while (!shouldStop()) await new Promise((resolve) => setTimeout(resolve, 500));
      }, () => server?.close(), () => closeAttachment());
      state.phase = 'idle';
      state.serverUrl = null;
      state.games = [];
    } catch (error) {
      state.serverUrl = null;
      state.games = [];
      fail(error);
    }
  })();
}

async function stop() {
  if (!cancellation) return;
  cancellation.abort();
  if (state.phase === 'ready') {
    await closeAttachment();
    state.phase = 'idle';
    state.games = [];
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OunceCake</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark light}
body{font:15px system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem}
h1{margin-bottom:.2rem}
.card{border:1px solid #8884;border-radius:8px;padding:1rem;margin:1rem 0}
input[type=text],input[type=number]{padding:.4rem;width:100%;box-sizing:border-box}
label{display:block;margin:.5rem 0}
label.inline{display:inline-block;margin-right:1rem}
button{padding:.45rem 1rem;margin-right:.5rem;cursor:pointer}
table{width:100%;border-collapse:collapse}
td,th{padding:.35rem .5rem;text-align:left;border-bottom:1px solid #8883}
tr.game{cursor:pointer}tr.game:hover{background:#8882}tr.sel{background:#4a90e233}
pre{background:#0004;padding:.6rem;max-height:260px;overflow:auto;white-space:pre-wrap;border-radius:6px}
.err{color:#e5534b}.ok{color:#3fb950}
#filter{margin-bottom:.5rem}
</style></head><body>
<h1>OunceCake</h1>
<div id="status"></div>

<div class="card" id="connectCard">
  <label>Run directory (from ns2jb)<input type="text" id="run" placeholder="C:\\path\\to\\run"></label>
  <button id="connect">Connect and list games</button>
</div>

<div class="card" id="gamesCard" hidden>
  <input type="text" id="filter" placeholder="Filter games...">
  <table><thead><tr><th>Name</th><th>Title ID</th><th>Storage</th></tr></thead><tbody id="games"></tbody></table>
</div>

<div class="card" id="optionsCard" hidden>
  <div>
    <label class="inline"><input type="radio" name="mode" value="serve" checked> Serve files (HTTP/WebDAV)</label>
    <label class="inline"><input type="radio" name="mode" value="nca"> Export raw NCAs</label>
  </div>
  <div id="serveOpts">
    <label>Port<input type="number" id="port" value="8080" min="1024" max="65535"></label>
    <label><input type="checkbox" id="baseOnly"> Base only (skip updates and DLC)</label>
  </div>
  <div id="ncaOpts" hidden>
    <label>Output folder<input type="text" id="out" value="nca-dump"></label>
    <label><input type="checkbox" id="skipProgram"> Skip Program NCA</label>
  </div>
  <p id="selected">No game selected.</p>
  <button id="start" disabled>Start</button>
  <button id="cancel">Disconnect</button>
</div>

<div class="card" id="workCard" hidden>
  <div id="serving"></div>
  <button id="stop">Stop</button>
</div>

<h3>Log</h3>
<pre id="log"></pre>

<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
let selected = null, lastGames = '', lastPhase = '';

async function api(name, body) {
  const res = await fetch('/api/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) { $('status').textContent = data.error; $('status').className = 'err'; }
  return data;
}

function renderGames(games) {
  const key = JSON.stringify(games);
  if (key === lastGames) return;
  lastGames = key;
  const tbody = $('games');
  tbody.textContent = '';
  const filter = $('filter').value.toLowerCase();
  for (const g of games) {
    if (filter && !(g.name + ' ' + g.title).toLowerCase().includes(filter)) continue;
    const tr = document.createElement('tr');
    tr.className = 'game' + (selected === g.title ? ' sel' : '');
    for (const text of [g.name, g.title.toUpperCase(), g.storages.join(', ')]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tr.onclick = () => {
      selected = g.title;
      $('selected').textContent = 'Selected: ' + g.name + ' [' + g.title.toUpperCase() + ']';
      $('start').disabled = false;
      lastGames = '';
      renderGames(games);
    };
    tbody.appendChild(tr);
  }
}

async function poll() {
  try {
    const s = await (await fetch('/api/state', { headers: { 'X-Token': TOKEN } })).json();
    const p = s.phase;
    $('connectCard').hidden = !(p === 'idle' || p === 'error' || p === 'connecting');
    $('connect').disabled = p === 'connecting';
    $('gamesCard').hidden = p !== 'ready';
    $('optionsCard').hidden = p !== 'ready';
    $('workCard').hidden = !(p === 'working' || p === 'serving' || p === 'connecting');
    if (p !== 'ready' && lastPhase === 'ready') { selected = null; lastGames = ''; $('start').disabled = true; $('selected').textContent = 'No game selected.'; }
    lastPhase = p;
    const labels = { idle: 'Idle', connecting: 'Connecting and reading the game list...', ready: 'Connected. Pick a game.', working: 'Working... (updates can take a long time)', serving: 'Serving', error: 'Error' };
    const st = $('status');
    st.textContent = labels[p] + (s.message ? ': ' + s.message : '');
    st.className = p === 'error' ? 'err' : p === 'serving' ? 'ok' : '';
    $('serving').textContent = '';
    if (s.serverUrl) {
      const a = document.createElement('a');
      a.href = s.serverUrl; a.target = '_blank'; a.textContent = s.serverUrl;
      $('serving').append('Open: ', a, ' (also read-only WebDAV)');
    }
    renderGames(s.games);
    const log = $('log');
    const text = s.logs.join('\\n');
    if (log.textContent !== text) { log.textContent = text; log.scrollTop = log.scrollHeight; }
  } catch (e) { $('status').textContent = 'GUI server not reachable'; }
}

$('connect').onclick = () => api('connect', { run: $('run').value.trim() });
$('start').onclick = () => {
  const nca = document.querySelector('input[name=mode]:checked').value === 'nca';
  api('start', { title: selected, nca, port: $('port').value, baseOnly: $('baseOnly').checked, out: $('out').value, skipProgram: $('skipProgram').checked });
};
$('cancel').onclick = () => api('stop');
$('stop').onclick = () => api('stop');
$('filter').oninput = () => { lastGames = ''; poll(); };
for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = () => {
  const nca = document.querySelector('input[name=mode]:checked').value === 'nca';
  $('serveOpts').hidden = nca; $('ncaOpts').hidden = !nca;
};
setInterval(poll, 1000); poll();
</script></body></html>`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65536) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function createGuiServer(port) {
  const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    // Host check blocks DNS rebinding; the token blocks other local pages.
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'Forbidden' });
    if (req.method === 'GET' && req.url === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.headers['x-token'] !== token) return send(res, 403, { error: 'Forbidden' });

    try {
      if (req.method === 'GET' && req.url === '/api/state') return send(res, 200, publicState());
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (req.url === '/api/connect') await connect(body);
        else if (req.url === '/api/start') await start(body);
        else if (req.url === '/api/stop') await stop();
        else return send(res, 404, { error: 'Not found' });
        return send(res, 200, publicState());
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  });
}

function parsePort(argv) {
  const i = argv.indexOf('--port');
  if (i === -1) return 8765;
  const port = Number(argv[i + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid --port value');
  return port;
}

function main(argv = process.argv.slice(2)) {
  const port = parsePort(argv);
  const server = createGuiServer(port);
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port + '/';
    console.log('OunceCake GUI: ' + url);
    if (!argv.includes('--no-open')) {
      const command = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(command + ' ' + url, () => {});
    }
  });
  const shutdown = async () => {
    cancellation?.abort();
    await closeAttachment().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { createGuiServer, main };
