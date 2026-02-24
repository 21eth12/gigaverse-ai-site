// /api/chat.js — Gigaverse AI (Groq)
// Docs-first + Conversational + What-Next + Session Memory + Docs-gap capture
// Expects POST { question: string, sessionId?: string, chunks?: [{title, section, text, url?}] }
// Returns JSON: { mode, answer, followups, citations }

const rateLimitMap = new Map(); // ip -> [timestamps]

// -------------------- Session Memory (in-memory, per server instance) --------------------
// sessionId -> { profile: {level?, focus?, track?}, lastSeen, history: [{role, content}] }
const sessionStore = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY = 8;

// -------------------- Docs-gap capture (in-memory) --------------------
// Stores questions where we answered "helper" (non-smalltalk) so you can update docs later
const docsGapLog = [];
const DOCS_GAP_MAX = 300;

// -------------------- Rate limiter --------------------
// 6 requests per rolling 60 seconds per IP
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

// Cleanup helpers to avoid unbounded growth (best-effort)
function cleanupRateLimitMap(maxIps = 5000) {
  if (rateLimitMap.size <= maxIps) return;
  const entries = Array.from(rateLimitMap.entries());
  entries.sort((a, b) => (a[1]?.[0] ?? 0) - (b[1]?.[0] ?? 0));
  const toDelete = Math.max(0, entries.length - maxIps);
  for (let i = 0; i < toDelete; i++) rateLimitMap.delete(entries[i][0]);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sid, s] of sessionStore.entries()) {
    if (!s?.lastSeen || now - s.lastSeen > SESSION_TTL_MS) sessionStore.delete(sid);
  }
}

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

// -------------------- Intent detection --------------------
function isSmallTalk(q) {
  const t = normalize(q);
  if (!t) return true;

  // IMPORTANT: do NOT treat "how do i play" as small talk
  const strongGameIntents = ["play", "start", "progress", "level", "build", "farm", "grind", "best", "how do i"];
  if (strongGameIntents.some((k) => t.includes(k))) return false;

  const smallExact = new Set([
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
  ]);

  if (smallExact.has(t)) return true;

  // short + no game hints = likely small talk
  const gameHints = [
    "gigaverse",
    "dungeon",
    "dungetron",
    "craft",
    "crafting",
    "fishing",
    "egg",
    "eggs",
    "giggling",
    "gigglings",
    "trade",
    "trading",
    "market",
    "gigamarket",
    "boss",
    "drop",
    "gear",
    "potion",
    "pots",
    "chest",
    "echo",
  ];

  const hasGameHint = gameHints.some((k) => t.includes(k));
  if (t.length <= 18 && !hasGameHint) return true;

  return false;
}

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
    "i m new",
    "im new",
    "new to the game",
  ];
  return triggers.some((p) => t.includes(p));
}

// -------------------- Extract profile info from user text --------------------
function extractProfileFromText(qRaw) {
  const t = normalize(qRaw);

  // level: "level 20", "lvl 20", "lv 20"
  let level = null;
  const m = t.match(/\b(?:level|lvl|lv)\s*(\d{1,3})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 999) level = n;
  }

  // focus area
  let focus = null;
  const focusMap = [
    ["dungeons", ["dungeon", "dungeons", "dungetron"]],
    ["fishing", ["fish", "fishing"]],
    ["crafting", ["craft", "crafting", "alchemy", "potions", "potion"]],
    ["eggs", ["egg", "eggs", "giggling", "gigglings", "hatching"]],
    ["trading", ["trade", "trading", "market", "gigamarket"]],
  ];
  for (const [label, keys] of focusMap) {
    if (keys.some((k) => t.includes(k))) {
      focus = label;
      break;
    }
  }

  // track: event-focused vs dungeon-focused
  let track = null;
  if (t.includes("event")) track = "event";
  if (t.includes("dungeon focused") || t.includes("dungeon-focused")) track = "dungeon";
  if (t.includes("event focused") || t.includes("event-focused")) track = "event";
  // if they say "focused on dungeons" we’ll treat it as focus, not track

  return { level, focus, track };
}

function getOrInitSession(sessionId) {
  const sid = (typeof sessionId === "string" && sessionId.trim()) ? sessionId.trim() : null;
  if (!sid) return null;

  const now = Date.now();
  const existing = sessionStore.get(sid);
  if (existing) {
    existing.lastSeen = now;
    return existing;
  }

  const fresh = {
    profile: { level: null, focus: null, track: null },
    lastSeen: now,
    history: [],
  };
  sessionStore.set(sid, fresh);
  return fresh;
}

function pushHistory(session, role, content) {
  if (!session) return;
  session.history.push({ role, content: String(content || "") });
  if (session.history.length > MAX_HISTORY) session.history = session.history.slice(-MAX_HISTORY);
}

