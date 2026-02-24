// /api/chat.js — Gigaverse AI (Groq)
// Docs-first + Conversational + "What Next" mode
// + Lightweight memory (session-based) + Better retrieval + Confidence gating
//
// Expects POST:
// {
//   question: string,
//   chunks?: [{ title, section, text, url? }],
//   sessionId?: string,          // recommended from frontend localStorage
//   meta?: { level?: number, focus?: string, style?: string } // optional
// }
//
// Returns JSON:
// { mode, answer, followups, citations }

const rateLimitMap = new Map();

// -------------------- Rate Limiter --------------------
// 6 requests per rolling 60 seconds per IP.
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

// -------------------- Lightweight Memory --------------------
// Best-effort memory (works well on warm instances; not guaranteed on serverless).
// Stores only minimal gameplay preferences (no personal data).
const memoryMap = new Map();
/**
 * Memory schema:
 * key -> { updatedAt, data: { level?, focus?, mode?, lastTopic?, eventFocus?, tone? } }
 */
const MEMORY_TTL_MS = 1000 * 60 * 60 * 24 * 3; // 3 days
const MEMORY_MAX_KEYS = 8000;

function cleanupMemoryMap() {
  const now = Date.now();
  for (const [k, v] of memoryMap.entries()) {
    if (!v?.updatedAt || now - v.updatedAt > MEMORY_TTL_MS) memoryMap.delete(k);
  }
  if (memoryMap.size <= MEMORY_MAX_KEYS) return;
  // drop oldest entries
  const entries = Array.from(memoryMap.entries());
  entries.sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0));
  const toDelete = Math.max(0, entries.length - MEMORY_MAX_KEYS);
  for (let i = 0; i < toDelete; i++) memoryMap.delete(entries[i][0]);
}

function getMemory(key) {
  cleanupMemoryMap();
  const v = memoryMap.get(key);
  if (!v) return {};
  if (!v.updatedAt || Date.now() - v.updatedAt > MEMORY_TTL_MS) {
    memoryMap.delete(key);
    return {};
  }
  return v.data || {};
}

function setMemory(key, patch) {
  cleanupMemoryMap();
  const prev = memoryMap.get(key);
  const next = {
    updatedAt: Date.now(),
    data: { ...(prev?.data || {}), ...(patch || {}) },
  };
  memoryMap.set(key, next);
  return next.data;
}

// -------------------- Utils --------------------
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

// Detect very short greetings / small talk so we don’t answer “not in docs”
function isSmallTalk(q) {
  const t = normalize(q);
  if (!t) return true;

  const small = new Set([
    "hi",
    "hii",
    "hiii",
    "hello",
    "heyy",
    "hey",
    "yo",
    "sup",
    "wassup",
    "good morning",
    "good afternoon",
    "good evening",
    "how are you",
    "who are you",
    "what can you do",
    "help",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "k",
  ]);

  if (small.has(t)) return true;

  // short + no game keywords = likely small talk
  const gameHints = [
    "gigaverse",
    "dungeon",
    "dungetron",
    "craft",
    "crafting",
    "fish",
    "fishing",
    "egg",
    "eggs",
    "giggling",
    "giglings",
    "trade",
    "trading",
    "market",
    "gigamarket",
    "boss",
    "drop",
    "gear",
    "potion",
    "potions",
  ];
  const hasGameHint = gameHints.some((k) => t.includes(k));
  if (t.length <= 18 && !hasGameHint) return true;

  return false;
}

// Detect "what should I do next" style requests
function isWhatNext(q) {
  const t = normalize(q);
  const triggers = [
    "what should i do next",
    "what should i do",
    "what do i do next",
    "what should i focus on",
    "what should i focus on right now",
    "how do i progress",
    "how to progress",
    "how do i get better",
    "im new what should i do",
    "i am new what should i do",
    "where do i start",
    "how do i play",
    "how to play",
  ];
  return triggers.some((p) => t.includes(p));
}

