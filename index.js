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
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => res.json({
  status: 'ok',
  bot: 'WaRenderBot',
  assistant: process.env.ASSISTANT_ID,
}));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`[Server] Health check running on port ${PORT}`);
});

// ── Start WhatsApp bot ────────────────────────────────────────────────────────
console.log('[Main] Starting bot...');
console.log(`[Main] Assistant ID: ${process.env.ASSISTANT_ID}`);
startBot().catch(err => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
