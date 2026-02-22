// /api/chat.js — Gigaverse AI (Groq) — Docs-first (PRO retrieval + accuracy upgrades)
// Expects POST { question: string, chunks?: [{title, section, text, url?}] }
// Returns JSON: { mode, answer, followups, citations }

// -------------------- Simple In-Memory Rate Limiter --------------------
// 6 requests per rolling 60 seconds per IP.
// After the 6th request, the 7th gets blocked until enough time passes.
const rateLimitMap = new Map();

function rateLimit(ip, limit = 6, windowMs = 60_000) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip);

  // keep only timestamps within the window
  const recent = timestamps.filter((ts) => now - ts < windowMs);

  if (recent.length >= limit) {
    const retryAfterSec = Math.ceil((windowMs - (now - recent[0])) / 1000);
    rateLimitMap.set(ip, recent); // store cleaned list
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  rateLimitMap.set(ip, recent);
  return { allowed: true, retryAfterSec: 0 };
}

// optional: light cleanup to prevent unbounded growth
function cleanupRateLimitMap(maxIps = 5000) {
  if (rateLimitMap.size <= maxIps) return;
  const entries = Array.from(rateLimitMap.entries());
  entries.sort((a, b) => (a[1]?.[0] ?? 0) - (b[1]?.[0] ?? 0));
  const toDelete = Math.max(0, entries.length - maxIps);
  for (let i = 0; i < toDelete; i++) rateLimitMap.delete(entries[i][0]);
}

// -------------------- Helpers --------------------
const QUESTION_MAX = 900;
const CHUNKS_MAX = 12; // max chunks accepted from client or site index per request
const CHUNK_TEXT_MAX = 2400;
const INDEX_CAP = 7000; // safety cap if docs index is huge