// Simple extraction (optional) to auto-save memory if user says "im level 20 focused on dungeons"
function extractProfileHints(qRaw) {
  const t = normalize(qRaw);

  // level
  let level = null;
  const m = t.match(/\blevel\s+(\d{1,3})\b/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 999) level = n;
  }

  // focus
  let focus = null;
  const focusMap = [
    ["dungeon", "dungeons"],
    ["dungetron", "dungeons"],
    ["fish", "fishing"],
    ["fishing", "fishing"],
    ["craft", "crafting"],
    ["crafting", "crafting"],
    ["egg", "eggs"],
    ["eggs", "eggs"],
    ["giggling", "eggs"],
    ["giglings", "eggs"],
    ["trade", "trading"],
    ["trading", "trading"],
    ["market", "trading"],
    ["gigamarket", "trading"],
  ];
  for (const [k, v] of focusMap) {
    if (t.includes(k)) {
      focus = v;
      break;
    }
  }

  // event/dungeon focus
  let eventFocus = null;
  if (t.includes("event")) eventFocus = "event";
  if (t.includes("dungeon-focused") || t.includes("dungeon focused")) eventFocus = "dungeon";

  return { level, focus, eventFocus };
}

// -------------------- Retrieval upgrades --------------------
const SYNONYMS = {
  eggs: ["egg", "eggs", "giggling", "giglings", "hatch", "hatching", "incube", "incubes", "biofuel", "comfort", "temperature", "fate"],
  dungeons: ["dungeon", "dungeons", "dungetron", "boss", "floor", "room", "run", "echo", "combat"],
  fishing: ["fish", "fishing", "rod", "bait", "luck", "stamina", "cast", "seaweed"],
  crafting: ["craft", "crafting", "workbench", "alchemy", "potions", "potion", "ingredients", "station"],
  trading: ["trade", "trading", "market", "gigamarket", "order", "sell", "buy"],
};

function expandQueryTerms(qNorm) {
  const terms = new Set(qNorm.split(" ").filter((w) => w.length >= 3));
  // add synonyms if any seed present
  for (const group of Object.values(SYNONYMS)) {
    const hasSeed = group.some((w) => terms.has(w));
    if (hasSeed) group.forEach((w) => terms.add(w));
  }
  return Array.from(terms);
}

function scoreChunkFactory({ qNorm, qTerms }) {
  const intentWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best", "buy", "sell"];

  return function scoreChunk(chunk) {
    const title = normalize(chunk?.title || "");
    const section = normalize(chunk?.section || "");
    const text = normalize(chunk?.text || "");

    if (!text && !title && !section) return 0;

    let score = 0;

    // strong phrase boost (exact normalized question substring)
    if (qNorm && text.includes(qNorm)) score += 35;
    if (qNorm && title.includes(qNorm)) score += 30;
    if (qNorm && section.includes(qNorm)) score += 20;

    // term scoring (title/section heavy)
    for (const w of qTerms) {
      if (title.includes(w)) score += 7;
      if (section.includes(w)) score += 5;
      if (text.includes(w)) score += 1;
    }

    // intent boost
    for (const iw of intentWords) {
      if (!qNorm.includes(iw)) continue;
      if (title.includes(iw) || section.includes(iw)) score += 3;
      else if (text.includes(iw)) score += 1;
    }

    // penalize tiny chunks
    const len = (chunk?.text || "").length;
    if (len > 0 && len < 140) score -= 5;

    return score;
  };
}

