const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// Cache OpenAI clients by API key so we don't recreate them on every message
const clientCache = new Map();
function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new OpenAI({ apiKey }));
  }
  return clientCache.get(apiKey);
}

function threadsFile() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
  return path.join(DATA_DIR, 'threads.json');
}

function loadThreads() {
  try {
    const f = threadsFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return {};
}

function saveThreads(threads) {
  const f = threadsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(threads, null, 2));
}

// contactId  — WhatsApp JID (e.g. 447911123456@s.whatsapp.net)
// accountId  — which bot account (used to namespace threads so two accounts don't share threads)
// userMessage — the text to send
// assistantId — which OpenAI Assistant to use
// apiKey      — OpenAI API key for this account
async function getReply({ contactId, accountId, userMessage, assistantId, apiKey }) {
  const ai = getClient(apiKey);
  const threadKey = `${accountId}:${contactId}`;

  const threads = loadThreads();
  let threadId = threads[threadKey];

  if (!threadId) {
    const thread = await ai.beta.threads.create();
    threadId = thread.id;
    threads[threadKey] = threadId;
    saveThreads(threads);
    console.log(`[Assistant] New thread ${threadId} for ${threadKey}`);
  }

  await ai.beta.threads.messages.create(threadId, {
    role: 'user',
    content: userMessage,
  });

  const run = await ai.beta.threads.runs.createAndPoll(threadId, {
    assistant_id: assistantId,
  });

  if (run.status !== 'completed') {
    throw new Error(`Run ended with status: ${run.status}`);
  }

  const result = await ai.beta.threads.messages.list(threadId, {
    order: 'desc',
    limit: 1,
  });

  const reply = result.data[0].content
    .filter(b => b.type === 'text')
    .map(b => b.text.value)
    .join('\n');

  return reply;
}

module.exports = { getReply };
