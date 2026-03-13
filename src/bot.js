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
const { isAllowed, addNumber, normalise } = require('./whitelist');

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
          // LID unresolved — check if this message is a phone number for self-verification
          const digits = normalise(text);
          if (digits.length >= 7) {
            // Try the number as-is, and also with UK country code if it starts with 0
            const candidates = [digits];
            if (digits.startsWith('0')) candidates.push('44' + digits.slice(1));

            let verified = false;
            for (const candidate of candidates) {
              if (isAllowed(id, candidate + '@s.whatsapp.net')) {
                // Add the LID directly to the whitelist so future messages work
                const lidDigits = from.split('@')[0];
                addNumber(id, lidDigits, { verifiedViaPhone: candidate, lid: from });
                lidToPhone[from] = candidate + '@s.whatsapp.net';
                resolvedJid = candidate + '@s.whatsapp.net';
                console.log(`[${id}] LID ${from} self-verified as ${candidate}`);
                await sock.sendMessage(from, {
                  text: '✅ Verified! You now have full access. ¡Bienvenido! 🇪🇸',
                }, { quoted: msg });
                verified = true;
                break;
              }
            }
            if (verified) {
              // Fall through to AI reply below
            } else {
              // Number provided but not in whitelist
              const trialLink = paymentLinkMonthly || paymentLink;
              const reply = trialLink
                ? `That number isn't linked to an active subscription.\n\nStart your free 7-day trial here:\n${trialLink}`
                : `That number isn't linked to an active subscription. Please subscribe to get access.`;
              await sock.sendMessage(from, { text: reply }, { quoted: msg });
              continue;
            }
          } else {
            // Not a phone number — ask them to verify with their checkout phone number
            console.log(`[${id}] Unresolved LID ${from} — sending verification prompt`);
            await sock.sendMessage(from, {
              text: `Hi! To access your Spanish Teacher subscription, please reply with the phone number you used at checkout.\n\nFor example: 447510698846\n\n(Include your country code — UK numbers start with 44)`,
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
