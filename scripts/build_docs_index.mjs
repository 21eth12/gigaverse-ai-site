/**
 * scripts/build_docs_index.mjs
 *
 * Crawls GitBook (glhfers.gitbook.io/gigaverse) and generates docs_index.json
 * Output format: [{ id, title, section, url, text }]
 *
 * Node: 20+ (GitHub Actions ubuntu-latest is fine)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(REPO_ROOT, "docs_index.json");

// ---- Config ----
const START_URL = process.env.START_URL || "https://glhfers.gitbook.io/gigaverse";
const ALLOWED_HOST = "glhfers.gitbook.io";
const ALLOWED_PREFIX = "/gigaverse";

const MAX_PAGES = Number(process.env.MAX_PAGES || 250); // safety limit
const FETCH_DELAY_MS = Number(process.env.FETCH_DELAY_MS || 350); // be polite
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);

const CHUNK_TARGET_CHARS = Number(process.env.CHUNK_TARGET_CHARS || 1600);
const CHUNK_OVERLAP_CHARS = Number(process.env.CHUNK_OVERLAP_CHARS || 250);
const MIN_CHUNK_CHARS = Number(process.env.MIN_CHUNK_CHARS || 400);

// Words/markers that commonly pollute GitBook exports
const NOISE_PATTERNS = [
  /arrow-up-right/gi,
  /chevron-left/gi,
  /chevron-right/gi,
  /hashtag/gi,
  /\bcopy\b/gi,
  /\bedit\b/gi,
  /\bsearch\b/gi,
  /\bpowered by gitbook\b/gi,
  /\bprevious\b/gi,
  /\bnext\b/gi,
];

// ---- Helpers ----
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stableId(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 10);
}

function normalizeUrl(raw, baseUrl) {
  try {
    const u = new URL(raw, baseUrl);
    // only allow same host and under prefix
    if (u.host !== ALLOWED_HOST) return null;
    if (!u.pathname.startsWith(ALLOWED_PREFIX)) return null;
    // remove hash + normalize trailing slash
    u.hash = "";
    // keep query off (GitBook sometimes adds tracking)
    u.search = "";
    // normalize trailing slash (optional)
    if (u.pathname.endsWith("/") && u.pathname !== "/") {
      u.pathname = u.pathname.replace(/\/+$/, "/");
    }
    return u.toString();
  } catch {
    return null;
  }
}

function cleanText(s) {
  if (!s) return "";
  let t = s;

  // Replace non-breaking spaces etc
  t = t.replace(/\u00A0/g, " ");

  // Remove noise markers
  for (const re of NOISE_PATTERNS) t = t.replace(re, " ");

  // Remove repeated "hashtaghashtag..." kind of sequences
  t = t.replace(/(hashtag\s*){2,}/gi, " ");

  // Collapse whitespace
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]{2,}/g, " ");

  // Trim
  t = t.trim();

  return t;
}

function dedupeLines(text) {
  // Dedupe exact repeated lines/paragraphs while keeping order
  const parts = text.split(/\n{2,}/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.join("\n\n");
}

function chunkByParagraphs(text, targetChars, overlapChars) {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];

  let current = [];
  let currentLen = 0;

  function pushChunk() {
    const joined = current.join("\n\n").trim();
    if (joined.length >= MIN_CHUNK_CHARS) chunks.push(joined);
  }

  for (const p of paras) {
    if (!p) continue;

    // If a single paragraph is massive, hard-split it
    if (p.length > targetChars * 1.5) {
      // Flush existing
      if (currentLen > 0) {
        pushChunk();
        current = [];
        currentLen = 0;
      }
      let start = 0;
      while (start < p.length) {
        const slice = p.slice(start, start + targetChars);
        if (slice.trim().length >= MIN_CHUNK_CHARS) chunks.push(slice.trim());
        start += Math.max(1, targetChars - overlapChars);
      }
      continue;
    }

    // Normal build-up
    if (currentLen + p.length + 2 > targetChars && currentLen > 0) {
      pushChunk();

      // overlap: carry last overlapChars worth of text into next chunk
      const prev = current.join("\n\n");
      const carry = prev.slice(Math.max(0, prev.length - overlapChars)).trim();
      current = carry ? [carry] : [];
      currentLen = carry.length;
    }

    current.push(p);
    currentLen += p.length + 2;
  }

  if (currentLen > 0) pushChunk();

  return chunks;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "GigaverseDocsIndexer/1.0 (+https://github.com/21eth12/gigaverse-ai-site)",
        "accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function pickBestTitle($) {
  // Prefer h1 inside main/article, fallback to first h1, then <title>
  const t1 = cleanText($("main h1").first().text());
  if (t1) return t1;

  const t2 = cleanText($("article h1").first().text());
  if (t2) return t2;

  const t3 = cleanText($("h1").first().text());
  if (t3) return t3;

  const t4 = cleanText($("title").text());
  if (t4) return t4.replace(/\s*\|\s*GitBook.*$/i, "").trim();

  return "Gigaverse Docs";
}

function inferSectionFromUrl(urlStr) {
  // Basic section from path segments: /gigaverse/<group>/<page>
  try {
    const u = new URL(urlStr);
    const segs = u.pathname.split("/").filter(Boolean);
    const idx = segs.indexOf("gigaverse");
    const after = idx >= 0 ? segs.slice(idx + 1) : segs;
    if (after.length === 0) return "Overview";
    // Use first segment as "section group"
    const first = after[0].replace(/-/g, " ");
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    return "Overview";
  }
}

function extractMainText($) {
  // GitBook typically renders content in <main> with an <article>
  // We'll try a few selectors; then strip nav/footer/aside/code-copy junk.

  let $root = $("main article").first();
  if ($root.length === 0) $root = $("article").first();
  if ($root.length === 0) $root = $("main").first();
  if ($root.length === 0) $root = $("body");

  // Remove obvious non-content areas
  $root.find("nav, header, footer, aside").remove();

  // Remove buttons/copy widgets
  $root.find("button, [role='button'], .gitbook-markdown-copy-code-button").remove();

  // Remove SVG/icon-only elements
  $root.find("svg").remove();

  // Convert content to paragraph-ish blocks:
  // Grab headings + paragraphs + list items + table text + code blocks.
  const blocks = [];

  const candidates = $root.find("h1,h2,h3,h4,p,li,blockquote,pre,code,table");
  candidates.each((_, el) => {
    const tag = el.tagName?.toLowerCase?.() || "";
    let txt = "";

    if (tag === "pre") {
      txt = $(el).text();
      txt = txt ? `\n\nCODE:\n${txt}\n` : "";
    } else if (tag === "code") {
      // avoid double-counting code inside pre; but keep inline if meaningful
      const parentTag = $(el).parent()?.get(0)?.tagName?.toLowerCase?.();
      if (parentTag === "pre") return;
      txt = $(el).text();
    } else {
      txt = $(el).text();
    }

    txt = cleanText(txt);
    if (txt) blocks.push(txt);
  });

  let text = blocks.join("\n\n");
  text = cleanText(text);
  text = dedupeLines(text);

  return text;
}

function extractLinks($, pageUrl) {
  const links = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    // Skip mailto/tel/javascript
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;

    const norm = normalizeUrl(href, pageUrl);
    if (!norm) return;

    links.add(norm);
  });

  return Array.from(links);
}

// ---- Main crawl ----
async function main() {
  const visited = new Set();
  const queue = [START_URL];

  const out = [];

  console.log(`Start crawl: ${START_URL}`);
  console.log(`Output file: ${OUT_FILE}`);

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    console.log(`\n[${visited.size}/${MAX_PAGES}] Fetch: ${url}`);

    let html;
    try {
      html = await fetchWithTimeout(url);
    } catch (e) {
      console.log(`  !! fetch failed: ${e.message}`);
      continue;
    }

    const $ = cheerio.load(html);

    const title = pickBestTitle($);
    const section = inferSectionFromUrl(url);

    let text = extractMainText($);

    // If the page is basically empty, skip it
    if (!text || text.length < 100) {
      console.log("  .. no usable content, skipping");
    } else {
      // Chunk it
      const chunks = chunkByParagraphs(text, CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS);

      console.log(`  .. title: ${title}`);
      console.log(`  .. section: ${section}`);
      console.log(`  .. chunks: ${chunks.length}`);

      chunks.forEach((chunkText, i) => {
        const id = `gb-${stableId(`${url}#${i}`)}`;
        out.push({
          id,
          title: cleanText(title),
          section: cleanText(section),
          url,
          text: chunkText,
        });
      });
    }

    // Discover new links
    const newLinks = extractLinks($, url);
    for (const l of newLinks) {
      if (!visited.has(l)) queue.push(l);
    }

    await sleep(FETCH_DELAY_MS);
  }

  // Write output
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");

  console.log(`\nDone. Pages visited: ${visited.size}`);
  console.log(`Chunks written: ${out.length}`);
  console.log(`Wrote: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