// MMR-ish diversity: avoid picking 6 chunks from same title/section
function rerankAndPick(allChunks, scorer, k = 6, maxInput = 12) {
  const list = Array.isArray(allChunks) ? allChunks : [];
  const limited = list.slice(0, maxInput);

  const scored = limited
    .map((c) => ({
      title: String(c?.title || "Untitled"),
      section: String(c?.section || ""),
      url: String(c?.url || ""),
      text: clampText(String(c?.text || ""), 2400),
      _score: scorer(c),
    }))
    .sort((a, b) => b._score - a._score);

  // diversity selection
  const picked = [];
  const usedTitle = new Set();
  const usedTitleSection = new Set();

  for (const item of scored) {
    if (item._score <= 0) continue;

    const tKey = normalize(item.title);
    const tsKey = `${normalize(item.title)}__${normalize(item.section)}`;

    // allow duplicates if we still have too few, but prefer diversity first
    const tooSimilar = usedTitleSection.has(tsKey) || (usedTitle.has(tKey) && picked.length < k - 1);
    if (tooSimilar) continue;

    picked.push(item);
    usedTitle.add(tKey);
    usedTitleSection.add(tsKey);

    if (picked.length >= k) break;
  }

  // fallback fill if diversity filtered too hard
  if (picked.length < k) {
    for (const item of scored) {
      if (item._score <= 0) continue;
      if (picked.includes(item)) continue;
      picked.push(item);
      if (picked.length >= k) break;
    }
  }

  return picked.slice(0, k);
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

// Confidence gating: decide if docs are strong enough to answer as "docs"
function computeEvidence(picked) {
  if (!picked?.length) return { strong: false, score: 0 };

  const top = picked[0]?._score || 0;
  const sum = picked.reduce((acc, c) => acc + (c._score || 0), 0);

  // strong if top is decent and total is decent
  const strong = top >= 18 && sum >= 45;
  return { strong, score: Math.round(sum) };
}

// -------------------- Handler --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // ---- Rate Limiting (6/min per IP) ----
    const ip =
      (req.headers["x-forwarded-for"] || "")
        .toString()
        .split(",")[0]
        .trim() ||
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

    // --- identity for memory ---
    // Best: client sends sessionId (stable per browser).
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const memKey = sessionId ? `sid:${sessionId}` : `ip:${ip}`;

    // caps
    const QUESTION_MAX = 900;
    const CHUNKS_MAX = 12;
    const CHUNK_TEXT_MAX = 2400;

    const qRaw = question.slice(0, QUESTION_MAX);
    const qNorm = normalize(qRaw);

    // update memory from explicit meta or parsed hints
    const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
    const hints = extractProfileHints(qRaw);
    const prevMem = getMemory(memKey);

    const patch = {};
    if (typeof meta.level === "number" && meta.level > 0) patch.level = Math.floor(meta.level);
    if (typeof meta.focus === "string" && meta.focus.trim()) patch.focus = normalize(meta.focus.trim());
    if (typeof meta.style === "string" && meta.style.trim()) patch.tone = meta.style.trim();

    if (hints.level) patch.level = hints.level;
    if (hints.focus) patch.focus = hints.focus; // already normalized-ish values (eggs/dungeons/etc)
    if (hints.eventFocus) patch.eventFocus = hints.eventFocus;

    // track last topic lightly
    if (qNorm.includes("egg") || qNorm.includes("giggling") || qNorm.includes("hatch")) patch.lastTopic = "eggs";
    else if (qNorm.includes("fish")) patch.lastTopic = "fishing";
    else if (qNorm.includes("craft") || qNorm.includes("potion") || qNorm.includes("alchemy")) patch.lastTopic = "crafting";
    else if (qNorm.includes("trade") || qNorm.includes("market") || qNorm.includes("gigamarket")) patch.lastTopic = "trading";
    else if (qNorm.includes("dungeon") || qNorm.includes("dungetron") || qNorm.includes("boss")) patch.lastTopic = "dungeons";

    const mem = Object.keys(patch).length ? setMemory(memKey, patch) : prevMem;

    // -------------------- Small talk handling --------------------
    // IMPORTANT FIX: only treat as small talk if it’s ACTUALLY small talk.
    // "how do i play" should NOT be treated as small talk.
    const smallTalk = isSmallTalk(qRaw);
    const whatNext = isWhatNext(qRaw);

    if (smallTalk && !whatNext) {
      const answer =
        /who are you|what can you do/.test(qNorm)
          ? `Hey 👋 I’m **Gigaverse AI** — your in-game knowledge assistant.\n\nAsk me anything about **dungeons, fishing, crafting, eggs/gigglings, trading, drops, builds**, or **progression** and I’ll guide you (with sources when the docs cover it).`
          : /how are you/.test(qNorm)
          ? `Doing great 😄 Ready to help you in Gigaverse.\n\nWhat are you working on right now — **dungeons, fishing, crafting, eggs/gigglings, or trading**?`
          : `Hey 👋 What’s up?\n\nTell me what you’re trying to do in Gigaverse and I’ll point you in the right direction.`;

      return res.status(200).json({
        mode: "helper",
        answer,
        followups: [
          "What part of the game are you on right now?",
          "Do you want tips for dungeons, fishing, crafting, eggs/gigglings, or trading?",
        ],
        citations: [],
      });
    }

    // -------------------- Retrieval --------------------
    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];

    const qTerms = expandQueryTerms(qNorm);
    const scorer = scoreChunkFactory({ qNorm, qTerms });

    let picked = rerankAndPick(
      clientChunks.map((c) => ({
        ...c,
        text: clampText(String(c?.text || ""), CHUNK_TEXT_MAX),
      })),
      scorer,
      6,
      CHUNKS_MAX
    );

    if (picked.length === 0) {
      const docsIndex = await fetchDocsIndexFromSite(req);
      const capped = docsIndex.length > 7000 ? docsIndex.slice(0, 7000) : docsIndex;
      picked = rerankAndPick(
        capped.map((c) => ({
          ...c,
          text: clampText(String(c?.text || ""), CHUNK_TEXT_MAX),
        })),
        scorer,
        6,
        CHUNKS_MAX
      );
    }

    const evidence = computeEvidence(picked);

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

    // -------------------- System prompt --------------------
    // Memory is passed in as "PLAYER CONTEXT" so it stays natural.
    const SYSTEM = `
You are Gigaverse AI, the official AI assistant for the Gigaverse community.

Tone:
- Warm, confident, and human (like a helpful pro player).
- Short and clear. Avoid robotic refusal loops.
- No sarcasm, no roleplay.

Docs-first rules:
1) If SOURCES contain the answer, answer from SOURCES and cite them.
2) If SOURCES do not contain the answer, still be helpful with practical guidance, but say: “I don’t see this explicitly in the docs I have loaded.”
3) Never invent Gigaverse-specific mechanics not supported by SOURCES.

Confidence rules (VERY IMPORTANT):
- If the SOURCES are weak/unclear, do NOT pretend: switch to helper mode + ask 1 targeted question.
- If the user asks a broad beginner question (“how do I play / where do I start”), give a short starter plan even if docs are incomplete.

Communication rules:
- Start with a quick helpful summary.
- Then give steps / tips.
- If the question is vague, ask 1–2 targeted questions max (not generic “clarify”).
- If the user asks “what can you do / who are you”, explain your capabilities briefly + suggest next question.

"What Should I Do Next?" mode:
- If the user asks what to focus on / progress / what next:
  Ask up to 3 short questions:
  (1) level, (2) focus area (Fishing/Crafting/Eggs/Dungeons/Trading), (3) event-focused or dungeon-focused.
  If the user already provided these, do NOT ask again—give a plan.

Output JSON only:
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    // memory context (only if we have something meaningful)
    const playerContextLines = [];
    if (mem?.level) playerContextLines.push(`- level: ${mem.level}`);
    if (mem?.focus) playerContextLines.push(`- focus: ${mem.focus}`);
    if (mem?.eventFocus) playerContextLines.push(`- focus_type: ${mem.eventFocus}`);
    if (mem?.lastTopic) playerContextLines.push(`- last_topic: ${mem.lastTopic}`);
    const PLAYER_CONTEXT = playerContextLines.length
      ? `PLAYER CONTEXT (from this user’s previous messages):\n${playerContextLines.join("\n")}\n`
      : `PLAYER CONTEXT: (none)\n`;

    // what-next hint
    const whatNextHint = whatNext
      ? `NOTE: This is a "what next" / progression request. Use the "What Should I Do Next?" behavior.\n`
      : "";

    // confidence hint (soft)
    const confidenceHint = evidence.strong
      ? `RETRIEVAL CONFIDENCE: strong\n`
      : `RETRIEVAL CONFIDENCE: weak (do not overclaim; helper mode is allowed)\n`;

    const userPrompt = `