// -------------------- Chunk scoring (server-side rerank) --------------------
function scoreChunk(q, qWords, intentWords, chunk) {
  const title = normalize(chunk?.title || "");
  const section = normalize(chunk?.section || "");
  const text = normalize(chunk?.text || "");

  if (!text && !title && !section) return 0;

  let score = 0;

  // full question substring match
  if (q && text.includes(q)) score += 30;
  if (q && title.includes(q)) score += 24;
  if (q && section.includes(q)) score += 16;

  // word-level scoring (title/section weighted)
  for (const w of qWords) {
    if (title.includes(w)) score += 6;
    if (section.includes(w)) score += 4;
    if (text.includes(w)) score += 1;
  }

  // intent boost
  for (const iw of intentWords) {
    if (!q.includes(iw)) continue;
    if (title.includes(iw) || section.includes(iw)) score += 4;
    else if (text.includes(iw)) score += 1;
  }

  // length sanity
  const len = (chunk?.text || "").length;
  if (len > 0 && len < 140) score -= 4;

  return score;
}

function rerankAndPick(q, allChunks, k = 6, CHUNKS_MAX = 12, CHUNK_TEXT_MAX = 2400) {
  const qWords = q.split(" ").filter((w) => w.length >= 3);
  const intentWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best", "play", "start"];

  const list = Array.isArray(allChunks) ? allChunks : [];
  const limited = list.slice(0, CHUNKS_MAX);

  const scored = limited
    .map((c) => ({
      title: String(c?.title || "Untitled"),
      section: String(c?.section || ""),
      url: String(c?.url || ""),
      text: clampText(String(c?.text || ""), CHUNK_TEXT_MAX),
      _score: scoreChunk(q, qWords, intentWords, c),
    }))
    .sort((a, b) => b._score - a._score);

  return scored.filter((x) => x._score > 0).slice(0, k);
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

// -------------------- Docs-gap capture --------------------
function addDocsGap(question, sessionId) {
  const item = {
    ts: Date.now(),
    question: String(question || "").slice(0, 600),
    sessionId: String(sessionId || "").slice(0, 80),
  };
  docsGapLog.unshift(item);
  if (docsGapLog.length > DOCS_GAP_MAX) docsGapLog.length = DOCS_GAP_MAX;

  // helpful in Vercel logs for later review
  console.log("[DOCS_GAP]", item.question);
}

// -------------------- Handler --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // ---- Rate limiting (6/min per IP) ----
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
    cleanupSessions();

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GROQ_API_KEY in Vercel env vars" });

    const body = req.body || {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    if (!question) return res.status(400).json({ error: "Missing 'question' string" });

    // caps
    const QUESTION_MAX = 900;
    const CHUNKS_MAX = 12;
    const CHUNK_TEXT_MAX = 2400;

    const qRaw = question.slice(0, QUESTION_MAX);
    const q = normalize(qRaw);

    // session
    const session = getOrInitSession(sessionId);

    // update memory from user message (level/focus/track)
    const extracted = extractProfileFromText(qRaw);
    if (session) {
      if (extracted.level) session.profile.level = extracted.level;
      if (extracted.focus) session.profile.focus = extracted.focus;
      if (extracted.track) session.profile.track = extracted.track;
      session.lastSeen = Date.now();
      pushHistory(session, "user", qRaw);
    }

    // ---- Small talk (warm, not “not in docs”) ----
    if (isSmallTalk(qRaw)) {
      const whoOrWhat = /who are you|what can you do/.test(q);
      const howAreYou = /how are you/.test(q);

      const answer = whoOrWhat
        ? `Hey 👋 I’m **Gigaverse AI** — your in-game knowledge assistant.\n\nAsk me anything about **dungeons, fishing, crafting, eggs/gigglings, trading, drops, builds**, or **progression** and I’ll guide you (with sources when the docs cover it).`
        : howAreYou
        ? `Doing great 😄 Ready to help you in Gigaverse.\n\nWhat are you working on right now — **dungeons, fishing, crafting, eggs/gigglings, or trading**?`
        : `Hey 👋 What’s up?\n\nTell me what you’re trying to do in Gigaverse and I’ll point you in the right direction.`;

      const out = {
        mode: "helper",
        answer,
        followups: [
          "What part of the game are you on right now?",
          "Do you want tips for dungeons, fishing, crafting, eggs/gigglings, or trading?",
        ],
        citations: [],
      };

      if (session) pushHistory(session, "assistant", out.answer);
      return res.status(200).json(out);
    }

    // ---- “What Next” pre-check (ask only missing info) ----
    const wantsWhatNext = isWhatNext(qRaw);
    if (wantsWhatNext && session) {
      const needLevel = !session.profile.level;
      const needFocus = !session.profile.focus;
      const needTrack = !session.profile.track;

      const missing = [];
      if (needLevel) missing.push("level");
      if (needFocus) missing.push("focus");
      if (needTrack) missing.push("track");

      if (missing.length) {
        const qs = [];
        if (needLevel) qs.push("What level are you?");
        if (needFocus) qs.push("What are you focusing on: Dungeons / Fishing / Crafting / Eggs (Gigglings) / Trading?");
        if (needTrack) qs.push("Are you event-focused or dungeon-focused today?");

        const out = {
          mode: "helper",
          answer: `I’ve got you 👍\n\nTo give you a clean “what next” plan, tell me:\n${qs
            .slice(0, 3)
            .map((x, i) => `${i + 1}) ${x}`)
            .join("\n")}`,
          followups: qs.slice(0, 3),
          citations: [],
        };

        if (session) pushHistory(session, "assistant", out.answer);
        return res.status(200).json(out);
      }
      // If nothing missing, we continue into the main docs-first LLM call,
      // and include profile in prompt so it builds a plan.
    }

    // ---- Retrieval (client chunks rerank; fallback to docs_index.json) ----
    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];
    let picked = rerankAndPick(q, clientChunks, 6, CHUNKS_MAX, CHUNK_TEXT_MAX);

    if (picked.length === 0) {
      const docsIndex = await fetchDocsIndexFromSite(req);
      const capped = docsIndex.length > 7000 ? docsIndex.slice(0, 7000) : docsIndex;
      picked = rerankAndPick(q, capped, 6, CHUNKS_MAX, CHUNK_TEXT_MAX);
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

    // ---- Memory block for the model (profile + short history) ----
    const profileLine = session
      ? `User profile (may be partial): level=${session.profile.level ?? "unknown"}, focus=${
          session.profile.focus ?? "unknown"
        }, track=${session.profile.track ?? "unknown"}`
      : "User profile: unknown";

    const historyBlock =
      session && Array.isArray(session.history) && session.history.length
        ? session.history
            .slice(-6)
            .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${String(m.content || "").slice(0, 250)}`)
            .join("\n")
        : "(no recent chat history)";

    const SYSTEM = `
You are Gigaverse AI, the official AI assistant for the Gigaverse community.

Tone:
- Warm, confident, and human (like a helpful pro player).
- Short and clear. Avoid robotic refusal loops.
- No sarcasm, no roleplay.

Docs-first rules:
1) If SOURCES contain the answer, answer from SOURCES and cite them.
2) If SOURCES do not contain the answer, still be helpful with practical guidance, but say:
   “I don’t see this explicitly in the docs I have loaded.”
