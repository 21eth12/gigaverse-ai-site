/**
 * build_docs_index.mjs
 * Crawls a public GitBook (glhfers.gitbook.io/gigaverse) and generates docs_index.json
 *
 * Usage:
 *   npm i cheerio
 *   node scripts/build_docs_index.mjs
 *
 * Output:
 *   ./docs_index.json  (overwrites)
 */

import fs from "fs";
import path from "path";
import cheerio from "cheerio";

const START_URL = "https://glhfers.gitbook.io/gigaverse";
const ALLOWED_HOST = "glhfers.gitbook.io";
const ALLOWED_PREFIX = "/gigaverse";

const OUT_FILE = path.join(process.cwd(), "docs_index.json");

// Safety knobs
const MAX_PAGES = 250;       // increase if needed
const REQUEST_DELAY_MS = 250; // be polite to GitBook
const MAX_CHUNK_CHARS = 1400; // chunk size target

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    // normalize trailing slash
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host !== ALLOWED_HOST) return false;
    if (!u.pathname.startsWith(ALLOWED_PREFIX)) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "GigaverseDocsBot/1.0 (+https://gigaverse-ai-site.vercel.app)",
      "Accept": "text/html",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}

function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  $("a[href]").each((_, a) => {
    const href = ($(a).attr("href") || "").trim();
    if (!href) return;

    // ignore anchors, mailto, tel
    if (href.startsWith("#")) return;
    if (href.startsWith("mailto:") || href.startsWith("tel:")) return;

    // resolve relative links
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    abs = normalizeUrl(abs);
    if (!abs) return;
    if (isAllowed(abs)) links.add(abs);
  });

  return [...links];
}

/**
 * Extract main content text and chunk it by headings.
 * GitBook HTML changes sometimes; this is a “best effort” approach.
 */
function pageToChunks(html, pageUrl) {
  const $ = cheerio.load(html);

  // Title: prefer h1, fallback to og:title, then <title>
  const title =
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim() ||
    "Untitled";

  // GitBook pages usually have a main article region.
  // We'll try common containers first; fallback to <main>.
  const $main =
    $("main").first().length ? $("main").first() :
    $('[data-testid="page-content"]').first().length ? $('[data-testid="page-content"]').first() :
    $("body").first();

  // Remove nav/sidebars/scripts/styles to reduce noise
  $main.find("nav, aside, header, footer, script, style").remove();

  // Collect nodes in reading order
  const nodes = $main.find("h2, h3, p, li, blockquote, pre").toArray();

  // If we didn’t find anything useful, fallback to all text
  if (!nodes.length) {
    const text = $main.text().replace(/\s+/g, " ").trim();
    if (!text) return [];
    return [{
      id: `page-${hash(pageUrl)}-0`,
      title,
      section: "Page",
      text: clampText(text, MAX_CHUNK_CHARS * 2),
      url: pageUrl,
    }];
  }

  const chunks = [];
  let currentSection = "Intro";
  let buffer = [];

  function flush() {
    const text = buffer.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    buffer = [];
    if (!text) return;

    // If too large, split roughly
    const parts = splitToSize(text, MAX_CHUNK_CHARS);
    parts.forEach((part, idx) => {
      chunks.push({
        id: `page-${hash(pageUrl)}-${hash(currentSection)}-${idx}`,
        title,
        section: currentSection,
        text: part.trim(),
        url: pageUrl,
      });
    });
  }

  for (const node of nodes) {
    const tag = node.tagName?.toLowerCase();
    const text = $(node).text().trim();
    if (!text) continue;

    if (tag === "h2" || tag === "h3") {
      // new section
      flush();
      currentSection = text;
      continue;
    }

    // keep bullets readable
    if (tag === "li") {
      buffer.push(`- ${text}`);
    } else {
      buffer.push(text);
    }
  }
  flush();

  // Light cleanup: remove very tiny chunks
  return chunks.filter(c => c.text.length >= 40);
}

function splitToSize(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // try to cut at paragraph boundary
    const cut = text.lastIndexOf("\n\n", end);
    if (cut > start + 200) end = cut;

    parts.push(text.slice(start, end).trim());
    start = end;
  }
  return parts.filter(Boolean);
}

function clampText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim();
}

// Simple stable hash (not crypto)
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function main() {
  console.log(`Crawling: ${START_URL}`);

  const seen = new Set();
  const queue = [normalizeUrl(START_URL)];
  const allChunks = [];

  while (queue.length && seen.size < MAX_PAGES) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    console.log(`(${seen.size}) Fetch ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.warn(`  !! failed: ${e.message}`);
      continue;
    }

    // Extract page chunks
    try {
      const chunks = pageToChunks(html, url);
      if (chunks.length) {
        allChunks.push(...chunks);
        console.log(`  + chunks: ${chunks.length}`);
      } else {
        console.log(`  - no chunks extracted`);
      }
    } catch (e) {
      console.warn(`  !! parse fail: ${e.message}`);
    }

    // Extract links and enqueue
    const links = extractLinks(html, url);
    for (const l of links) {
      if (!seen.has(l)) queue.push(l);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Deduplicate chunks by id
  const uniq = new Map();
  for (const c of allChunks) uniq.set(c.id, c);

  const out = [...uniq.values()];

  // Sort for stable diffs
  out.sort((a, b) => (a.title + a.section).localeCompare(b.title + b.section));

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");

  console.log(`\nDONE.`);
  console.log(`Pages crawled: ${seen.size}`);
  console.log(`Chunks written: ${out.length}`);
  console.log(`Output: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
