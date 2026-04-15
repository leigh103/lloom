import fs from 'fs/promises';
import path from 'path';
import { getDb } from '../db.js';
import { embed } from '../ollama.js';
import 'dotenv/config';

const CHUNK_SIZE = 500;   // words per chunk
const CHUNK_OVERLAP = 50; // words overlap between chunks

/**
 * Strip HTML tags and decode common entities from a string.
 * Runs on all ingested text so that embedding quality isn't
 * degraded by markup noise (e.g. API responses with HTML bodies).
 */
function stripHtml(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split markdown text into sections at heading boundaries, then apply
 * sliding-window chunking within any section that exceeds CHUNK_SIZE words.
 * This keeps semantically distinct sections (e.g. ### Beccy) as focused
 * chunks rather than blending them with surrounding content.
 */
function chunkText(text, source) {
  // Split on lines that start a new heading, keeping the heading with its body
  const sections = text.split(/(?=^#{1,6}\s)/m).map(s => s.trim()).filter(s => s.length > 50);

  // If no headings found, treat the whole text as one section
  const parts = sections.length > 0 ? sections : [text.trim()];

  const chunks = [];

  for (const section of parts) {
    const words = section.split(/\s+/);

    if (words.length <= CHUNK_SIZE) {
      chunks.push({ source, chunk: section, chunkIndex: chunks.length });
    } else {
      // Section is large — slide with overlap, prefixing each sub-chunk with the heading
      const newline = section.indexOf('\n');
      const prefix = newline > 0 ? section.slice(0, newline).trim() + '\n\n' : '';
      const body = newline > 0 ? section.slice(newline + 1).trim() : section;
      const bodyWords = body.split(/\s+/);

      for (let i = 0; i < bodyWords.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        const chunk = (prefix + bodyWords.slice(i, i + CHUNK_SIZE).join(' ')).trim();
        if (chunk.length > 50) {
          chunks.push({ source, chunk, chunkIndex: chunks.length });
        }
        if (i + CHUNK_SIZE >= bodyWords.length) break;
      }
    }
  }

  return chunks;
}

/**
 * Recursively find all .md files in a directory
 */
async function findMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Ingest a single markdown file into the vector store
 */
export async function ingestFile(filePath) {
  const db = getDb();
  const fileStart = Date.now();

  const raw = await fs.readFile(filePath, 'utf-8');
  const text = stripHtml(raw);
  const source = path.relative(process.env.DOCS_PATH || './docs', filePath);
  const chunks = chunkText(text, source);

  console.log(`[ingest] ${source} — ${chunks.length} chunks`);

  // Remove existing chunks for this source file
  db.prepare(`DELETE FROM knowledge_vec WHERE source = ?`).run(source);
  db.prepare(`DELETE FROM knowledge_fts WHERE source = ?`).run(source);

  const insertVec = db.prepare(`
    INSERT INTO knowledge_vec(embedding, source, chunk, ingested_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO knowledge_fts(chunk, source) VALUES (?, ?)
  `);

  const now = new Date().toISOString();

  const embedStart = Date.now();
  const embeddings = await embed(chunks.map(c => c.chunk));
  console.log(`[ingest]   embed ${chunks.length} chunk(s) — ${Date.now() - embedStart}ms`);

  const dbStart = Date.now();
  db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      insertVec.run(new Float32Array(embeddings[i]), chunks[i].source, chunks[i].chunk, now);
      insertFts.run(chunks[i].chunk, chunks[i].source);
    }
  })();
  console.log(`[ingest]   db write — ${Date.now() - dbStart}ms`);

  const totalMs = Date.now() - fileStart;
  console.log(`[ingest] ${source} — done in ${(totalMs / 1000).toFixed(1)}s`);

  return chunks.length;
}

/**
 * Ingest all markdown files in the docs folder
 */
export async function ingestAll(docsPath) {
  const dir = docsPath || process.env.DOCS_PATH || './docs';
  const files = await findMarkdownFiles(dir);

  console.log(`[ingest] Found ${files.length} file(s) in ${dir}`);
  const totalStart = Date.now();

  for (const file of files) {
    await ingestFile(file);
  }

  const totalMs = Date.now() - totalStart;
  console.log(`[ingest] All done — ${files.length} file(s) in ${(totalMs / 1000).toFixed(1)}s`);
}