function clampText(t, max) {
  const s = typeof t === "string" ? t : "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalize(s) {
  return (typeof s === "string" ? s : "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

// Build n-grams for better phrase matching (accuracy boost)
function ngrams(words, n) {
  const out = [];
  for (let i = 0; i + n <= words.length; i++) {
    out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

// Lightweight synonym expansion for common “generic” asks
// (keeps retrieval tight without needing embeddings server-side)
function expandQueryWords(words) {
  const syn = {
    better: ["progress", "improve", "upgrade", "optimize", "stronger"],
    progress: ["level", "leveling", "improve", "better"],
    level: ["leveling", "upgrade", "rank"],
    craft: ["crafting", "alchemy", "station", "table", "brew"],
    potion: ["potions", "consumable", "elixir"],
    fish: ["fishing", "catch", "bait"],
    egg: ["hatch", "hatching", "gigling", "giglings"],
    drop: ["drops", "loot", "farm"],
    get: ["obtain", "find", "acquire"],
    use: ["using", "equip", "activate"],
    best: ["optimal", "meta", "recommended"],
  };

  const expanded = [...words];
  for (const w of words) {
    const add = syn[w];
    if (add) expanded.push(...add);
  }
  return uniq(expanded);
}

// -------------------- Retrieval Scoring --------------------
function scoreChunkFactory(qRaw) {
  const qNorm = normalize(qRaw);
  const qWordsBase = qNorm.split(" ").filter((w) => w.length >= 3);

  // expanded words help match “how do i get better” -> “progress / leveling”
  const qWords = expandQueryWords(qWordsBase);

  const qBigrams = ngrams(qWordsBase, 2);
  const qTrigrams = ngrams(qWordsBase, 3);

  // intent boosts (kept small)
  const intentWords = [
    "how",
    "where",
    "what",
    "drop",
    "drops",
    "craft",
    "crafting",
    "earn",
    "get",
    "use",
    "fight",
    "best",
    "level",
    "upgrade",
  ];

  return function scoreChunk(chunk) {
    const title = normalize(chunk?.title || "");
    const section = normalize(chunk?.section || "");
    const text = normalize(chunk?.text || "");

    if (!text && !title && !section) return 0;

    let score = 0;

    // 1) Strongest: exact normalized question appears
    if (qNorm && text.includes(qNorm)) score += 40;
    if (qNorm && title.includes(qNorm)) score += 34;
    if (qNorm && section.includes(qNorm)) score += 26;

    // 2) Phrase matches (bigrams/trigrams) — huge accuracy win
    for (const p of qTrigrams) {
      if (!p) continue;
      if (title.includes(p)) score += 18;
      if (section.includes(p)) score += 12;
      if (text.includes(p)) score += 6;
    }
    for (const p of qBigrams) {
      if (!p) continue;
      if (title.includes(p)) score += 10;
      if (section.includes(p)) score += 7;
      if (text.includes(p)) score += 3;
    }

    // 3) Word-level scoring (title/section weighted)
    for (const w of qWords) {
      if (!w) continue;
      if (title.includes(w)) score += 6;
      if (section.includes(w)) score += 4;
      if (text.includes(w)) score += 1;
    }

    // 4) Intent boost only if the intent word is in the question
    for (const iw of intentWords) {
      if (!qNorm.includes(iw)) continue;
      if (title.includes(iw) || section.includes(iw)) score += 3;
      else if (text.includes(iw)) score += 1;
    }

    // 5) Penalize tiny chunks (often junk)
    const len = (chunk?.text || "").length;
    if (len > 0 && len < 140) score -= 6;

    // 6) Penalize “single-word” hits: if chunk matches only 1 query word, likely irrelevant
    let matched = 0;
    for (const w of qWordsBase) {
      if (w.length < 3) continue;
      if (title.includes(w) || section.includes(w) || text.includes(w)) matched++;
    }
    if (qWordsBase.length >= 3 && matched <= 1) score -= 10;

    return score;
  };
}

function rerankAndPick(allChunks, qRaw, k = 6) {
  const list = Array.isArray(allChunks) ? allChunks : [];
  const limited = list.slice(0, CHUNKS_MAX);
  const scoreChunk = scoreChunkFactory(qRaw);

  const scored = limited
    .map((c) => ({
      title: String(c?.title || "Untitled"),
      section: String(c?.section || ""),
      url: String(c?.url || ""),
      text: clampText(String(c?.text || ""), CHUNK_TEXT_MAX),
      _score: scoreChunk(c),
    }))
    .sort((a, b) => b._score - a._score);

  // small threshold to avoid noise; keep at least 1 if everything is weak
  const filtered = scored.filter((x) => x._score > 0).slice(0, k);
  return filtered.length ? filtered : scored.slice(0, Math.min(1, k));
}

// -------------------- Server --------------------
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // ---- Rate Limiting (6 per minute per IP) ----
    const xff = (req.headers["x-forwarded-for"] || "").toString();
    const ip =
      xff.split(",")[0]?.trim() ||
      (req.headers["x-real-ip"] || "").toString().trim() ||
      (req.socket?.remoteAddress || "").toString() ||
      "unknown";

    const rl = rateLimit(ip, 6, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({
        error: `Rate limit exceeded. You can ask 6 questions per minute. Try again in ${rl.retryAfterSec} seconds.`,
      });
    }
    cleanupRateLimitMap(5000);

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GROQ_API_KEY in Vercel env vars" });

    const body = req.body || {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return res.status(400).json({ error: "Missing 'question' string" });

    const qRaw = question.slice(0, QUESTION_MAX);

    async function fetchDocsIndexFromSite() {
      const proto = (req.headers["x-forwarded-proto"] || "https").toString();
      const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
      if (!host) return [];

      const origin = `${proto}://${host}`;
      const url = `${origin}/docs_index.json?cb=${Date.now()}`;

      const r = await fetch(url, { headers: { "cache-control": "no-store" } });
      if (!r.ok) return [];

      const data = await r.json().catch(() => null);
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.chunks)) return data.chunks;
      if (data && Array.isArray(data.docs)) return data.docs;
      return [];
    }

    // Client chunks (rerank)
    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];
    let picked = rerankAndPick(clientChunks, qRaw, 6);

    // Fallback to docs_index.json only if needed
    if (!picked.length || (picked.length === 1 && (picked[0]?._score ?? 0) <= 0)) {
      const docsIndex = await fetchDocsIndexFromSite();
      const capped = docsIndex.length > INDEX_CAP ? docsIndex.slice(0, INDEX_CAP) : docsIndex;
      picked = rerankAndPick(capped, qRaw, 6);
    }

    // Build a source map so we can validate citations later
    const sources = picked.map((c, i) => {
      const title = (c.title || "Untitled").trim();
      const section = (c.section || "").trim();
      const url = (c.url || "").trim();
      const text = (c.text || "").trim();
      return {
        sourceNumber: i + 1,
        title,
        section,
        url,
        text,
      };
    });

    const context = sources
      .map((s) => {
        return [
          `SOURCE ${s.sourceNumber}`,
          `TITLE: ${s.title}`,
          s.section ? `SECTION: ${s.section}` : "",
          s.url ? `URL: ${s.url}` : "",
          `CONTENT:\n${s.text}`,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n---\n\n");

    // Make a validation set: title+section must exist in the loaded sources
    const validCitationKeys = new Set(
      sources.map((s) => `${s.title.toLowerCase()}__${(s.section || "").toLowerCase()}`)
    );

    const SYSTEM = `
You are Gigaverse AI, the official AI assistant for the Gigaverse community.

Style:
- Speak clearly and confidently.
- Be helpful and professional.
- Avoid robotic phrases.
- Do not mention internal implementation details (no “chunks”, no “docs index”, no “RAG”).
- No jokes, no roleplay, no sarcasm.

Behavior (Docs-first, accuracy-first):
1) If SOURCES contain the answer, answer ONLY using those SOURCES.
2) If SOURCES do not contain the answer, still help, but be explicit: “I don’t see this explicitly in the docs I have loaded.”
3) Never invent Gigaverse-specific mechanics not supported by SOURCES.
4) For mode="docs": every important claim must be supported by SOURCES.
5) Citations must match the SOURCES provided.

Output (JSON only):
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"source": number, "title": string, "section": string, "evidence": string}]
}
`.trim();

    const userPrompt = `
SOURCES:
${context || "(no sources matched)"}

USER QUESTION:
${qRaw}

Rules:
- If SOURCES contain the answer, set mode="docs".
- If SOURCES do NOT contain the answer, set mode="helper" and citations must be [].
- If mode="docs": include up to 3 citations.
- Each citation MUST include:
  - source: the SOURCE number (1..6)
  - title + section from that SOURCE
  - evidence: a short supporting excerpt (max 160 chars) copied from the SOURCE content
- Followups: 0–2 short questions only if helpful.
Return JSON only.
`.trim();

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0.15,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const raw = await groqRes.json().catch(() => null);

    if (!groqRes.ok) {
      const msg = raw?.error?.message || raw?.error || `Groq error (${groqRes.status})`;
      return res.status(groqRes.status).json({ error: msg, details: raw });
    }

    const content = raw?.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { mode: "helper", answer: content, followups: [], citations: [] };
    }

    let mode = parsed?.mode === "docs" ? "docs" : "helper";

    let answer =
      typeof parsed?.answer === "string" && parsed.answer.trim()
        ? parsed.answer.trim()
        : "I can help—what are you trying to do in Gigaverse?";

    const followups = Array.isArray(parsed?.followups)
      ? parsed.followups.slice(0, 2).map((x) => String(x)).filter(Boolean)
      : [];

    // ---- Validate + dedupe citations (accuracy enforcement) ----
    let citations = Array.isArray(parsed?.citations) ? parsed.citations : [];
    if (mode === "helper") citations = [];

    const seen = new Set();
    const unique = [];

    for (const c of citations) {
      const sourceNum = Number(c?.source);
      const t = (c?.title || "").toString().trim();
      const s = (c?.section || "").toString().trim();
      const ev = (c?.evidence || "").toString().trim();

      if (!Number.isFinite(sourceNum) || sourceNum < 1 || sourceNum > sources.length) continue;
      if (!t) continue;

      const key = `${t.toLowerCase()}__${s.toLowerCase()}`;
      if (!validCitationKeys.has(key)) continue;

      // keep evidence short (and safe)
      const evidence = ev.length > 160 ? ev.slice(0, 160) : ev;

      const dedupeKey = `${sourceNum}__${key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      unique.push({ source: sourceNum, title: t, section: s, evidence });
      if (unique.length >= 3) break;
    }

    // If the model claimed docs-mode but produced no valid citations,
    // downgrade to helper-mode to prevent unsupported “confident” answers.
    if (mode === "docs" && unique.length === 0) {
      mode = "helper";
      // keep it helpful + explicit (but don’t mention internals)
      if (!/^i don’t see this explicitly in the docs i have loaded/i.test(answer)) {
        answer = `I don’t see this explicitly in the docs I have loaded.\n\n${answer}`;
      }
    }

    return res.status(200).json({
      mode,
      answer,
      followups,
      // backward-compatible: UI can ignore "source" and "evidence" if it wants
      citations: unique,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
