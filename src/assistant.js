const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// Cache OpenAI clients by API key
const clientCache = new Map();
function getClient(apiKey) {
  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new OpenAI({ apiKey }));
  }
  return clientCache.get(apiKey);
}

function stateFile() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
  return path.join(DATA_DIR, 'responses.json');
}

function loadState() {
  try {
    const f = stateFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return {};
}

function saveState(state) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state, null, 2));
}

// contactId    — WhatsApp JID  e.g. 447911123456@s.whatsapp.net
// accountId    — which bot account (namespaces conversations)
// userMessage  — the text to reply to
// instructions — the assistant's personality / system prompt
// model        — OpenAI model to use (default gpt-4o)
// apiKey       — OpenAI API key
async function getReply({ contactId, accountId, userMessage, instructions, model, apiKey }) {
  const ai = getClient(apiKey);
  const stateKey = `${accountId}:${contactId}`;

  const state = loadState();
  const previousResponseId = state[stateKey] || null;

  const response = await ai.responses.create({
    model: model || 'gpt-4o',
    instructions: instructions || 'You are a helpful assistant.',
    input: userMessage,
    ...(previousResponseId && { previous_response_id: previousResponseId }),
  });

  // Save response ID so the next message continues the conversation
  state[stateKey] = response.id;
  saveState(state);

  return response.output_text;
}

module.exports = { getReply };
