require('dotenv').config();

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
