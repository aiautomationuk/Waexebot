require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const { startBot } = require('./src/bot');

// ── Sanity check ──────────────────────────────────────────────────────────────
const required = ['OPENAI_API_KEY', 'ASSISTANT_ID'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[Main] Missing required env vars: ${missing.join(', ')}`);
  console.error('[Main] Set them in .env (local) or in the Render dashboard (production).');
  process.exit(1);
}

// ── Resolve data directory ────────────────────────────────────────────────────
// Use DATA_DIR env var if set, otherwise fall back to ./data next to this file.
// On Render: add a Disk with Mount Path /data and set DATA_DIR=/data
const requestedDir = process.env.DATA_DIR || path.join(__dirname, 'data');
try {
  fs.mkdirSync(requestedDir, { recursive: true });
  process.env.DATA_DIR = requestedDir;
  console.log(`[Main] Data directory: ${requestedDir}`);
} catch (err) {
  const fallback = path.join(__dirname, 'data');
  console.warn(`[Main] Cannot use ${requestedDir} (${err.code}) — falling back to ${fallback}`);
  console.warn('[Main] Session will not survive redeploys. Add a Render Disk at /data to fix this.');
  fs.mkdirSync(fallback, { recursive: true });
  process.env.DATA_DIR = fallback;
}

// ── Express health server (required by Render to keep service alive) ──────────
const QRCode = require('qrcode');
const app = express();
const PORT = process.env.PORT || 3000;

// Shared QR state — updated by the bot whenever a new QR is generated
global.currentQR = null;
global.botStatus = 'starting';

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>WaRenderBot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f0f0f0; }
    .card { background: white; padding: 32px; border-radius: 16px; box-shadow: 0 4px 24px #0002;
            text-align: center; max-width: 380px; width: 90%; }
    h2 { margin: 0 0 8px; color: #128C7E; }
    .status { font-size: 14px; color: #666; margin-bottom: 20px; }
    img { width: 260px; height: 260px; border: 1px solid #eee; border-radius: 8px; }
    .connected { color: #25D366; font-size: 22px; font-weight: bold; }
    .waiting { color: #999; }
    p { font-size: 13px; color: #888; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>WaRenderBot</h2>
    ${global.botStatus === 'connected'
      ? '<div class="connected">✓ Connected &amp; Running</div>'
      : global.currentQR
        ? `<div class="status">Scan with WhatsApp to connect</div>
           <img src="/qr.png" alt="QR Code"/>
           <p>Settings → Linked Devices → Link a Device<br>Page refreshes every 15 seconds</p>`
        : '<div class="waiting">⏳ Starting up, please wait…</div>'
    }
  </div>
</body>
</html>`);
});

app.get('/qr.png', async (_, res) => {
  if (!global.currentQR) return res.status(404).send('No QR yet');
  try {
    const buf = await QRCode.toBuffer(global.currentQR, { width: 512, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', botStatus: global.botStatus }));

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

// ── Start WhatsApp bot ────────────────────────────────────────────────────────
console.log('[Main] Starting bot...');
console.log(`[Main] Assistant ID: ${process.env.ASSISTANT_ID}`);
startBot().catch(err => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
