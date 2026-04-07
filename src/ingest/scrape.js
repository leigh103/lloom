import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { load } from 'cheerio';
import { ingestAll } from './ingest.js';

const DOCS_PATH = process.env.DOCS_PATH || './docs';

// Elements to strip before extracting text
const STRIP_SELECTORS = 'script, style, nav, header, footer, [aria-hidden="true"], .cookie-banner, #cookie-banner';
const SKIP_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|ico|pdf|zip|mp4|mp3|woff|woff2|ttf|eot)(\?.*)?$/i;

function extractLinks($, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const links = new Set();
  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      const url = new URL(href, baseUrl);
      // Same domain only, no fragments, no non-http
      if (url.origin === origin && !url.hash && url.protocol.startsWith('http') && !SKIP_EXTENSIONS.test(url.pathname) && !url.pathname.startsWith('/cdn-cgi/')) {
        url.hash = '';
        url.search = url.search; // keep query strings
        links.add(url.href.replace(/\/$/, ''));
      }
    } catch {}
  });
  return links;
}

function extractContent($, url) {
  $(STRIP_SELECTORS).remove();

  const title = $('title').text().trim() || $('h1').first().text().trim() || url;

  // Prefer main content area if present
  const contentEl = $('main, article, [role="main"], .content, #content').first();
  const target = contentEl.length ? contentEl : $('body');

  const text = target.text()
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

function urlToFilename(url) {
  const u = new URL(url);
  const slug = (u.pathname + u.search)
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '') || 'index';
  return `${slug}.md`;
}

async function fetchPage(url) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    timeout: 10000,
    responseType: 'text',
    maxRedirects: 5,
  });
  return String(res.data);
}

export async function scrapeService(service) {
  const { name, scrape } = service;
  const rootUrl = scrape.url.replace(/\/$/, '');
  const maxDepth = scrape.depth ?? 2;
  const maxPages = scrape.maxPages ?? Infinity;
  const delayMs = scrape.delayMs ?? 0;

  const visited = new Set();
  const queue = [{ url: rootUrl, depth: 0 }];
  const pages = []; // { url, title, text }

  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    if (delayMs > 0 && visited.size > 1) await new Promise(r => setTimeout(r, delayMs));

    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.error(`scrape error ${err.response?.status || err.message} — ${url}`);
      continue;
    }

    const $ = load(html);
    const { title, text } = extractContent($, url);
    console.log(`scraped: ${url} — ${text.length} chars`);
    if (text.length > 100) pages.push({ url, title, text });

    if (depth < maxDepth && pages.length < maxPages) {
      for (const link of extractLinks($, url)) {
        if (!visited.has(link)) queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  if (pages.length === 0) return null;

  const outDir = path.join(DOCS_PATH, name);
  if (fs.existsSync(outDir)) {
    fs.readdirSync(outDir).filter(f => f.endsWith('.md')).forEach(f => fs.unlinkSync(path.join(outDir, f)));
  } else {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const { url, title, text } of pages) {
    const markdown = `# ${title}\n\nSource: ${url}\n\n${text}`;
    fs.writeFileSync(path.join(outDir, urlToFilename(url)), markdown, 'utf-8');
  }

  return { outDir, count: pages.length };
}
