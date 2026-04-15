import fs from 'fs';
import path from 'path';
import axios from 'axios';
import 'dotenv/config';
import { ingestAll, ingestFile } from './ingest.js';
import { scrapeService } from './scrape.js';
import { readService } from './read.js';

const SERVICES_PATH = process.env.API_SERVICES_PATH || './config/apis';
const DOCS_PATH = process.env.DOCS_PATH || './docs';

const TITLE_CANDIDATES = ['title', 'name', 'heading', 'subject', 'label'];
const ID_CANDIDATES    = ['slug', 'id', '_id', 'key', 'uuid'];
const SKIP_PATTERNS    = [
  /^_/,          // ArangoDB / internal fields (_id, _key, _rev, _created, _updated, ...)
  /_at$/,        // timestamp fields (created_at, updated_at, published_at, ...)
  /_url$/,       // URL fields (image_url, ...)
  /_id$/,        // ID fields
  /^urls?$/,     // url / urls
  /^image/,      // image_url, image, image_path, ...
  /^status$/,
  /^type$/,
  /^guard$/,     // ArangoDB collection guard field
  /^order$/,
  /^rev$/,
];

function detectFields(sample, excludeFields = []) {
  const keys = Object.keys(sample);
  const exclude = new Set(excludeFields.map(f => f.toLowerCase()));

  const titleField = TITLE_CANDIDATES
    .map(c => keys.find(k => k.toLowerCase() === c))
    .find(Boolean);

  const idField = ID_CANDIDATES
    .map(c => keys.find(k => k.toLowerCase() === c))
    .find(Boolean);

  const reserved = new Set([titleField, idField].filter(Boolean));

  const bodyFields = keys
    .filter(k => {
      if (reserved.has(k)) return false;
      if (exclude.has(k.toLowerCase())) return false;
      if (SKIP_PATTERNS.some(p => p.test(k.toLowerCase()))) return false;
      return typeof sample[k] === 'string' && sample[k].trim().length > 0;
    })
    .sort((a, b) => (sample[b]?.length || 0) - (sample[a]?.length || 0));

  return { titleField, idField, bodyFields };
}

function toMarkdown(obj, { titleField, bodyFields }) {
  const parts = [];
  if (titleField && obj[titleField]) parts.push(`# ${obj[titleField]}\n`);
  for (const field of bodyFields) {
    if (obj[field]?.trim()) parts.push(obj[field].trim());
  }
  return parts.join('\n\n');
}

function toFilename(obj, idField, index) {
  const raw = idField ? obj[idField] : null;
  const slug = raw
    ? String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : `item-${index}`;
  return `${slug}.md`;
}

async function trainService(service) {
  const { name, baseUrl, auth, train } = service;
  const endpoint = train.endpoint || '/';
  const excludeFields = train.excludeFields || [];

  const url = baseUrl.replace(/\/$/, '') + '/' + endpoint.replace(/^\//, '');
  const headers = {};
  if (auth?.value) headers[auth.header] = auth.value;

  const res = await axios.get(url, { headers });

  let items = res.data;
  if (!Array.isArray(items)) {
    const arrayKey = Object.keys(items).find(k => Array.isArray(items[k]));
    if (arrayKey) {
      items = items[arrayKey];
    } else {
      throw new Error('Response is not an array and no array field found');
    }
  }

  if (items.length === 0) return null;

  const fields = detectFields(items[0], excludeFields);

  const outDir = path.join(DOCS_PATH, name);
  if (fs.existsSync(outDir)) {
    fs.readdirSync(outDir)
      .filter(f => f.endsWith('.md'))
      .forEach(f => fs.unlinkSync(path.join(outDir, f)));
  } else {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (let i = 0; i < items.length; i++) {
    const markdown = toMarkdown(items[i], fields);
    if (!markdown.trim()) continue;
    const filename = toFilename(items[i], fields.idField, i);
    fs.writeFileSync(path.join(outDir, filename), markdown, 'utf-8');
  }

  return { outDir, count: items.length };
}

function loadServices() {
  if (!fs.existsSync(SERVICES_PATH)) return [];
  return fs.readdirSync(SERVICES_PATH)
    .filter(f => f.endsWith('.json'))
    .map(file => {
      try {
        const service = JSON.parse(fs.readFileSync(path.join(SERVICES_PATH, file), 'utf-8'));
        if (!service.train && !service.scrape && !service.read) return null;
        if (service.auth?.value?.startsWith('env:')) {
          const envKey = service.auth.value.slice(4);
          service.auth = { ...service.auth, value: process.env[envKey] || null };
        }
        return service;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Ingest markdown files not managed by any service config:
 * - .md files directly in DOCS_PATH root
 * - subdirectories in DOCS_PATH that have no matching service name
 */
async function ingestUnmanagedDocs(managedServiceNames) {
  const managed = new Set(managedServiceNames);
  const results = [];

  if (!fs.existsSync(DOCS_PATH)) return results;

  const entries = fs.readdirSync(DOCS_PATH, { withFileTypes: true });

  // Root-level .md files
  const rootFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => path.join(DOCS_PATH, e.name));

  if (rootFiles.length > 0) {
    try {
      for (const file of rootFiles) {
        await ingestFile(file);
      }
      results.push({ service: '(root docs)', count: rootFiles.length });
    } catch (err) {
      results.push({ service: '(root docs)', error: err.message });
    }
  }

  // Unmanaged subdirectories
  const unmanagedDirs = entries
    .filter(e => e.isDirectory() && !managed.has(e.name))
    .map(e => path.join(DOCS_PATH, e.name));

  for (const dir of unmanagedDirs) {
    try {
      await ingestAll(dir);
      results.push({ service: path.basename(dir), count: null });
    } catch (err) {
      results.push({ service: path.basename(dir), error: err.message });
    }
  }

  return results;
}

/**
 * Run training for all configured services (or a specific one by name).
 * Returns an array of result objects: { service, count, error? }
 */
export async function runTraining(serviceName = null) {
  const allServices = loadServices();
  const services = allServices.filter(s => !serviceName || s.name === serviceName);
  const results = [];

  for (const service of services) {
    try {
      const result = service.scrape
        ? await scrapeService(service)
        : service.read
          ? await readService(service)
          : await trainService(service);
      if (result) {
        await ingestAll(result.outDir);
        results.push({ service: service.name, count: result.count });
      }
    } catch (err) {
      console.error(`Training error for ${service.name}:`, err.config?.url || '', err.message);
      results.push({ service: service.name, error: err.message });
    }
  }

  // Also ingest any docs not managed by a service config (unless targeting a specific service)
  if (!serviceName) {
    const managedNames = allServices.map(s => s.name);
    const unmanaged = await ingestUnmanagedDocs(managedNames);
    results.push(...unmanaged);
  }

  return results;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('train.js')) {
  const results = await runTraining();
  for (const r of results) {
    if (r.error) console.error(`✗ ${r.service}: ${r.error}`);
    else console.log(`✓ ${r.service}: ${r.count} items ingested`);
  }
  process.exit(0);
}
