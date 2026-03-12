const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');

let _client = null;

function client() {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

function loadThreads() {
  try {
    if (fs.existsSync(THREADS_FILE)) {
      return JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveThreads(threads) {
  fs.mkdirSync(path.dirname(THREADS_FILE), { recursive: true });
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
}

async function getReply(contactId, userMessage) {
  const ai = client();
  const assistantId = process.env.ASSISTANT_ID;

  const threads = loadThreads();
  let threadId = threads[contactId];

  if (!threadId) {
    const thread = await ai.beta.threads.create();
    threadId = thread.id;
    threads[contactId] = threadId;
    saveThreads(threads);
    console.log(`[Assistant] New thread ${threadId} for ${contactId}`);
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
