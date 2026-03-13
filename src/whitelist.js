const fs = require('fs');
const path = require('path');

function whitelistFile() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
  return path.join(DATA_DIR, 'allowed.json');
}

// Structure: { accountId: { "447911123456": { name, stripeCustomerId, addedAt } } }
function load() {
  try {
    const f = whitelistFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return {};
}

function save(data) {
  const f = whitelistFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

// Normalise phone: strip spaces, dashes, leading +, keep digits only
function normalise(phone) {
  return String(phone).replace(/\D/g, '');
}

// WhatsApp JIDs look like "447911123456@s.whatsapp.net" — extract just the number
function jidToNumber(jid) {
  return normalise(jid.split('@')[0]);
}

function isEnforced(accountId) {
  // Whitelist is enforced if:
  // 1. ACCOUNT_N_PAYMENT_LINK is set for this account (payment required), OR
  // 2. The allowed.json file already has an entry for this account
  const paymentLinkKey = Object.keys(process.env).find(
    k => k.startsWith('ACCOUNT_') && k.endsWith('_PAYMENT_LINK') &&
    process.env[k.replace('_PAYMENT_LINK', '_NAME')]?.replace(/\s+/g, '_') === accountId
  );
  if (paymentLinkKey || process.env[`PAYMENT_LINK_${accountId}`]) return true;
  const data = load();
  return !!data[accountId];
}

function isAllowed(accountId, jid) {
  if (!isEnforced(accountId)) return true; // no whitelist = open access
  const data = load();
  const list = data[accountId] || {};
  const number = jidToNumber(jid);
  return !!list[number];
}

function addNumber(accountId, phone, meta = {}) {
  const data = load();
  if (!data[accountId]) data[accountId] = {};
  const number = normalise(phone);
  data[accountId][number] = {
    addedAt: new Date().toISOString(),
    ...meta,
  };
  save(data);
  console.log(`[Whitelist] Added ${number} to ${accountId}`);
}

function removeNumber(accountId, phone) {
  const data = load();
  if (!data[accountId]) return;
  const number = normalise(phone);
  delete data[accountId][number];
  save(data);
  console.log(`[Whitelist] Removed ${number} from ${accountId}`);
}

function enableWhitelist(accountId) {
  // Creates an empty whitelist for the account, activating enforcement
  const data = load();
  if (!data[accountId]) {
    data[accountId] = {};
    save(data);
  }
}

function listNumbers(accountId) {
  const data = load();
  return data[accountId] || null; // null means no whitelist (open access)
}

module.exports = { isAllowed, addNumber, removeNumber, enableWhitelist, listNumbers, normalise };
