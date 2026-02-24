// /api/chat.js — Gigaverse AI (Groq)
// Docs-first + Conversational + "What Next" mode + 6/min/IP rate limit
// Expects POST { question: string, chunks?: [{title, section, text, url?}] }
// Returns JSON: { mode, answer, followups, citations }

// -------------------- Simple In-Memory Rate Limiter --------------------
const rateLimitMap = new Map();

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

// -------------------- Helpers --------------------
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

function getIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "")
      .toString()
      .split(",")[0]
      .trim() ||
    (req.socket?.remoteAddress || "").toString() ||
    "unknown"
  );
}

function containsAny(hay, arr) {
  return arr.some((k) => hay.includes(k));
}

// Detect very short greetings / acknowledgements so we don’t answer “not in docs”
function classifyChitChat(qRaw) {
  const t = normalize(qRaw);
  if (!t) return "empty";

  // If it contains real game-intent verbs, DO NOT treat as small talk
  const strongIntent = [
    "how do i play",
    "how to play",
    "how do i start",
    "where do i start",
    "how do i progress",
    "how to progress",
    "what should i do",
    "what should i do next",
    "what should i focus on",
    "how do i get",
    "how do i craft",
    "how do i fish",
    "how do i hatch",
    "how do i trade",
    "how do i level",
    "build",
    "guide",
    "tips",
  ];
  if (containsAny(t, strongIntent)) return "not_small_talk";

  // Contains game keywords = likely not small talk
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
    "drops",
    "gear",
    "build",
    "charm",
    "potion",
    "potions",
    "event",
    "xp",
    "level",
  ];
  if (containsAny(t, gameHints)) return "not_small_talk";

  // greetings
  const greetings = new Set([
    "hi",
    "hii",
    "hiii",
    "hello",
    "heyy",
    "heyyy",
    "hey",
    "yo",
    "sup",
    "wassup",
    "good morning",
    "good afternoon",
    "good evening",
  ]);
  if (greetings.has(t)) return "greeting";

  // identity / capability questions (still small talk)
  if (t === "who are you" || t === "what can you do" || t === "what do you do") return "about_ai";

  // mood
  if (t === "how are you" || t === "how you doing" || t === "how are u") return "mood";

  // thanks / acknowledgement
  const thanks = new Set(["thanks", "thank you", "ty", "thx", "appreciate it"]);
  if (thanks.has(t)) return "thanks";

  const ack = new Set(["ok", "okay", "k", "kk", "nice", "cool", "great", "alright", "bet"]);
  if (ack.has(t)) return "ack";

  // short + no hints => likely small talk
  if (t.length <= 18) return "greeting";

  return "not_small_talk";
}

// Detect "what should I do next" style requests
function isWhatNext(qRaw) {
  const t = normalize(qRaw);
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
    "i m new what should i do",
    "where do i start",
    "how do i play",
    "how to play",
    "how do i start",
  ];
  return triggers.some((p) => t.includes(p));
}

// Try to extract quick signals from user message (best-effort)
function extractSignals(qRaw) {
  const t = normalize(qRaw);

  // level
  let level = null;
  const m1 = t.match(/\blevel\s*(\d{1,3})\b/);
  if (m1) level = Number(m1[1]);
  const m2 = t.match(/\blvl\s*(\d{1,3})\b/);
  if (!level && m2) level = Number(m2[1]);

  // focus area
  let focus = null;
  const focusMap = [
    { key: "dungeons", hits: ["dungeon", "dungeons", "dungetron"] },
    { key: "fishing", hits: ["fish", "fishing"] },
    { key: "crafting", hits: ["craft", "crafting", "workbench", "alchemy"] },
    { key: "eggs", hits: ["egg", "eggs", "giggling", "gigglings", "hatch", "hatching"] },
    { key: "trading", hits: ["trade", "trading", "market", "gigamarket"] },
  ];
  for (const f of focusMap) {
    if (containsAny(t, f.hits)) {
      focus = f.key;
      break;
    }
  }

  // event vs dungeon focus
  let mode = null;
  if (t.includes("event")) mode = "event";
  if (t.includes("dungeon") || t.includes("dungetron")) mode = mode || "dungeon";

  return { level, focus, mode };
}

