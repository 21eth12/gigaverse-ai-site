// /api/chat.js — Gigaverse AI (Groq) — Docs-first + Social + Progression Mode + Rate Limit
// Expects POST { question: string, chunks?: [{title, section, text, url?}] }
// Returns JSON: { mode, answer, followups, citations }
//
// Modes:
// - "social"       => warm small-talk / onboarding (no citations)
// - "progression"  => asks 2–3 clarifying questions for “what next?” (no citations)
// - "docs"         => answers from sources with citations
// - "helper"       => helpful guidance when docs don’t cover it (no citations)

export const config = {
  api: {
    bodyParser: { sizeLimit: "1mb" },
  },
};

// -------------------- Simple In-Memory Rate Limiter --------------------
// 6 requests per rolling 60 seconds per IP.
// After the 6th request, the 7th gets blocked until enough time passes.
const rateLimitMap = new Map();

function rateLimit(ip, limit = 6, windowMs = 60_000) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip);

  const recent = timestamps.filter((ts) => now - ts < windowMs);

  if (recent.length >= limit) {
    const retryAfterSec = Math.ceil((windowMs - (now - recent[0])) / 1000);
    rateLimitMap.set(ip, recent);
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  rateLimitMap.set(ip, recent);
  return { allowed: true, retryAfterSec: 0 };
}

function cleanupRateLimitMap(maxIps = 5000) {
  if (rateLimitMap.size <= maxIps) return;
  const entries = Array.from(rateLimitMap.entries());
  entries.sort((a, b) => (a[1]?.[0] ?? 0) - (b[1]?.[0] ?? 0));
  const toDelete = Math.max(0, entries.length - maxIps);
  for (let i = 0; i < toDelete; i++) rateLimitMap.delete(entries[i][0]);
}
// ----------------------------------------------------------------------

function normalize(s) {
  return (typeof s === "string" ? s : "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampText(t, max) {
  const s = typeof t === "string" ? t : "";
  return s.length > max ? s.slice(0, max) : s;
}

function pickClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString();
  const ip =
    xf.split(",")[0]?.trim() ||
    (req.headers["x-real-ip"] || "").toString().trim() ||
    (req.socket?.remoteAddress || "").toString() ||
    "unknown";
  return ip;
}

// -------------------- Intent Detection --------------------

function isSocialMessage(raw) {
  const q = normalize(raw);

  // Pure greetings / small-talk / identity questions
  const socialExact = new Set([
    "hi",
    "hii",
    "hiii",
    "hello",
    "hey",
    "heyy",
    "heyyy",
    "yo",
    "sup",
    "good morning",
    "good afternoon",
    "good evening",
    "gm",
    "gn",
    "how are you",
    "how r u",
    "how you doing",
    "what are you",
    "who are you",
    "what is this",
    "help",
    "start",
  ]);

  if (socialExact.has(q)) return true;

  // Short greeting-like messages (avoid turning real questions into social)
  if (q.length <= 18) {
    const starters = ["hi", "hello", "hey", "yo", "gm", "sup"];
    if (starters.some((s) => q === s || q.startsWith(s + " "))) {
      // If it contains clear game keywords, treat as not social
      const gameWords = [
        "fishing",
        "craft",
        "crafting",
        "egg",
        "eggs",
        "gigl",
        "gigl",
        "gigling",
        "gigl",
        "dungeon",
        "trade",
        "market",
        "gigamarket",
        "drops",
        "boss",
        "gear",
        "potion",
        "potions",
      ];
      if (!gameWords.some((w) => q.includes(w))) return true;
    }
  }

  // “how are you” variations
  if (q.includes("how are you") || q.includes("how r u") || q.includes("how you")) {
    // If they also ask a game question in same message, let docs handle
    const gameSignal = ["fishing", "craft", "egg", "dungeon", "trade", "gigamarket", "potion", "drops"];
    if (!gameSignal.some((w) => q.includes(w))) return true;
  }

  return false;
}

