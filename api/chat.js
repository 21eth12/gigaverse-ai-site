// /api/chat.js — Gigaverse AI (Groq) — Docs-first + Conversational + "What Next" mode
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
  // drop oldest IP entries (best-effort)
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

// Detect short greetings / small talk so we don’t answer “not in docs”
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

  // short + no game keywords = likely small talk
  const gameHints = [
    "gigaverse",
    "dungeon",
    "craft",
    "fishing",
    "egg",
    "giggling",
    "trade",
    "market",
    "boss",
    "drop",
    "gear",
    "xp",
    "build",
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
    "what should i work on",
    "what should i prioritize",
  ];
  return triggers.some((p) => t.includes(p));
}

// Light extraction of player's level + focus from text (optional but helps "what next")
function extractPlayerSignals(q) {
  const t = normalize(q);

  // level patterns
  let level = null;
  const m1 = t.match(/\blevel\s+(\d{1,3})\b/);
  const m2 = t.match(/\blvl\s+(\d{1,3})\b/);
  const m3 = t.match(/\bi\s*m\s*(\d{1,3})\b/);
  if (m1) level = parseInt(m1[1], 10);
  else if (m2) level = parseInt(m2[1], 10);
  else if (m3) level = parseInt(m3[1], 10);

  // focus area detection
  let focus = null;
  if (t.includes("dungeon")) focus = "dungeons";
  else if (t.includes("fish")) focus = "fishing";
  else if (t.includes("craft")) focus = "crafting";
  else if (t.includes("egg") || t.includes("giggling")) focus = "eggs";
  else if (t.includes("trade") || t.includes("market")) focus = "trading";

  // event vs dungeon focus
  let mode = null;
  if (t.includes("event")) mode = "event";
  if (t.includes("dungeon")) {
    // if both appear, keep what was explicitly stated last (simple heuristic)
    const lastEvent = t.lastIndexOf("event");
    const lastDungeon = t.lastIndexOf("dungeon");
    if (lastDungeon > lastEvent) mode = "dungeon";
    else if (lastEvent > lastDungeon) mode = "event";
  }

  return { level, focus, mode };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // ---- Rate Limiting (6 per minute per IP) ----
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

    // ✅ caps (prevents abuse + token explosions)
    const QUESTION_MAX = 900;
    const CHUNKS_MAX = 12;
    const CHUNK_TEXT_MAX = 2400;

    const qRaw = question.slice(0, QUESTION_MAX);
    const q = normalize(qRaw);
    const qWords = q.split(" ").filter((w) => w.length >= 3);

    // -------------------- Small talk (pre-model) --------------------
    // Don’t ever say “not in docs” for greetings or “how are you”.
    if (isSmallTalk(qRaw)) {
      const isWho = /(who are you|what can you do)/.test(q);
      const isHow = /(how are you)/.test(q);

      const answer = isWho
        ? `Hey 👋 I’m **Gigaverse AI** — your in-game knowledge assistant.\n\nAsk me anything about **dungeons, fishing, crafting, gigglings/eggs, trading, drops, builds**, or **progression** and I’ll guide you (with sources when the docs cover it).`
        : isHow
        ? `Doing great 😄 Ready to help you in Gigaverse.\n\nWhat are you working on right now — **dungeons, fishing, crafting, eggs/gigglings, or trading**?`
        : `Hey 👋 What’s up?\n\nTell me what you’re trying to do in Gigaverse and I’ll point you in the right direction.`;

      return res.status(200).json({
        mode: "helper",
        answer,
        followups: isWho
          ? ["What part of the game are you on right now?", "Do you want tips for dungeons, fishing, crafting, eggs/gigglings, or trading?"]
          : ["What part of the game are you on right now?", "Dungeon-focused or event-focused today?"],
        citations: [],
      });
    }

    // -------------------- “What Next?” (pre-model guardrail) --------------------
    // If user asks “what should I do / how to progress” and we don’t have enough info,
    // ask the 3 sticky questions in a friendly way.
    const wn = isWhatNext(qRaw);
    if (wn) {
      const sig = extractPlayerSignals(qRaw);

      // If we’re missing important info, ask for it directly (feels human, avoids generic replies)
      const needLevel = !sig.level;
      const needFocus = !sig.focus;
      const needMode = !sig.mode;

      if (needLevel || needFocus || needMode) {
        const questions = [];
        if (needLevel) questions.push("What level are you?");
        if (needFocus) questions.push("What are you focusing on right now: Dungeons / Fishing / Crafting / Eggs (Gigglings) / Trading?");
        if (needMode) questions.push("Are you event-focused or dungeon-focused?");

        return res.status(200).json({
          mode: "helper",
          answer:
            `I’ve got you 👊\n\n` +
            `To give you a clean “what next” plan, tell me:\n` +
            questions.map((x, i) => `${i + 1}) ${x}`).join("\n"),
          followups: questions.slice(0, 3),
          citations: [],
        });
      }
      // If user already provided signals, we let the model answer with SOURCES + good structure.
    }

    // -------------------- Retrieval + Rerank --------------------
    const intentWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best"];

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

    // Client chunks (rerank)
    const clientChunks = Array.isArray(body.chunks) ? body.chunks : [];
    let picked = rerankAndPick(clientChunks, 6);

    // Fallback to docs_index.json only if needed
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

    // -------------------- Model Prompt --------------------
    const SYSTEM = `
You are Gigaverse AI, the official AI assistant for the Gigaverse community.

Voice (VERY IMPORTANT):
- Sound like a friendly, experienced player (warm, confident, not corporate).
- Keep it natural: short sentences, simple words, no “consider focusing”.
- Never lecture. Never sound like a helpdesk bot.
- If the user is new, give a quick starter plan.

Docs-first rules:
1) If SOURCES contain the answer, use them and cite them.
2) If SOURCES do not contain the answer, be honest: “I don’t see this explicitly in the docs I have loaded.” Then give best-practice guidance.
3) Never invent Gigaverse-specific mechanics not supported by SOURCES.

Answer format (when it’s a game question):
- 1 line: direct answer / direction
- Then: 3–6 bullet steps or tips
- Then: 1 common mistake to avoid (if relevant)
- Then: 0–2 follow-up questions (only if needed)

“What should I do next?” mode:
- If user asks what to do / progress / focus:
  Ask up to 3 short questions: level, focus area (Dungeons/Fishing/Crafting/Eggs/Trading), event vs dungeon.
  If they already gave it, don’t ask again—give a plan in 3 steps.

Output JSON only:
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    const whatNextHint = wn
      ? `\nNOTE: This is a "what next" / progression request. Follow the "What should I do next?" behavior.\n`
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
