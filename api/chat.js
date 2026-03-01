// /api/chat.js — Gigaverse AI (Groq 70B)
// Docs-first + Conversational + "What Next" mode + Session cap
// Expects POST { question: string, chunks?: [{title, section, text, url?}], sessionId?: string }
// Returns JSON: { mode, answer, followups, citations }

const rateLimitMap = new Map();

// -------------------- Rate Limit: 6 per rolling 60 seconds per IP --------------------
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

// -------------------- Session memory + cap (best-effort in-memory) --------------------
const sessionStore = new Map();
const MAX_SESSIONS = 2000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function parseCookies(cookieHeader) {
  const out = {};
  const raw = typeof cookieHeader === "string" ? cookieHeader : "";
  raw.split(";").forEach((part) => {
    const p = part.trim();
    if (!p) return;
    const eq = p.indexOf("=");
    if (eq === -1) return;
    const k = decodeURIComponent(p.slice(0, eq).trim());
    const v = decodeURIComponent(p.slice(eq + 1).trim());
    out[k] = v;
  });
  return out;
}

function makeId() {
  return (
    "sid_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

function getSessionId(req, body, ip) {
  const fromBody = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (fromBody) return { sid: fromBody, shouldSetCookie: false };

  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = typeof cookies.giga_sid === "string" ? cookies.giga_sid.trim() : "";
  if (fromCookie) return { sid: fromCookie, shouldSetCookie: false };

  const ua = (req.headers["user-agent"] || "").toString().slice(0, 80);
  const sid = makeId() + "_" + (ip || "ip") + "_" + ua.replace(/\s+/g, "_").slice(0, 30);
  return { sid, shouldSetCookie: true };
}

function setSessionCookie(res, sid) {
  const cookie = `giga_sid=${encodeURIComponent(sid)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  res.setHeader("Set-Cookie", cookie);
}

function enforceSessionCap(maxSessions = 2000) {
  if (sessionStore.size <= maxSessions) return;
  const entries = Array.from(sessionStore.entries());
  entries.sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0));
  const toDelete = sessionStore.size - maxSessions;
  for (let i = 0; i < toDelete; i++) sessionStore.delete(entries[i][0]);
}

function cleanupSessions(maxSessions = 2000) {
  const now = Date.now();
  for (const [sid, obj] of sessionStore.entries()) {
    if (now - (obj?.updatedAt ?? 0) > SESSION_TTL_MS) sessionStore.delete(sid);
  }
  enforceSessionCap(maxSessions);
}

function getSession(sid) {
  const now = Date.now();
  const existing = sessionStore.get(sid);

  if (existing && now - (existing.updatedAt || 0) > SESSION_TTL_MS) {
    sessionStore.delete(sid);
  }

  const s = sessionStore.get(sid);
  if (s) {
    s.updatedAt = now;
    return s.data;
  }

  const data = {
    profile: { level: "", focus: "", track: "" },
    lastTopic: "",
  };

  sessionStore.set(sid, { data, updatedAt: now });
  enforceSessionCap(MAX_SESSIONS);
  return data;
}

// -------------------- Text helpers --------------------
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
  ]);

  if (small.has(t)) return true;

  const gameHints = ["gigaverse", "dungeon", "craft", "fishing", "egg", "giggling", "trade", "market", "boss", "drop", "gear"];
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
    "what now",
    "what next",
    "how do i play",
  ];
  return triggers.some((p) => t.includes(p));
}

function tryExtractProfileAnswer(raw) {
  const t = normalize(raw);

  let level = "";
  const m = t.match(/\b(level|lvl)\s*(\d{1,3})\b/);
  if (m && m[2]) level = m[2];

  let focus = "";
  if (t.includes("fish")) focus = "Fishing";
  else if (t.includes("craft")) focus = "Crafting";
  else if (t.includes("egg") || t.includes("giggling")) focus = "Eggs/Gigglings";
  else if (t.includes("dungeon") || t.includes("boss")) focus = "Dungeons";
  else if (t.includes("trade") || t.includes("market")) focus = "Trading";

  let track = "";
  if (t.includes("event")) track = "Event-focused";
  if (t.includes("dungeon") && (t.includes("focused") || t.includes("focus"))) track = "Dungeon-focused";

  return { level, focus, track };
}

function requiredTopicFromQuestion(qRaw) {
  const t = normalize(qRaw);

  const topics = [
    { key: "fishing", must: ["fishing"] },
    { key: "crafting", must: ["craft", "crafting", "alchemy", "potion"] },
    { key: "eggs", must: ["egg", "eggs", "giggling", "gigglings", "hatch", "hatching"] },
    { key: "dungeons", must: ["dungeon", "boss", "underhaul", "dungetron"] },
    { key: "trading", must: ["trade", "market", "gigamarket", "order book"] },
  ];

  for (const topic of topics) {
    if (topic.must.some((m) => t.includes(m))) return topic;
  }
  return null;
}

// -------------------- Main handler --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const ip =
      (req.headers["x-forwarded-for"] || "")
        .toString()
        .split(",")[0]
        .trim() ||
      (req.socket?.remoteAddress || "").toString() ||
      "unknown";

    // Rate limit
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

    // Session
    const { sid, shouldSetCookie } = getSessionId(req, body, ip);
    if (shouldSetCookie) setSessionCookie(res, sid);
    cleanupSessions(MAX_SESSIONS);
    const session = getSession(sid);

    // Caps
    const QUESTION_MAX = 900;
    const CHUNKS_MAX = 12;
    const CHUNK_TEXT_MAX = 2400;

    const qRaw = question.slice(0, QUESTION_MAX);
    const q = normalize(qRaw);
    const qWords = q.split(" ").filter((w) => w.length >= 3);

    // Memory extraction
    const extracted = tryExtractProfileAnswer(qRaw);
    if (extracted.level && !session.profile.level) session.profile.level = extracted.level;
    if (extracted.focus && !session.profile.focus) session.profile.focus = extracted.focus;
    if (extracted.track && !session.profile.track) session.profile.track = extracted.track;

    // Small talk
    if (isSmallTalk(qRaw) && !isWhatNext(qRaw)) {
      const answer =
        /who are you|what can you do/.test(q)
          ? `Hey 👋 I’m **Gigaverse AI** — your in-game knowledge assistant.\n\nAsk me anything about **dungeons, fishing, crafting, eggs/gigglings, trading, drops, builds**, or **progression** and I’ll guide you.`
          : /how are you/.test(q)
          ? `Doing great 😄 Ready when you are.\n\nWhat are you working on right now — **dungeons, fishing, crafting, eggs/gigglings, or trading**?`
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

    // What-next quick gate
    const whatNext = isWhatNext(qRaw);
    if (whatNext) {
      const missing = [];
      if (!session.profile.level) missing.push("What level are you?");
      if (!session.profile.focus) missing.push("Which system are you focusing on (Fishing / Crafting / Eggs / Dungeons / Trading)?");
      if (!session.profile.track) missing.push("Are you more event-focused or dungeon-focused right now?");
      if (missing.length) {
        return res.status(200).json({
          mode: "helper",
          answer: `Got you 🤝 I can give you a clean “what next” plan — quick check:`,
          followups: missing.slice(0, 3),
          citations: [],
        });
      }
    }

    const intentWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best", "play", "start"];

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

    function rerankAndPick(allChunks, k = 6) {
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

      return scored.filter((x) => x._score > 0).slice(0, k);
    }

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

    // 1) Pick from client chunks
    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];
    let picked = rerankAndPick(clientChunks, 6);

    const topScore = picked?.[0]?._score ?? 0;
    const MIN_TOP_SCORE = 10;

    const topic = requiredTopicFromQuestion(qRaw);
    const pickedTextBlob = picked.map((c) => normalize(`${c.title} ${c.section} ${c.text}`)).join(" ");
    const hasTopicInPicked = topic ? topic.must.some((m) => pickedTextBlob.includes(m)) : true;

    const shouldFallback = picked.length === 0 || topScore < MIN_TOP_SCORE || !hasTopicInPicked;

    if (shouldFallback) {
      const docsIndex = await fetchDocsIndexFromSite();
      const capped = docsIndex.length > 7000 ? docsIndex.slice(0, 7000) : docsIndex;
      const reranked = rerankAndPick(capped, 6);
      if (reranked.length) picked = reranked;
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
- Warm, confident, human, like a helpful pro player.
- Clear and helpful. No robotic loops.
- No sarcasm, no roleplay.

Rules:
1) Use SOURCES as truth. If SOURCES contain the answer, answer using them and cite them.
2) If SOURCES do not contain the answer, do NOT guess and do NOT deny the feature.
   Say: “I don’t see this in the sources I’m looking at.” Then give safe, practical next steps + 1–2 targeted questions.
3) Never mention internal tooling, training rules, chunks, retrieval, or implementation.

Behavior:
- Start with a quick helpful answer.
- Then give short steps/tips when useful.
- For beginner questions like “how do I play” or “where do I start”, give a simple starter path.
- For “what should I do next” requests, use the user's known profile if available and avoid re-asking known info.

Output JSON only:
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    const whatNextHint = whatNext
      ? `\nNOTE: "what next" request. User profile if available: level="${session.profile.level}", focus="${session.profile.focus}", track="${session.profile.track}". Use it and avoid re-asking.\n`
      : "";

    const userPrompt = `
SOURCES:
${context || "(no sources matched)"}

USER QUESTION:
${qRaw}
${whatNextHint}

Rules:
- If SOURCES contain the answer, mode="docs" and include up to 3 citations (title + section).
- If SOURCES do NOT contain the answer, mode="helper" and citations must be [].
- Followups: include 0–2 questions only (or up to 3 for "what next").
Return JSON only.
`.trim();

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
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

    session.lastTopic = whatNext ? "what-next" : q.slice(0, 80);

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
