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

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[Bot] Starting with WA v${version.join('.')}`);

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
      console.log('\n[Bot] ═══════════════════════════════════════');
      console.log('[Bot] Scan this QR code with WhatsApp:');
      console.log('[Bot] Settings → Linked Devices → Link a Device');
      console.log('[Bot] ═══════════════════════════════════════\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[Bot] Disconnected — code: ${statusCode} | logged out: ${loggedOut}`);
      if (!loggedOut) {
        console.log('[Bot] Reconnecting...');
        startBot();
      } else {
        console.log('[Bot] Logged out. Delete data/auth and restart to re-link.');
      }
    }

    if (connection === 'open') {
      console.log('[Bot] ✓ Connected and ready to reply!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      // Skip group messages (set REPLY_IN_GROUPS=true in .env to enable)
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
      console.log(`[Bot] ← ${from}: ${text.substring(0, 80)}`);

      try {
        const reply = await getReply(from, text);
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
        console.log(`[Bot] → ${reply.substring(0, 80)}`);
      } catch (err) {
        console.error(`[Bot] AI error: ${err.message}`);
      }
    }
  });
}

module.exports = { startBot };
