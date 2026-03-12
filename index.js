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
    const apiKey = process.env[`ACCOUNT_${i}_API_KEY`] || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(`[Main] ACCOUNT_${i}_API_KEY not set and no OPENAI_API_KEY fallback — skipping.`);
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
      return `<div class="card">
        <h3>${acc.id}</h3>
        <div class="connected">✓ Connected</div>
      </div>`;
    }
    if (acc.qr) {
      return `<div class="card">
        <h3>${acc.id}</h3>
        <p class="hint">Scan with WhatsApp<br>Settings → Linked Devices → Link a Device</p>
        <img src="/qr/${acc.id}.png" alt="QR"/>
        <p class="sub">Page refreshes every 15s</p>
      </div>`;
    }
    return `<div class="card">
      <h3>${acc.id}</h3>
      <div class="waiting">⏳ ${acc.status}…</div>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>WaRenderBot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="15">
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
    .sub { font-size: 11px; color: #aaa; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>WaRenderBot</h1>
  <div class="grid">${cards}</div>
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
