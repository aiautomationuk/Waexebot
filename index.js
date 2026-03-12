require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { startBot } = require('./src/bot');

// ── Resolve data directory ────────────────────────────────────────────────────
const requestedDir = process.env.DATA_DIR || path.join(__dirname, 'data');
try {
  fs.mkdirSync(requestedDir, { recursive: true });
  process.env.DATA_DIR = requestedDir;
  console.log(`[Main] Data directory: ${requestedDir}`);
} catch (err) {
  const fallback = path.join(__dirname, 'data');
  console.warn(`[Main] Cannot use ${requestedDir} (${err.code}) — falling back to ${fallback}`);
  fs.mkdirSync(fallback, { recursive: true });
  process.env.DATA_DIR = fallback;
}

// ── Parse accounts from environment ──────────────────────────────────────────
// Multi-account: set ACCOUNT_1_NAME, ACCOUNT_1_ASSISTANT_ID, ACCOUNT_1_API_KEY
//                    ACCOUNT_2_NAME, ACCOUNT_2_ASSISTANT_ID, ACCOUNT_2_API_KEY  etc.
// Single account fallback: just set ASSISTANT_ID + OPENAI_API_KEY
function parseAccounts() {
  const accounts = [];
  for (let i = 1; i <= 20; i++) {
    const assistantId = process.env[`ACCOUNT_${i}_ASSISTANT_ID`];
    if (!assistantId) break;
    const apiKey = process.env[`ACCOUNT_${i}_OPENAI_API_KEY`] || process.env[`ACCOUNT_${i}_API_KEY`] || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(`[Main] ACCOUNT_${i}_OPENAI_API_KEY not set and no OPENAI_API_KEY fallback — skipping.`);
      continue;
    }
    accounts.push({
      id: (process.env[`ACCOUNT_${i}_NAME`] || `account${i}`).replace(/\s+/g, '_'),
      assistantId,
      apiKey,
    });
  }
  // Single-account fallback
  if (accounts.length === 0) {
    if (!process.env.ASSISTANT_ID || !process.env.OPENAI_API_KEY) {
      console.error('[Main] Missing ASSISTANT_ID or OPENAI_API_KEY. Set them in your environment.');
      process.exit(1);
    }
    accounts.push({
      id: 'default',
      assistantId: process.env.ASSISTANT_ID,
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return accounts;
}

const accounts = parseAccounts();
console.log(`[Main] Loaded ${accounts.length} account(s): ${accounts.map(a => a.id).join(', ')}`);

// ── Global state (updated by each bot instance) ───────────────────────────────
global.botAccounts = {};
for (const acc of accounts) {
  global.botAccounts[acc.id] = { id: acc.id, status: 'starting', qr: null };
}

// ── Express web server ────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
  const states = Object.values(global.botAccounts);
  const cards = states.map(acc => {
    if (acc.status === 'connected') {
      return `<div class="card" id="card-${acc.id}">
        <h3>${acc.id}</h3>
        <div class="connected">✓ Connected</div>
      </div>`;
    }
    if (acc.qr) {
      return `<div class="card" id="card-${acc.id}">
        <h3>${acc.id}</h3>
        <img id="qr-${acc.id}" src="/qr/${acc.id}.png" alt="QR Code" style="display:block;margin:0 auto"/>
        <div class="countdown" id="cd-${acc.id}">QR refreshes in <span>18s</span></div>
        <div class="steps">
          <b>How to scan:</b><br>
          1. Open WhatsApp on your phone<br>
          2. Tap <b>Settings</b> (bottom right)<br>
          3. Tap <b>Linked Devices</b><br>
          4. Tap <b>Link a Device</b><br>
          5. Point camera at the QR above
        </div>
      </div>`;
    }
    return `<div class="card" id="card-${acc.id}">
      <h3>${acc.id}</h3>
      <div class="waiting">⏳ ${acc.status}…</div>
    </div>`;
  }).join('');

  const accountIds = Object.keys(global.botAccounts);
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>WaRenderBot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: sans-serif; background: #f0f0f0; margin: 0; padding: 24px; }
    h1 { text-align: center; color: #128C7E; margin-bottom: 24px; }
    .grid { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; }
    .card { background: white; padding: 24px; border-radius: 16px;
            box-shadow: 0 4px 16px #0002; text-align: center; width: 300px; }
    .card h3 { margin: 0 0 12px; color: #333; font-size: 18px; }
    .connected { color: #25D366; font-size: 20px; font-weight: bold; padding: 20px 0; }
    .waiting { color: #999; padding: 20px 0; }
    img { width: 240px; height: 240px; border-radius: 8px; border: 1px solid #eee; }
    .hint { font-size: 13px; color: #555; margin: 0 0 12px; }
    .countdown { font-size: 12px; color: #aaa; margin-top: 8px; }
    .countdown span { font-weight: bold; color: #888; }
    .steps { font-size: 12px; color: #888; margin-top: 10px; line-height: 1.7; text-align: left;
             background: #f8f8f8; border-radius: 8px; padding: 10px 14px; }
    .steps b { color: #128C7E; }
  </style>
</head>
<body>
  <h1>WaRenderBot</h1>
  <div class="grid">${cards}</div>
  <script>
    const ids = ${JSON.stringify(accountIds)};
    const INTERVAL = 18000; // refresh QR image every 18 seconds

    function refreshQR(id) {
      const img = document.getElementById('qr-' + id);
      if (!img) return;
      // Bust cache so the latest QR is fetched
      img.src = '/qr/' + id + '.png?t=' + Date.now();
    }

    function startCountdown(id) {
      const el = document.getElementById('cd-' + id);
      if (!el) return;
      let secs = Math.floor(INTERVAL / 1000);
      el.querySelector('span').textContent = secs + 's';
      const tick = setInterval(() => {
        secs--;
        if (secs <= 0) {
          clearInterval(tick);
          refreshQR(id);
          startCountdown(id);
        } else {
          const sp = el.querySelector('span');
          if (sp) sp.textContent = secs + 's';
        }
      }, 1000);
    }

    // Also poll status so connected cards update without full reload
    async function pollStatus() {
      try {
        const res = await fetch('/health');
        const data = await res.json();
        for (const acc of data.accounts) {
          const card = document.getElementById('card-' + acc.id);
          if (!card) continue;
          if (acc.status === 'connected') {
            card.innerHTML = '<h3>' + acc.id + '</h3><div class="connected">✓ Connected</div>';
          }
        }
      } catch {}
    }

    ids.forEach(id => startCountdown(id));
    setInterval(pollStatus, 5000);
  </script>
</body>
</html>`);
});

// Per-client page — e.g. /abclimited shows only that account's QR
app.get('/:accountId', (req, res, next) => {
  const acc = global.botAccounts[req.params.accountId];
  if (!acc) return next(); // fall through to 404 if unknown

  let body;
  if (acc.status === 'connected') {
    body = `<div class="card" id="card-${acc.id}">
      <h3>${acc.id}</h3>
      <div class="connected">✓ Connected — bot is active!</div>
    </div>`;
  } else if (acc.qr) {
    body = `<div class="card" id="card-${acc.id}">
      <h3>${acc.id}</h3>
      <img id="qr-${acc.id}" src="/qr/${acc.id}.png" alt="QR Code" style="display:block;margin:0 auto"/>
      <div class="countdown" id="cd-${acc.id}">QR refreshes in <span>18s</span></div>
      <div class="steps">
        <b>How to scan:</b><br>
        1. Open WhatsApp on your phone<br>
        2. Tap <b>Settings</b> (bottom right)<br>
        3. Tap <b>Linked Devices</b><br>
        4. Tap <b>Link a Device</b><br>
        5. Point camera at the QR above
      </div>
    </div>`;
  } else {
    body = `<div class="card" id="card-${acc.id}">
      <h3>${acc.id}</h3>
      <div class="waiting">⏳ Starting up, please wait…</div>
    </div>`;
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>${acc.id} — WaRenderBot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: sans-serif; background: #f0f0f0; margin: 0;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: white; padding: 28px; border-radius: 16px;
            box-shadow: 0 4px 16px #0002; text-align: center; width: 300px; }
    .card h3 { margin: 0 0 16px; color: #128C7E; font-size: 20px; }
    .connected { color: #25D366; font-size: 20px; font-weight: bold; padding: 20px 0; }
    .waiting { color: #999; padding: 20px 0; }
    img { width: 240px; height: 240px; border-radius: 8px; border: 1px solid #eee; }
    .countdown { font-size: 12px; color: #aaa; margin-top: 8px; }
    .countdown span { font-weight: bold; color: #888; }
    .steps { font-size: 12px; color: #888; margin-top: 10px; line-height: 1.7; text-align: left;
             background: #f8f8f8; border-radius: 8px; padding: 10px 14px; }
    .steps b { color: #128C7E; }
  </style>
</head>
<body>
  ${body}
  <script>
    const id = ${JSON.stringify(acc.id)};
    const INTERVAL = 18000;
    function refreshQR() {
      const img = document.getElementById('qr-' + id);
      if (img) img.src = '/qr/' + id + '.png?t=' + Date.now();
    }
    function startCountdown() {
      const el = document.getElementById('cd-' + id);
      if (!el) return;
      let secs = Math.floor(INTERVAL / 1000);
      el.querySelector('span').textContent = secs + 's';
      const tick = setInterval(() => {
        secs--;
        if (secs <= 0) { clearInterval(tick); refreshQR(); startCountdown(); }
        else { const sp = el.querySelector('span'); if (sp) sp.textContent = secs + 's'; }
      }, 1000);
    }
    async function pollStatus() {
      try {
        const r = await fetch('/health');
        const data = await r.json();
        const acc = data.accounts.find(a => a.id === id);
        if (acc?.status === 'connected') {
          document.getElementById('card-' + id).innerHTML =
            '<h3>' + id + '</h3><div class="connected">✓ Connected — bot is active!</div>';
        }
      } catch {}
    }
    startCountdown();
    setInterval(pollStatus, 5000);
  </script>
</body>
</html>`);
});

app.get('/qr/:id.png', async (req, res) => {
  const acc = global.botAccounts[req.params.id];
  if (!acc?.qr) return res.status(404).send('No QR');
  try {
    const buf = await QRCode.toBuffer(acc.qr, { width: 512, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

app.get('/health', (_, res) => res.json({
  status: 'ok',
  accounts: Object.values(global.botAccounts).map(a => ({ id: a.id, status: a.status })),
}));

app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));

// ── Start one bot per account ─────────────────────────────────────────────────
for (const acc of accounts) {
  startBot(acc).catch(err => {
    console.error(`[${acc.id}] Fatal error:`, err.message);
  });
}