function isProgressionIntent(raw) {
  const q = normalize(raw);
  const triggers = [
    "what should i do",
    "what should i focus",
    "what next",
    "what do i do next",
    "how should i progress",
    "how do i progress",
    "what do i work on",
    "what should i work on",
    "how do i get better",
    "how can i get better",
    "how can i improve",
    "how to improve",
    "how to progress",
    "best way to progress",
    "help me progress",
  ];
  return triggers.some((t) => q.includes(t));
}

// -------------------- Chunk Rerank --------------------

function makeScorer(qRaw) {
  const q = normalize(qRaw);
  const qWords = q.split(" ").filter((w) => w.length >= 3);
  const intentWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best"];

  function scoreChunk(chunk) {
    const title = normalize(chunk?.title || "");
    const section = normalize(chunk?.section || "");
    const text = normalize(chunk?.text || "");
    if (!text && !title && !section) return 0;

    let score = 0;

    if (q && text.includes(q)) score += 30;
    if (q && title.includes(q)) score += 24;
    if (q && section.includes(q)) score += 16;

    for (const w of qWords) {
      if (title.includes(w)) score += 6;
      if (section.includes(w)) score += 4;
      if (text.includes(w)) score += 1;
    }

    for (const iw of intentWords) {
      if (!q.includes(iw)) continue;
      if (title.includes(iw) || section.includes(iw)) score += 4;
      else if (text.includes(iw)) score += 1;
    }

    const len = (chunk?.text || "").length;
    if (len > 0 && len < 140) score -= 4;

    return score;
  }

  return scoreChunk;
}

function rerankAndPick(allChunks, qRaw, caps) {
  const { CHUNKS_MAX, CHUNK_TEXT_MAX } = caps;
  const scoreChunk = makeScorer(qRaw);

  const list = Array.isArray(allChunks) ? allChunks : [];
  const limited = list.slice(0, CHUNKS_MAX);

  const scored = limited
    .map((c) => ({
      title: String(c?.title || "Untitled"),
      section: String(c?.section || ""),
      url: String(c?.url || ""),
      text: clampText(String(c?.text || ""), CHUNK_TEXT_MAX),
      _score: scoreChunk(c),
    }))
    .sort((a, b) => b._score - a._score);

  return scored.filter((x) => x._score > 0).slice(0, 6);
}