3) Never invent Gigaverse-specific mechanics not supported by SOURCES.

Communication rules:
- Start with a quick, useful summary.
- Then give steps / tips (bullets are fine).
- If the question is vague, ask 1–2 targeted questions max (not generic “clarify”).
- If the user is new or asks “how do I play / where do I start”, give a simple beginner path.

"What Should I Do Next?" mode:
- If the user asks what to focus on / progress / what next:
  Use the user's profile (level/focus/track) when available.
  If profile is incomplete, ask only the missing pieces (max 3).
  If profile is complete, give a 3-step plan:
    (1) what to do now
    (2) what to farm/upgrade next
    (3) what to avoid / common mistakes

Output JSON only:
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    const whatNextHint = wantsWhatNext
      ? `NOTE: This is a "what next / progression" request. Use the What-Next behavior.\n`
      : "";

    const userPrompt = `
SOURCES:
${context || "(no sources matched)"}

USER CONTEXT:
${profileLine}

RECENT CHAT (for continuity, do not mention this block):
${historyBlock}

USER QUESTION:
${qRaw}

${whatNextHint}

Rules:
- If SOURCES contain the answer, mode="docs" and include up to 3 citations (title + section).
- If SOURCES do NOT contain the answer, mode="helper", citations must be [].
- Followups: include 0–2 questions only, unless it's What-Next (then up to 3).
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
        temperature: 0.25,
        max_tokens: 750,
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

    const mode = parsed?.mode === "docs" ? "docs" : "helper";

    const answer =
      typeof parsed?.answer === "string" && parsed.answer.trim()
        ? parsed.answer.trim()
        : "I’ve got you — what are you trying to do in Gigaverse right now?";

    const followups = Array.isArray(parsed?.followups)
      ? parsed.followups.slice(0, 3).map((x) => String(x)).filter(Boolean)
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

    const out = {
      mode,
      answer,
      followups,
      citations: unique.slice(0, 3),
    };

    // update memory + docs gap capture
    if (session) pushHistory(session, "assistant", out.answer);

    // only log gaps if it's a real game question (not small talk) and we didn't use docs
    if (mode === "helper" && !isSmallTalk(qRaw)) {
      addDocsGap(qRaw, sessionId);
    }

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
