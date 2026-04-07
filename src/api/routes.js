import express from 'express';
import { askMildred, askMildredStream } from '../agent.js';

export const router = express.Router();

// Simple API key auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (process.env.API_KEY && key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * POST /api/chat
 * Body: { message: string, history?: [{role, content}] }
 * Response: { reply: string }
 */
router.post('/chat', auth, async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const reply = await askMildred(message, history);
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chat/stream
 * Body: { message: string, history?: [{role, content}] }
 * Response: Server-Sent Events stream
 */
router.post('/chat/stream', auth, async (req, res) => {
  const { message, history = [], location } = req.body;
  console.log(`💬 /chat/stream received: "${message?.slice(0, 80)}"`);

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await askMildredStream(
      message,
      history,
      location,
      (token) => {
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      },
      (toolName, args) => {
        const label = args?.service ? `${toolName} → ${args.service}` : toolName;
        res.write(`data: ${JSON.stringify({ tool: label })}\n\n`);
      }
    );

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(`💬 /chat/stream error:`, err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    name: process.env.AGENT_NAME || 'Lloom',
    description: process.env.AGENT_DESCRIPTION || 'Personal Ollama agent',
    location: process.env.DEFAULT_LOCATION || null,
    timestamp: new Date().toISOString(),
  });
});
