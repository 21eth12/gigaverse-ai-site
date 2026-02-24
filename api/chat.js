// /api/chat.js — Gigaverse AI (Groq) — Docs-first + Conversational + "What Next" mode
// Expects POST { question: string, chunks?: [{title, section, text, url?}], sessionId?: string }
// Returns JSON: { mode, answer, followups, citations }

// -------------------- In-Memory Rate Limiter --------------------
// 6 requests per rolling 60 seconds per IP.
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

// -------------------- In-Memory Session "Memory" + Session Cap --------------------
// ⚠️ This is best-effort memory per Vercel instance (can reset if instance changes).
const sessionStore = new Map();

// Tune these:
const MAX_SESSIONS = 2000; // ✅ session cap you requested
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // optional: expire sessions after 12h

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
  // No imports: safe in serverless + works everywhere
  return (
    "sid_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

function getSessionId(req, body, ip) {
  // Priority:
  // 1) body.sessionId (if your frontend sends it)
  // 2) cookie giga_sid
  // 3) fallback: create one and set cookie in response
  const fromBody = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (fromBody) return { sid: fromBody, shouldSetCookie: false };

  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = typeof cookies.giga_sid === "string" ? cookies.giga_sid.trim() : "";
  if (fromCookie) return { sid: fromCookie, shouldSetCookie: false };

  // fallback: create new
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 80);
  const sid = makeId() + "_" + (ip || "ip") + "_" + ua.replace(/\s+/g, "_").slice(0, 30);
  return { sid, shouldSetCookie: true };
}

