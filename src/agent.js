import { retrieve, buildContext } from './rag/retrieve.js';
import { chat, chatStream } from './ollama.js';
import { toolDefinitions, executeTool } from './tools/tools.js';
import { extractAndStore } from './memory/memory.js';
import 'dotenv/config';

const AGENT_NAME = process.env.AGENT_NAME || 'Lloom';
const SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT ||
  `You are ${AGENT_NAME}, a personal AI assistant powered by Ollama.

Guidelines:
- Be concise and helpful
- When you have relevant documentation context, use it to give accurate answers
- If asked about current events or external information, use web_search
- Always be honest if you don't know something
- Format responses in markdown when helpful`;

/**
 * Run the agentic loop - keeps going until no more tool calls
 */
async function agenticLoop(messages) {
  const maxIterations = 5;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    const response = await chat(messages, toolDefinitions);

    // No tool calls - we have a final answer
    if (!response.tool_calls || response.tool_calls.length === 0) {
      return response.content;
    }

    // Execute tool calls
    messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls });

    for (const toolCall of response.tool_calls) {
      const result = await executeTool(
        toolCall.function.name,
        toolCall.function.arguments || {}
      );

      messages.push({
        role: 'tool',
        content: result,
      });
    }
  }

  return 'I hit the maximum number of steps. Please try rephrasing your question.';
}

/**
 * Chat with Mildred (non-streaming)
 * history: array of { role, content } messages
 */
export async function askMildred(userMessage, history = []) {
  // Retrieve relevant docs
  const chunks = await retrieve(userMessage);
  const context = buildContext(chunks);

  // Build system prompt with optional RAG context
  let systemContent = SYSTEM_PROMPT;
  if (context) {
    systemContent += `\n\n## Relevant Documentation\n\n${context}`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const reply = await agenticLoop(messages);

  // Extract and store memories in the background — don't await, keeps response fast
  if (process.env.MEMORY_ENABLED !== 'false') extractAndStore(userMessage, reply).catch(() => {});

  return reply;
}

/**
 * Chat (streaming) — runs the full agentic tool loop first, then streams the final response.
 * onChunk(token)  — called for each streamed token
 * onTool(name, args) — called each time a tool fires, before it executes
 */
export async function askMildredStream(userMessage, history = [], location, onChunk, onTool) {
  const chunks = await retrieve(userMessage);
  const context = buildContext(chunks);

  let systemContent = SYSTEM_PROMPT;
  if (location) {
    systemContent += `\n\nUser's current location: ${location}. Use this when they ask about weather or anything location-specific without specifying a place.`;
  }
  if (context) {
    systemContent += `\n\n## Relevant Documentation\n\n${context}`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userMessage },
  ];

  // Agentic loop (non-streaming) — resolves all tool calls first
  let toolsWereCalled = false;
  let directReply = null;

  for (let i = 0; i < 5; i++) {
    const response = await chat(messages, toolDefinitions);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      if (!toolsWereCalled) {
        // No tools needed — hold the response and send as one chunk below
        directReply = response.content;
      }
      break;
    }

    toolsWereCalled = true;
    messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls });

    for (const toolCall of response.tool_calls) {
      onTool?.(toolCall.function.name, toolCall.function.arguments || {});
      const result = await executeTool(toolCall.function.name, toolCall.function.arguments || {});
      messages.push({ role: 'tool', content: result });
    }
  }

  // Stream the final response (or send directly if no tools were called)
  let fullReply;
  if (directReply !== null) {
    onChunk(directReply);
    fullReply = directReply;
  } else {
    const result = await chatStream(messages, onChunk);
    fullReply = result.content;
  }

  if (process.env.MEMORY_ENABLED !== 'false') extractAndStore(userMessage, fullReply).catch(() => {});
  return fullReply;
}