function makeSmallTalkResponse(kind) {
  if (kind === "about_ai") {
    return {
      answer:
        `Hey 👋 I’m **Gigaverse AI** — your in-game knowledge assistant.\n\n` +
        `Ask me anything about **dungeons, fishing, crafting, gigglings/eggs, trading, drops, builds**, or **progression** and I’ll guide you (and cite sources when the docs cover it).`,
      followups: ["What are you focusing on today — dungeons, fishing, crafting, eggs, or trading?"],
    };
  }

  if (kind === "mood") {
    return {
      answer: `Doing great 😄 Ready when you are.\n\nWhat are you working on in Gigaverse right now?`,
      followups: ["Dungeons, fishing, crafting, eggs/gigglings, or trading?"],
    };
  }

  if (kind === "thanks") {
    return {
      answer: `Anytime 🤝\n\nWhat do you want to do next in Gigaverse?`,
      followups: ["Want a quick progression plan?"],
    };
  }

  if (kind === "ack") {
    return {
      answer: `👍 Got it.\n\nWant to keep going — what should we tackle next?`,
      followups: ["Ask me about a system: dungeons / fishing / crafting / eggs / trading."],
    };
  }

  // default greeting
  return {
    answer: `Hey 👋 What’s up?\n\nTell me what you’re trying to do in Gigaverse and I’ll point you in the right direction.`,
    followups: [
      "What part of the game are you on right now?",
      "Do you want tips for dungeons, fishing, crafting, eggs/gigglings, or trading?",
    ],
  };
}

// -------------------- Handler --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // ---- Rate Limiting (6 per minute per IP) ----
    const ip = getIp(req);
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

    // ✅ caps
    const QUESTION_MAX = 900;
    const CHUNKS_MAX = 12;
    const CHUNK_TEXT_MAX = 2400;

    const qRaw = question.slice(0, QUESTION_MAX);
    const q = normalize(qRaw);
    const qWords = q.split(" ").filter((w) => w.length >= 3);

    // ---- Chit-chat (warm answers, no “not in docs”) ----
    const chit = classifyChitChat(qRaw);
    if (chit !== "not_small_talk") {
      const { answer, followups } = makeSmallTalkResponse(chit);
      return res.status(200).json({
        mode: "helper",
        answer,
        followups: (followups || []).slice(0, 2),
        citations: [],
      });
    }

    // ---- "What Next" mode: if user asks for progression guidance and didn't give basics, ask directly (no Groq call) ----
    const whatNext = isWhatNext(qRaw);
    if (whatNext) {
      const sig = extractSignals(qRaw);

      // If they didn't provide enough, ask the 3 sticky questions (and stop).
      // This prevents weird generic answers + makes it feel like a real coach.
      if (!sig.level || !sig.focus || !sig.mode) {
        const missingQs = [];
        if (!sig.level) missingQs.push("What **level** are you?");
        if (!sig.focus) missingQs.push("What are you focusing on: **Fishing / Crafting / Eggs (Gigglings) / Dungeons / Trading**?");
        if (!sig.mode) missingQs.push("Are you **event-focused** or **dungeon-focused** right now?");

        return res.status(200).json({
          mode: "helper",
          answer:
            `I’ve got you 🤝\n\n` +
            `To give you a clean “what next” plan, quick checks:\n` +
            missingQs.map((x, i) => `${i + 1}) ${x}`).join("\n"),
          followups: [],
          citations: [],
        });
      }
      // If they DID provide enough, let Groq build a plan using docs context (best).
    }

    // ---- Retrieval / rerank ----
    const intentWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best", "buy", "sell"];

    function scoreChunk(chunk) {
      const title = normalize(chunk?.title || "");
      const section = normalize(chunk?.section || "");
      const text = normalize(chunk?.text || "");

      if (!text && !title && !section) return 0;

      let score = 0;

      // strongest: full-question substring match
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

      // tiny chunks often junk
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

    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];
    let picked = rerankAndPick(clientChunks, 6);

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

    // ---- Prompts ----
    const SYSTEM = `
You are Gigaverse AI, the official assistant for the Gigaverse community.

Tone:
- Warm, confident, and human (like a helpful pro player).
- Short and clear.
- No sarcasm, no roleplay.

Docs-first rules:
1) If SOURCES contain the answer, answer from SOURCES and cite them (up to 3).
2) If SOURCES do not contain the answer, still help with practical guidance, but say: “I don’t see this explicitly in the docs I have loaded.”
3) Never invent Gigaverse-specific mechanics not supported by SOURCES.

Communication rules:
- Start with a quick helpful summary (1–2 lines).
- Then give steps/tips (bullets are fine).
- If the question is vague, ask 1–2 targeted questions max (no generic “clarify”).

"What Next" / Progression coaching:
- If the user asks what to do next / how to play / how to progress:
  - If you already have level + focus area + event/dungeon focus, give a 5–7 step plan.
  - Otherwise ask ONLY the missing pieces (max 3 short questions).

Output JSON only:
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    const whatNextHint = whatNext
      ? `\nNOTE: This is a progression ("what next") request. Coach them with a clear plan.\n`
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
- Followups: 0–2 normally. If this is a "what next" request, you may ask up to 3 short questions only if needed.
Return JSON only.
`.trim();

    // ---- Groq call ----
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