async function fetchDocsIndexFromSite(req) {
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

// -------------------- Groq Call --------------------

async function groqChat({ apiKey, system, userPrompt }) {
  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0.2,
      max_tokens: 650,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const raw = await groqRes.json().catch(() => null);

  if (!groqRes.ok) {
    const msg = raw?.error?.message || raw?.error || `Groq error (${groqRes.status})`;
    const err = new Error(msg);
    err.status = groqRes.status;
    err.details = raw;
    throw err;
  }

  const content = raw?.choices?.[0]?.message?.content || "{}";
  return content;
}

// -------------------- Main Handler --------------------

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // ---- Rate Limiting ----
    const ip = pickClientIp(req);
    const rl = rateLimit(ip, 6, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({
        mode: "helper",
        answer: `You’re sending messages a bit too fast. You can ask **6 questions per minute**. Try again in **${rl.retryAfterSec}s**.`,
        followups: [],
        citations: [],
      });
    }
    cleanupRateLimitMap(5000);

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GROQ_API_KEY in Vercel env vars" });

    const body = req.body || {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return res.status(400).json({ error: "Missing 'question' string" });

    // ✅ caps (prevents abuse + token explosions)
    const caps = {
      QUESTION_MAX: 900,
      CHUNKS_MAX: 12,
      CHUNK_TEXT_MAX: 2400,
    };
    const qRaw = question.slice(0, caps.QUESTION_MAX);

    // ---- 1) Social Mode (warm small-talk) ----
    if (isSocialMessage(qRaw)) {
      return res.status(200).json({
        mode: "social",
        answer:
          "Hey 👋 I’m **Gigaverse AI** — your in-game knowledge assistant.\n\nAsk me anything about **fishing, crafting, giglings/eggs, dungeons, trading, drops,** or **progression** and I’ll guide you.",
        followups: ["Want tips to level faster?", "What part of the game are you on right now?"],
        citations: [],
      });
    }

    // ---- 2) Progression Mode (“What should I do next?”) ----
    if (isProgressionIntent(qRaw)) {
      return res.status(200).json({
        mode: "progression",
        answer:
          "I’ve got you 👍\n\nTo give the best “what next” plan, tell me:\n1) What **level** are you?\n2) What are you focusing on right now: **Fishing / Crafting / Giglings (Eggs) / Dungeons / Trading**?\n3) Are you **event-focused** or **dungeon-focused**?",
        followups: [],
        citations: [],
      });
    }

    // ---- 3) Docs-first retrieval ----

    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];
    let picked = rerankAndPick(clientChunks, qRaw, caps);

    // fallback to docs_index.json only if needed
    if (picked.length === 0) {
      const docsIndex = await fetchDocsIndexFromSite(req);
      const capped = docsIndex.length > 7000 ? docsIndex.slice(0, 7000) : docsIndex;
      picked = rerankAndPick(capped, qRaw, caps);
    }

    const context = picked
      .map((c, i) => {
        const title = (c.title || "Untitled").trim();
        const section = (c.section || "").trim();
        const url = (c.url || "").trim();
        const text = (c.text || "").trim();
        return [
          `SOURCE ${i + 1}`,
          `TITLE: ${title}`,
          section ? `SECTION: ${section}` : "",
          url ? `URL: ${url}` : "",
          `CONTENT:\n${text}`,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n---\n\n");

    const SYSTEM = `
You are Gigaverse AI, the official AI assistant for the Gigaverse community.

Tone:
- Warm, friendly, and professional.
- Keep it short and practical.
- Avoid robotic phrases.
- No jokes, no roleplay, no sarcasm.
- Do not mention internal implementation details (no “chunks”, no “docs index”, no “RAG”).

Docs-first behavior:
1) If SOURCES contain the answer, answer from them and cite the relevant titles/sections.
2) If SOURCES do not contain the answer, still help with practical guidance and ask 1–2 targeted follow-up questions.
   - Be explicit: “I don’t see this explicitly in the docs I have loaded.”
3) Never invent Gigaverse-specific mechanics that are not supported by SOURCES.

If the user provides their level and current focus (fishing/crafting/eggs/dungeons/trading), give structured next-step guidance:

Format:
1) Immediate Focus
2) Skill/Mechanic Priority
3) Resource Focus
4) Mistakes to Avoid

Output JSON only:
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    const userPrompt = `
SOURCES:
${context || "(no sources matched)"}

USER QUESTION:
${qRaw}

Rules:
- If SOURCES contain the answer, mode="docs" and include up to 3 citations (title + section).
- If SOURCES do NOT contain the answer, mode="helper", citations must be [].
- Followups: include 0–2 short questions only if helpful.
Return JSON only.
`.trim();

    const content = await groqChat({ apiKey, system: SYSTEM, userPrompt });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { mode: "helper", answer: content, followups: [], citations: [] };
    }

    const mode = parsed?.mode === "docs" ? "docs" : "helper";

    const answer =
      typeof parsed?.answer === "string" && parsed.answer.trim()
        ? parsed.answer.trim()
        : "I can help—what are you trying to do in Gigaverse?";

    const followups = Array.isArray(parsed?.followups)
      ? parsed.followups.slice(0, 2).map((x) => String(x)).filter(Boolean)
      : [];

    let citations = Array.isArray(parsed?.citations) ? parsed.citations : [];
    if (mode === "helper") citations = [];

    // dedupe citations
    const seen = new Set();
    const unique = [];
    for (const c of citations) {
      const t = (c?.title || "").toString().trim();
      const s = (c?.section || "").toString().trim();
      if (!t) continue;
      const key = `${t}__${s}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ title: t, section: s });
    }

    return res.status(200).json({
      mode,
      answer,
      followups,
      citations: unique.slice(0, 3),
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "Server error",
      details: err?.details,
    });
  }
}