${PLAYER_CONTEXT}
${confidenceHint}
${whatNextHint}

SOURCES:
${context || "(no sources matched)"}

USER QUESTION:
${qRaw}

Rules:
- If SOURCES contain the answer AND confidence is strong, mode="docs" and include up to 3 citations (title + section).
- If SOURCES do NOT contain the answer OR confidence is weak, mode="helper" and citations must be [].
- Followups: include 0–2 questions only, unless it's "what next" mode (then up to 3).
Return JSON only.
`.trim();

    // -------------------- Groq call --------------------
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0.25,
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

    // -------------------- Post-guardrails --------------------
    // If evidence was weak, force helper mode + no citations.
    let mode = parsed?.mode === "docs" ? "docs" : "helper";
    if (!evidence.strong) mode = "helper";

    const answer =
      typeof parsed?.answer === "string" && parsed.answer.trim()
        ? parsed.answer.trim()
        : "I’ve got you — what are you trying to do in Gigaverse right now?";

    const followups = Array.isArray(parsed?.followups)
      ? parsed.followups.slice(0, whatNext ? 3 : 2).map((x) => String(x)).filter(Boolean)
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

    // Optional: if user asked a beginner question, keep it natural even in helper mode.
    // (No "not in docs" spam.)
    return res.status(200).json({
      mode,
      answer,
      followups,
      citations: unique.slice(0, 3),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
