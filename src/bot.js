const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { getReply } = require('./assistant');

async function startBot(account) {
  const { id, assistantId, apiKey } = account;
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
  const AUTH_DIR = path.join(DATA_DIR, 'auth', id);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[${id}] Starting (WA v${version.join('.')})`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (global.botAccounts?.[id]) {
        global.botAccounts[id].qr = qr;
        global.botAccounts[id].status = 'awaiting_scan';
      }
      console.log(`[${id}] QR ready — open your Render URL to scan.`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      if (global.botAccounts?.[id]) {
        global.botAccounts[id].status = 'disconnected';
        global.botAccounts[id].qr = null;
      }
      console.log(`[${id}] Disconnected (code: ${statusCode})`);
      if (!loggedOut) {
        console.log(`[${id}] Reconnecting...`);
        setTimeout(() => startBot(account), 3000);
      } else {
        console.log(`[${id}] Logged out — delete data/auth/${id} and restart to re-link.`);
      }
    }

    if (connection === 'open') {
      if (global.botAccounts?.[id]) {
        global.botAccounts[id].qr = null;
        global.botAccounts[id].status = 'connected';
      }
      console.log(`[${id}] ✓ Connected and ready!`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      const isGroup = msg.key.remoteJid.endsWith('@g.us');
      if (isGroup && process.env.REPLY_IN_GROUPS !== 'true') continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      if (!text.trim()) continue;

      const from = msg.key.remoteJid;
      console.log(`[${id}] ← ${from}: ${text.substring(0, 80)}`);

      try {
        const reply = await getReply({ contactId: from, accountId: id, userMessage: text, assistantId, apiKey });
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
        console.log(`[${id}] → ${reply.substring(0, 80)}`);
      } catch (err) {
        console.error(`[${id}] AI error: ${err.message}`);
      }
    }
  });
}

module.exports = { startBot };