function setSessionCookie(res, sid) {
  // Lax cookie so it works in normal in-site requests
  // If your site is https, this will still work; "Secure" is recommended in production.
  const cookie = `giga_sid=${encodeURIComponent(sid)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  res.setHeader("Set-Cookie", cookie);
}

function getSession(sid) {
  const now = Date.now();

  // TTL cleanup for this session id
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
    // store whatever you want here
    profile: {
      level: "",
      focus: "", // Fishing / Crafting / Eggs / Dungeons / Trading
      track: "", // event-focused / dungeon-focused
    },
    lastTopic: "",
  };

  sessionStore.set(sid, { data, updatedAt: now });
  enforceSessionCap(MAX_SESSIONS);
  return data;
}

function enforceSessionCap(maxSessions = 2000) {
  if (sessionStore.size <= maxSessions) return;

  // Evict least-recently-updated sessions
  const entries = Array.from(sessionStore.entries());
  entries.sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0));

  const toDelete = sessionStore.size - maxSessions;
  for (let i = 0; i < toDelete; i++) {
    sessionStore.delete(entries[i][0]);
  }
}

// Optional periodic-ish cleanup (best effort)
function cleanupSessions(maxSessions = 2000) {
  const now = Date.now();

  // TTL purge first
  for (const [sid, obj] of sessionStore.entries()) {
    if (now - (obj?.updatedAt ?? 0) > SESSION_TTL_MS) sessionStore.delete(sid);
  }

  // Then enforce cap
  enforceSessionCap(maxSessions);
}

// -------------------- Text Utilities --------------------
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

// Detect very short greetings / small talk
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

  const gameHints = ["gigaverse", "dungeon", "craft", "fishing", "egg", "gigglings", "trade", "market", "boss", "drop", "gear"];
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
    "what now",
    "what next",
  ];
  return triggers.some((p) => t.includes(p));
}

// Very lightweight extraction for memory (no hard dependency)
function tryExtractProfileAnswer(raw) {
  const t = normalize(raw);

  // Level: "level 12", "lvl 12", "im 12", etc.
  let level = "";
  const m = t.match(/\b(level|lvl)\s*(\d{1,3})\b/);
  if (m && m[2]) level = m[2];

  // Focus area keywords
  let focus = "";
  if (t.includes("fish")) focus = "Fishing";
  else if (t.includes("craft")) focus = "Crafting";
  else if (t.includes("egg") || t.includes("giggling")) focus = "Eggs/Gigglings";
  else if (t.includes("dungeon") || t.includes("boss")) focus = "Dungeons";
  else if (t.includes("trade") || t.includes("market")) focus = "Trading";

  // Track
  let track = "";
  if (t.includes("event")) track = "Event-focused";
  if (t.includes("dungeon")) {
    // if they explicitly say "dungeon-focused"
    if (t.includes("focused") || t.includes("focus")) track = "Dungeon-focused";
  }

  return { level, focus, track };
}

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

    // ---- Rate Limiting ----
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

    // ---- Session Memory (with cap) ----
    const { sid, shouldSetCookie } = getSessionId(req, body, ip);
    if (shouldSetCookie) setSessionCookie(res, sid);

    // Best-effort cleanup
    cleanupSessions(MAX_SESSIONS);

    const session = getSession(sid);

    // Caps
    const QUESTION_MAX = 900;
    const CHUNKS_MAX = 12;
    const CHUNK_TEXT_MAX = 2400;

    const qRaw = question.slice(0, QUESTION_MAX);
    const q = normalize(qRaw);
    const qWords = q.split(" ").filter((w) => w.length >= 3);

    // Update memory from user reply (harmless even if not used)
    const extracted = tryExtractProfileAnswer(qRaw);
    if (extracted.level && !session.profile.level) session.profile.level = extracted.level;
    if (extracted.focus && !session.profile.focus) session.profile.focus = extracted.focus;
    if (extracted.track && !session.profile.track) session.profile.track = extracted.track;

    // Small talk response
    if (isSmallTalk(qRaw)) {
      const answer =
        /who are you|what can you do/.test(q)
          ? `Hey 👋 I’m **Gigaverse AI** — your in-game knowledge assistant.\n\nAsk me anything about **dungeons, fishing, crafting, eggs/gigglings, trading, drops, builds**, or **progression** and I’ll guide you (with sources when the docs cover it).`
          : /how are you/.test(q)
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

    // If this is a "What Next" request, use memory to reduce repeated questions
    const whatNext = isWhatNext(qRaw);
    if (whatNext) {
      const missing = [];
      if (!session.profile.level) missing.push("What level are you?");
      if (!session.profile.focus) missing.push("Which system are you focusing on right now (Fishing / Crafting / Eggs / Dungeons / Trading)?");
      if (!session.profile.track) missing.push("Are you more event-focused or dungeon-focused right now?");

      // If still missing info, ask for it (max 3)
      if (missing.length) {
        return res.status(200).json({
          mode: "helper",
          answer: `Got you 🤝 I can give you a clean “what next” plan — quick check:`,
          followups: missing.slice(0, 3),
          citations: [],
        });
      }
      // otherwise let the model answer normally but with the profile attached below
    }

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

    // Client chunks rerank
    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];
    let picked = rerankAndPick(clientChunks, 6);

    // Fallback to docs_index.json
    if (picked.length === 0) {
      const docsIndex = await fetchDocsIndexFromSite();
      const capped = docsIndex.length > 7000 ? docsIndex.slice(0, 7000) : docsIndex;
      picked = rerankAndPick(capped, 6);
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
- Warm, confident, and human (like a helpful pro player).
- Short and clear. No robotic refusal loops.
- No sarcasm, no roleplay.

Docs-first rules:
1) If SOURCES contain the answer, answer from SOURCES and cite them.
2) If SOURCES do not contain the answer, still be helpful with practical guidance, but say: “I don’t see this explicitly in the docs I have loaded.”
3) Never invent Gigaverse-specific mechanics not supported by SOURCES.

Communication rules:
- Start with a quick helpful summary.
- Then give steps / tips.
- If the question is vague, ask 1–2 targeted questions max.

"What Should I Do Next?" mode:
- If the user asks what to focus on / progress / what next:
  Ask up to 3 short questions (level, focus area, event vs dungeon) ONLY if missing.
  If user already provided these, give a plan.

Output JSON only:
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    const whatNextHint = whatNext
      ? `\nNOTE: This is a "what next" request. User profile (if available): level="${session.profile.level}", focus="${session.profile.focus}", track="${session.profile.track}". Use it and avoid re-asking.\n`
      : "";

    const userPrompt = `
SOURCES:
${context || "(no sources matched)"}

USER QUESTION:
${qRaw}
${whatNextHint}

Rules:
- If SOURCES contain the answer, mode="docs" and include up to 3 citations (title + section).
- If SOURCES do NOT contain the answer, mode="helper", citations must be [].
- Followups: include 0–2 questions only, unless it's "what next" mode (then up to 3).
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

    // Update session last topic (tiny personalization hook)
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
