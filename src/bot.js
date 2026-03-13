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
const { isAllowed, addNumber, normalise, findByCode, clearCode, getEntry, clearWelcomePending } = require('./whitelist');

async function startBot(account) {
  const { id, instructions, model, apiKey, paymentLink, paymentLinkMonthly } = account;
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
  const AUTH_DIR = path.join(DATA_DIR, 'auth', id);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[${id}] Starting (WA v${version.join('.')})`);

  // Maps LID JIDs → phone JIDs (populated via contacts.upsert)
  const lidToPhone = {};

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  // Build LID → phone map from contact events (works when WhatsApp exposes the mapping)
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) {
        lidToPhone[c.lid] = c.id;
        console.log(`[${id}] Mapped LID ${c.lid} → ${c.id}`);
      }
    }
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
      if (global.botSocks) delete global.botSocks[id];
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
      global.botSocks = global.botSocks || {};
      global.botSocks[id] = sock;
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

      // Resolve LID JIDs to phone JIDs for whitelist lookup
      let resolvedJid = from;
      if (from.endsWith('@lid')) {
        const phoneJid = lidToPhone[from];
        if (phoneJid) {
          resolvedJid = phoneJid;
          console.log(`[${id}] Resolved LID ${from} → ${phoneJid}`);
        } else {
          // LID unresolved — check if this message is a valid one-time access code
          const trimmed = text.trim().toUpperCase();
          const match = findByCode(id, trimmed);
          if (match) {
            // Valid code — add LID to whitelist and clear the code
            const lidDigits = from.split('@')[0];
            addNumber(id, lidDigits, { verifiedViaCode: true, linkedPhone: match.phone });
            clearCode(id, match.phone);
            lidToPhone[from] = match.phone + '@s.whatsapp.net';
            resolvedJid = match.phone + '@s.whatsapp.net';
            console.log(`[${id}] LID ${from} verified via code → ${match.phone}`);
            await sock.sendMessage(from, {
              text: '✅ Verified! You now have full access. ¡Bienvenido! 🇪🇸',
            }, { quoted: msg });
            // Fall through to AI reply below
          } else {
            // No valid code — prompt for it
            console.log(`[${id}] Unresolved LID ${from} — sending code prompt`);
            await sock.sendMessage(from, {
              text: `Hi! To access your Spanish Teacher subscription, please reply with the 6-digit access code from your welcome message.`,
            }, { quoted: msg });
            continue;
          }
        }
      }

      console.log(`[${id}] ← ${from}: ${text.substring(0, 80)}`);

      // TEMP safety: ensure your own number is never blocked while we refine Stripe → whitelist sync
      // (Matches 447399662383 for the Spanish_Teacher account)
      const fromDigits = resolvedJid.split('@')[0].replace(/\D/g, '');
      const bypassWhitelist =
        id === 'Spanish_Teacher' &&
        fromDigits === '447399662383';

      // Check whitelist — if account has a whitelist, only respond to allowed numbers
      if (!bypassWhitelist && !isAllowed(id, resolvedJid)) {
        const trialLink = paymentLinkMonthly || paymentLink;
        const blocked = trialLink
          ? `Hey! Are you ready to start learning Spanish? 🇪🇸\n\nTry our service free for 7 days:\n${trialLink}`
          : `Hey! Are you ready to start learning Spanish? 🇪🇸\n\nTry our service free for 7 days — contact us to get started!`;
        await sock.sendMessage(from, { text: blocked }, { quoted: msg });
        console.log(`[${id}] Blocked non-subscriber: ${from} (resolved: ${resolvedJid})`);
        continue;
      }

      // Send welcome message on their first inbound message if pending
      const entry = getEntry(id, resolvedJid);
      if (entry?.welcomePending) {
        const code = entry.verificationCode;
        const welcomeText = `¡Hola! 👋 Welcome to Spanish-Teacher.com!\n\nYour free trial is now active. I'm your AI Spanish teacher — reply to this message to start your first lesson! 🇪🇸\n\nYou can ask me anything: grammar, vocabulary, conversation practice — I'm here to help.${code ? `\n\n🔑 Your access code: *${code}*\nKeep this safe — you may need it to verify your account on first use.` : ''}`;
        await sock.sendMessage(from, { text: welcomeText });
        clearWelcomePending(id, resolvedJid.split('@')[0]);
        console.log(`[${id}] Sent pending welcome to ${from}`);
      }

      try {
        const reply = await getReply({ contactId: from, accountId: id, userMessage: text, instructions, model, apiKey });
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
        console.log(`[${id}] → ${reply.substring(0, 80)}`);
      } catch (err) {
        console.error(`[${id}] AI error: ${err.message}`);
      }
    }
  });
}

module.exports = { startBot };
