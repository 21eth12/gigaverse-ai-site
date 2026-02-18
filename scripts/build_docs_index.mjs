// scripts/build_docs_index.mjs
// Crawl a public GitBook site and generate docs_index.json (title/section/text chunks)
// Node 18+ (Node 20 on GitHub Actions is perfect)

import fs from "fs";
import path from "path";
import { load } from "cheerio";

const START_URL = "https://glhfers.gitbook.io/gigaverse";
const ALLOWED_HOST = "glhfers.gitbook.io";
const ALLOWED_PREFIX = "/gigaverse"; // only crawl under this path

// Output goes to repo root (one level up from /scripts)
const OUT_FILE = path.join(process.cwd(), "docs_index.json");

// Crawl controls
const MAX_PAGES = 400;        // safety cap
const REQUEST_DELAY_MS = 400; // be polite
const CHUNK_CHAR_LIMIT = 1400;
const MIN_CHUNK_CHARS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function sameScope(urlObj) {
  if (!urlObj) return false;
  if (urlObj.host !== ALLOWED_HOST) return false;
  if (!urlObj.pathname.startsWith(ALLOWED_PREFIX)) return false;
  return true;
}

function cleanText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function makeId(url, section, idx) {
  const base = `${url}|${section || ""}|${idx}`;
  // lightweight stable hash
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `gb-${h.toString(16)}`;
}

function splitIntoChunks(text, limit = CHUNK_CHAR_LIMIT) {
  const t = cleanText(text);
  if (!t) return [];
  if (t.length <= limit) return [t];

  // split by paragraphs first
  const paras = t.split(/\n\s*\n/).map(cleanText).filter(Boolean);
  const chunks = [];
  let buf = "";

  for (const p of paras) {
    if (!buf) {
      buf = p;
      continue;
    }
    if ((buf + "\n\n" + p).length <= limit) {
      buf += "\n\n" + p;
    } else {
      chunks.push(buf);
      buf = p;
    }
  }
  if (buf) chunks.push(buf);

  // if any chunk still too big, hard-slice it
  const out = [];
  for (const c of chunks) {
    if (c.length <= limit) out.push(c);
    else {
      for (let i = 0; i < c.length; i += limit) out.push(cleanText(c.slice(i, i + limit)));
    }
  }
  return out.filter((x) => x.length >= MIN_CHUNK_CHARS);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "GigaverseDocsIndexer/1.0 (+https://github.com/21eth12/gigaverse-ai-site)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

function extractLinks($, baseUrl) {
  const links = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    // ignore anchors/mailto/tel/javascript
    if (href.startsWith("#")) return;
    if (href.startsWith("mailto:")) return;
    if (href.startsWith("tel:")) return;
    if (href.startsWith("javascript:")) return;

    let u;
    try {
      u = new URL(href, baseUrl);
    } catch {
      return;
    }

    // strip hash + common tracking
    u.hash = "";
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    u.searchParams.delete("utm_term");
    u.searchParams.delete("utm_content");

    // normalize trailing slash (except root)
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }

    if (!sameScope(u)) return;
    links.add(u.toString());
  });

  return Array.from(links);
}

function pageTitle($) {
  // GitBook titles vary; prefer h1 then <title>
  const h1 = cleanText($("main h1").first().text() || $("h1").first().text());
  const t = cleanText($("title").text());
  return h1 || t || "Untitled";
}

function removeNoise($) {
  // remove nav/footers/sidebars/scripts/styles
  $("script, style, noscript").remove();
  $("nav, header, footer, aside").remove();

  // GitBook often has sidebars; keep main content if present
  // If main exists, we’ll focus extraction on it later.
}

function extractContentBlocks($) {
  // Prefer GitBook main content
  const root = $("main").length ? $("main").first() : $("body");

  // Turn tables into text
  root.find("table").each((_, tbl) => {
    const rows = [];
    load($(tbl).html() || "")("tr").each((__, tr) => {
      const cells = [];
      load($(tr).html() || "")("th,td").each((___, td) => {
        const cellText = cleanText(load($(td).html() || "").text());
        if (cellText) cells.push(cellText);
      });
      if (cells.length) rows.push(cells.join(" | "));
    });
    const tableText = rows.length ? "Table:\n" + rows.join("\n") : "";
    $(tbl).replaceWith(`<pre>${tableText}</pre>`);
  });

  // Build blocks by walking headings and text
  const blocks = [];

  // Gather elements in order
  const elements = root.find("h1,h2,h3,h4,p,li,pre,code,blockquote").toArray();

  let currentSection = "Overview";
  let buffer = "";

  const flush = () => {
    const text = cleanText(buffer);
    if (text && text.length >= MIN_CHUNK_CHARS) {
      blocks.push({ section: currentSection, text });
    }
    buffer = "";
  };

  for (const el of elements) {
    const tag = el.tagName?.toLowerCase?.() || "";
    const txt = cleanText($(el).text());

    if (!txt) continue;

    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
      // new section; flush old buffer
      flush();
      currentSection = txt;
      continue;
    }

    // regular content
    // keep lists readable
    if (tag === "li") {
      buffer += (buffer ? "\n" : "") + `- ${txt}`;
    } else if (tag === "pre" || tag === "code") {
      buffer += (buffer ? "\n\n" : "") + `Code/Pre:\n${txt}`;
    } else if (tag === "blockquote") {
      buffer += (buffer ? "\n\n" : "") + `Quote:\n${txt}`;
    } else {
      buffer += (buffer ? "\n\n" : "") + txt;
    }

    // if buffer too large, flush to blocks and keep going
    if (buffer.length >= CHUNK_CHAR_LIMIT * 1.2) {
      flush();
    }
  }

  flush();
  return blocks;
}

async function crawl() {
  const queue = [START_URL];
  const seen = new Set();
  const pages = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    console.log(`Crawling (${pages.length + 1}/${MAX_PAGES}): ${url}`);

    let html;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      console.warn(`Skip (fetch error): ${url} :: ${e.message}`);
      continue;
    }

    const $ = load(html);
    removeNoise($);

    const title = pageTitle($);
    const blocks = extractContentBlocks($);

    // add discovered links
    const links = extractLinks($, url);
    for (const l of links) {
      if (!seen.has(l)) queue.push(l);
    }

    pages.push({ url, title, blocks });

    await sleep(REQUEST_DELAY_MS);
  }

  return pages;
}

function buildIndex(pages) {
  const chunks = [];

  for (const p of pages) {
    const { url, title, blocks } = p;

    // Convert each block to multiple chunks if needed
    blocks.forEach((b, bIdx) => {
      const parts = splitIntoChunks(b.text, CHUNK_CHAR_LIMIT);
      parts.forEach((part, i) => {
        chunks.push({
          id: makeId(url, b.section, bIdx * 1000 + i),
          title: title || "Untitled",
          section: b.section || "Overview",
          url,
          text: part,
        });
      });
    });
  }

  return chunks;
}

async function main() {
  console.log("Starting GitBook crawl...");
  console.log(`Start: ${START_URL}`);
  console.log(`Scope: ${ALLOWED_HOST}${ALLOWED_PREFIX}`);

  const pages = await crawl();
  console.log(`Fetched pages: ${pages.length}`);

  const chunks = buildIndex(pages);
  console.log(`Built chunks: ${chunks.length}`);

  // Write pretty JSON
  fs.writeFileSync(OUT_FILE, JSON.stringify(chunks, null, 2), "utf8");
  console.log(`Wrote: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
