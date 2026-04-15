import axios from 'axios';
import 'dotenv/config';

const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'qwen3:14b';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

const OLLAMA_OPTIONS = {
  num_ctx:     parseInt(process.env.OLLAMA_NUM_CTX)       || 8192,
  temperature: parseFloat(process.env.OLLAMA_TEMPERATURE) ?? 0.7,
  num_predict: parseInt(process.env.OLLAMA_NUM_PREDICT)   || 2048,
};

const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE === '-1'
  ? -1
  : (process.env.OLLAMA_KEEP_ALIVE ?? -1);

/**
 * Get an embedding vector for a piece of text
 */
// Pass a string for a single embedding, or an array for batch (one request, multiple results)
export async function embed(input) {
  const res = await axios.post(`${OLLAMA}/api/embed`, {
    model: EMBED_MODEL,
    input,
    keep_alive: -1,
  });
  return Array.isArray(input) ? res.data.embeddings : res.data.embeddings[0];
}

/**
 * Send a chat message to Ollama (non-streaming)
 */
export async function chat(messages, tools = []) {
  const body = {
    model: CHAT_MODEL,
    messages,
    stream: false,
    options: OLLAMA_OPTIONS,
    keep_alive: KEEP_ALIVE,
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  const res = await axios.post(`${OLLAMA}/api/chat`, body);
  return res.data.message;
}

/**
 * Send a chat message and stream the response back
 * onChunk(token) called for each text token
 */
export async function chatStream(messages, onChunk, tools = []) {
  const body = {
    model: CHAT_MODEL,
    messages,
    stream: true,
    options: OLLAMA_OPTIONS,
    keep_alive: KEEP_ALIVE,
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  const res = await axios.post(`${OLLAMA}/api/chat`, body, {
    responseType: 'stream',
  });

  return new Promise((resolve, reject) => {
    let fullContent = '';
    let toolCalls = [];

    res.data.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            fullContent += json.message.content;
            onChunk(json.message.content);
          }
          if (json.message?.tool_calls) {
            toolCalls = json.message.tool_calls;
          }
        } catch {}
      }
    });

    res.data.on('end', () => resolve({ content: fullContent, tool_calls: toolCalls }));
    res.data.on('error', reject);
  });
}
