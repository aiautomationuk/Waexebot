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

function isAllowed(accountId, jid) {
  // If no whitelist entry for this account, allow everyone (open access)
  const data = load();
  if (!data[accountId]) return true;
  const number = jidToNumber(jid);
  return !!data[accountId][number];
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

// Find a subscriber by their one-time verification code
// Returns { accountId, phone } or null
function findByCode(accountId, code) {
  const data = load();
  const subscribers = data[accountId];
  if (!subscribers) return null;
  for (const [phone, meta] of Object.entries(subscribers)) {
    if (meta.verificationCode && meta.verificationCode === code.toUpperCase()) {
      return { phone };
    }
  }
  return null;
}

// Remove the verification code after it has been used
function clearCode(accountId, phone) {
  const data = load();
  const number = normalise(phone);
  if (data[accountId]?.[number]) {
    delete data[accountId][number].verificationCode;
    save(data);
  }
}

// Get a subscriber's entry
function getEntry(accountId, jid) {
  const data = load();
  const number = jidToNumber(jid);
  return data[accountId]?.[number] || null;
}

// Clear the welcomePending flag after sending
function clearWelcomePending(accountId, phone) {
  const data = load();
  const number = normalise(phone);
  if (data[accountId]?.[number]) {
    delete data[accountId][number].welcomePending;
    save(data);
  }
}

module.exports = { isAllowed, addNumber, removeNumber, enableWhitelist, listNumbers, normalise, findByCode, clearCode, getEntry, clearWelcomePending };
