import axios from 'axios';
import { loadApiServices } from './api-services.js';
import 'dotenv/config';

const MAX_RESPONSE_CHARS = 8000;

// ─── Load API services at startup ────────────────────────────────────────────

const apiServices = loadApiServices();

// ─── API response cache ───────────────────────────────────────────────────────

const apiCache = new Map();

function getCached(key) {
  const entry = apiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    apiCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data, ttlSeconds) {
  apiCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ─── Tool Definitions (sent to Ollama) ───────────────────────────────────────

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: 'Get the current date and time',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Use when the user asks about something that may be recent or external to the knowledge base.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather and 3-day forecast for a location. If the user asks about weather without specifying a location, use their location from the system prompt.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name, or "lat,lng" coordinates' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression. Use for arithmetic, percentages, currency conversions, or any calculation.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'A mathematical expression, e.g. "15% of 84.50" or "sqrt(144) + 20"' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the content of a specific URL. Use when you have a URL and need to read the page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
];

// Add api_call tool only if services are configured
if (apiServices.length > 0) {
  const serviceList = apiServices
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n');

  toolDefinitions.push({
    type: 'function',
    function: {
      name: 'api_call',
      description: `Make an HTTP request to a configured API service.\n\nAvailable services:\n${serviceList}`,
      parameters: {
        type: 'object',
        properties: {
          service:  { type: 'string', description: 'The service name' },
          endpoint: { type: 'string', description: 'The endpoint path, e.g. "/articles/123"' },
          method:   { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method, defaults to GET' },
          params:   { type: 'object', description: 'Query params for GET requests, or request body for POST/PUT/PATCH' },
        },
        required: ['service', 'endpoint'],
      },
    },
  });
}

// ─── Tool Executors ───────────────────────────────────────────────────────────

async function get_current_datetime() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
}

async function web_search({ query }) {
  const key = process.env.BRAVE_API_KEY;

  if (!key) {
    return 'Web search is not configured. Add BRAVE_API_KEY to .env to enable it.';
  }

  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
    params: { q: query, count: 5 },
  });

  const results = res.data.web?.results || [];
  return results
    .map(r => `**${r.title}**\n${r.description}\n${r.url}`)
    .join('\n\n') || 'No results found.';
}

const weatherCache = new Map();

async function get_weather({ location }) {
  const cacheKey = location.toLowerCase();
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const res = await axios.get(`https://wttr.in/${encodeURIComponent(location)}`, {
    params: { format: 'j1' },
    headers: { 'Accept': 'application/json' },
    timeout: 8000,
  });

  const d = res.data;
  const current = d.current_condition?.[0];
  const area = d.nearest_area?.[0];
  const place = area?.areaName?.[0]?.value || location;
  const country = area?.country?.[0]?.value || '';

  const desc = current.weatherDesc?.[0]?.value || '';
  const tempC = current.temp_C;
  const feelsC = current.FeelsLikeC;
  const humidity = current.humidity;
  const windKmph = current.windspeedKmph;
  const windDir = current.winddir16Point;

  const days = d.weather?.map(day => {
    const hi = day.maxtempC;
    const lo = day.mintempC;
    const desc = day.hourly?.[4]?.weatherDesc?.[0]?.value || '';
    return `  ${day.date}: ${desc}, ${lo}–${hi}°C`;
  }).join('\n') || '';

  const result = `**${place}${country ? ', ' + country : ''}**
Current: ${desc}, ${tempC}°C (feels like ${feelsC}°C)
Humidity: ${humidity}%, Wind: ${windKmph}km/h ${windDir}

**3-day forecast:**
${days}`;

  weatherCache.set(cacheKey, { data: result, expiresAt: Date.now() + 30 * 60 * 1000 });
  return result;
}

async function calculate({ expression }) {
  // Safe evaluation — only allow math characters
  const sanitised = expression
    .replace(/[^0-9+\-*/.()%\s,]/g, '')
    .replace(/(\d+)%\s*of\s*(\d+\.?\d*)/gi, '($1/100)*$2')
    .replace(/(\d+\.?\d*)%/g, '($1/100)');

  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${sanitised})`)();
    if (typeof result !== 'number' || !isFinite(result)) return 'Could not evaluate that expression.';
    return `${expression} = ${parseFloat(result.toFixed(10))}`;
  } catch {
    return 'Could not evaluate that expression.';
  }
}

async function web_fetch({ url }) {
  const res = await axios.get(url, {
    headers: { 'Accept': 'text/html,application/json,*/*', 'User-Agent': 'Mozilla/5.0' },
    responseType: 'text',
    timeout: 10000,
  });

  // Strip HTML tags down to readable text
  const text = String(res.data)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return text.length > MAX_RESPONSE_CHARS
    ? text.slice(0, MAX_RESPONSE_CHARS) + `\n\n[Content truncated — ${text.length} chars total]`
    : text;
}

async function api_call({ service: serviceName, endpoint, method = 'GET', params = {} }) {
  const service = apiServices.find(s => s.name === serviceName);
  if (!service) {
    return `Unknown service: "${serviceName}". Available: ${apiServices.map(s => s.name).join(', ')}`;
  }

  const url = service.baseUrl.replace(/\/$/, '') + '/' + endpoint.replace(/^\//, '');

  // Check cache (only for GET requests)
  const ttl = service.cacheTtlSeconds;
  const cacheKey = `${serviceName}:${method}:${endpoint}:${JSON.stringify(params)}`;
  if (method === 'GET' && ttl > 0) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const headers = {};
  if (service.auth?.value) {
    headers[service.auth.header] = service.auth.value;
  }

  const res = await axios({
    method,
    url,
    headers,
    ...(method === 'GET' ? { params } : { data: params }),
  });

  const text = typeof res.data === 'string'
    ? res.data
    : JSON.stringify(res.data, null, 2);

  const result = text.length > MAX_RESPONSE_CHARS
    ? text.slice(0, MAX_RESPONSE_CHARS) + `\n\n[Response truncated — ${text.length} chars total, showing first ${MAX_RESPONSE_CHARS}]`
    : text;

  if (method === 'GET' && ttl > 0) setCached(cacheKey, result, ttl);

  return result;
}

// ─── Tool Runner ─────────────────────────────────────────────────────────────

const executors = {
  get_current_datetime,
  get_weather,
  calculate,
  web_search,
  web_fetch,
  api_call,
};

export async function executeTool(name, args) {
  const fn = executors[name];
  if (!fn) return `Unknown tool: ${name}`;

  try {
    const result = await fn(args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}
