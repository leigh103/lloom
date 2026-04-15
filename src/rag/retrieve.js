import { getDb } from '../db.js';
import { embed } from '../ollama.js';

const TOP_K = 5;
const RRF_K = 60;          // RRF constant — higher = less aggressive rank weighting
const MAX_DISTANCE = 0.95; // discard vector results with no meaningful similarity

/**
 * Build an FTS5 OR query from a natural language string.
 * Uses OR so partial word matches still contribute a BM25 score.
 * Filters short/common words to reduce noise.
 */
const FTS_STOPWORDS = new Set(['a','an','the','is','it','in','on','of','to','and','or','for','with','was','when','how','what','why','who','are','be','been','has','had','have','do','did','does','this','that','these','those','by','at','as','from','not','no','so','its','my','we','i','you','he','she','they']);

function sanitiseFtsQuery(query) {
  const words = query
    .replace(/[^a-z0-9\s]/gi, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !FTS_STOPWORDS.has(w));
  return words.join(' OR ');
}

/**
 * Find the most relevant knowledge chunks using hybrid vector + BM25 search,
 * merged with Reciprocal Rank Fusion (RRF).
 */
export async function retrieve(query, k = TOP_K) {
  const db = getDb();

  // Vector search — fetch 2× k so RRF has enough candidates from each side.
  // Filter by MAX_DISTANCE to exclude low-quality matches, but if that leaves
  // too few results, fall back to the raw top-k so the LLM always has something.
  const queryEmbedding = await embed(query);
  const allVecResults = db.prepare(`
    SELECT source, chunk, distance
    FROM knowledge_vec
    WHERE embedding MATCH ?
    AND k = ?
    ORDER BY distance
  `).all(new Float32Array(queryEmbedding), k * 2);
  const vecResults = allVecResults.filter(r => r.distance < MAX_DISTANCE).length >= 2
    ? allVecResults.filter(r => r.distance < MAX_DISTANCE)
    : allVecResults;

  // BM25 keyword search via FTS5
  let ftsResults = [];
  const ftsQuery = sanitiseFtsQuery(query);
  if (ftsQuery) {
    try {
      ftsResults = db.prepare(`
        SELECT source, chunk, rank
        FROM knowledge_fts
        WHERE knowledge_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, k * 2);
    } catch {
      // Malformed FTS query — fall back to vector-only
    }
  }

  // Reciprocal Rank Fusion: score = Σ 1 / (RRF_K + rank)
  const scores = new Map();
  const data = new Map();
  const key = r => `${r.source}::${r.chunk.slice(0, 80)}`;

  vecResults.forEach((r, i) => {
    const id = key(r);
    scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + i + 1));
    data.set(id, { source: r.source, chunk: r.chunk });
  });

  ftsResults.forEach((r, i) => {
    const id = key(r);
    scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + i + 1));
    data.set(id, { source: r.source, chunk: r.chunk });
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => data.get(id));
}

/**
 * Build a context string from retrieved chunks to inject into the prompt
 */
export function buildContext(chunks) {
  if (chunks.length === 0) return null;

  const parts = chunks.map(c =>
    `[Source: ${c.source}]\n${c.chunk}`
  );

  return parts.join('\n\n---\n\n');
}
