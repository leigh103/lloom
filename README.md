# Lloom

A lightweight, self-hosted RAG middleware for Ollama. Lloom gives any Ollama model persistent memory, a knowledge base, configurable API tools, and a clean chat UI — with no heavy frameworks or external vector services.

## How it works

```
Markdown docs / API training data
    ↓ (ingestion)
nomic-embed-text → embeddings → SQLite + sqlite-vec

User message
    ↓
nomic-embed-text → query embedding → vector similarity search → relevant chunks + memories
    ↓
Ollama (your model) + context + tools → response
    ↓
Chat UI / REST API / Slack

After each response:
    ↓
Memory extraction → new facts embedded and stored automatically
```

## Prerequisites

- Node.js 18+
- Ollama running with:
  - A chat model: `ollama pull gemma4:e4b` (or any model with tool support)
  - An embedding model: `ollama pull nomic-embed-text`

No external database required — Lloom uses SQLite with sqlite-vec for vector storage.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp env.sample .env
# Edit .env with your Ollama URL, agent identity, and any optional keys

# 3. Start Lloom
npm start
# or for development with auto-restart:
npm run dev
```

Open `http://localhost:3000` for the chat UI.

## Adding knowledge

Drop markdown files into `./docs/` and run:

```bash
npm run ingest
```

Or watch for changes automatically:

```bash
npm run ingest:watch
```

### Training from an API

If your knowledge lives in a REST API, add a `train` block to a service config in `config/apis/`:

```json
{
  "name": "my-service",
  "description": "...",
  "baseUrl": "https://api.example.com",
  "train": {
    "endpoint": "/articles",
    "excludeFields": ["created_at", "image_url"]
  },
  "auth": null
}
```

Then run:

```bash
npm run train
```

Lloom fetches the endpoint, auto-detects fields, writes individual markdown files to `./docs/my-service/`, and ingests them — all in one step.

## Persistent memory

Lloom automatically extracts memorable facts from every conversation and stores them as embeddings. On future queries, relevant memories are retrieved alongside knowledge base chunks — the model remembers context across sessions without any manual input.

## API services (tools)

Add JSON files to `config/apis/` to give Lloom access to external APIs as tools. The model decides when to call them based on the `description` field.

```json
{
  "name": "weather",
  "description": "Current weather for any location. Use endpoint '/{city}' with GET params {format: 'j1'}.",
  "baseUrl": "https://wttr.in",
  "cacheTtlSeconds": 1800,
  "auth": null
}
```

**Auth** — reference env vars rather than storing tokens directly:

```json
"auth": {
  "header": "x-api-key",
  "value": "env:MY_SERVICE_API_KEY"
}
```

API responses are cached per endpoint for `cacheTtlSeconds` seconds. Set to `0` or omit to disable caching.

## Configuration

All options are set via `.env`. See `env.sample` for the full list. Key settings:

```
OLLAMA_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=gemma4:e4b
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_NUM_CTX=8192
OLLAMA_TEMPERATURE=0.7
OLLAMA_NUM_PREDICT=2048
OLLAMA_KEEP_ALIVE=-1

AGENT_NAME=Lloom
AGENT_DESCRIPTION=Personal Ollama agent
AGENT_SYSTEM_PROMPT=You are Lloom, a personal AI assistant powered by Ollama.

DB_PATH=./data/knowledge.db
DOCS_PATH=./docs
```

## REST API

All endpoints require `x-api-key` header if `API_KEY` is set in `.env`.

### POST /api/chat
Non-streaming. Returns the full reply once complete.

```json
// Request
{ "message": "What's the weather in London?", "history": [] }

// Response
{ "reply": "It's currently..." }
```

### POST /api/chat/stream
Streaming via Server-Sent Events. Used by the built-in UI. Tool call status events are sent before the response stream begins.

```
data: {"tool": "api_call → weather"}
data: {"token": "It's "}
data: {"token": "currently "}
...
data: [DONE]
```

### GET /api/health
```json
{ "status": "ok", "name": "Lloom", "description": "Personal Ollama agent", "timestamp": "..." }
```

## Slack

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode
3. Add Bot Token Scopes: `chat:write`, `im:history`, `app_mentions:read`
4. Subscribe to events: `message.im`, `app_mention`
5. Add `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` to `.env`

Lloom will respond to DMs and @mentions.

## Web search

Get a free API key from https://api.search.brave.com and add it as `BRAVE_API_KEY` in `.env`.

## Calling from another app

```javascript
const response = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.LLOOM_API_KEY,
  },
  body: JSON.stringify({ message, history }),
});

const { reply } = await response.json();
```

## Tech

- **Runtime**: Node.js (ES modules, no TypeScript)
- **LLM / embeddings**: Ollama
- **Vector store**: SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec)
- **API**: Express
- **Slack**: Bolt.js (Socket Mode)
