// /api/chat.js — Gigaverse AI (Groq) — Docs-first (PRO retrieval)
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

    const normalize = (s) =>
      (typeof s === "string" ? s : "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const q = normalize(qRaw);
    const qWords = q.split(" ").filter((w) => w.length >= 3);

    const intentWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best"];

    function clampText(t, max) {
      const s = typeof t === "string" ? t : "";
      return s.length > max ? s.slice(0, max) : s;
    }

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

      // ✅ chunk-aware intent boost
      for (const iw of intentWords) {
        if (!q.includes(iw)) continue;
        if (title.includes(iw) || section.includes(iw)) score += 4;
        else if (text.includes(iw)) score += 1;
      }

      // length sanity (tiny chunks often junk)
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

    const SYSTEM = `
You are Gigaverse AI, the official AI assistant for the Gigaverse community.

Style:
- Speak clearly and confidently.
- Be helpful and professional.
- Avoid robotic phrases.
- Do not mention internal implementation details (no “chunks”, no “docs index”, no “RAG”).
- No jokes, no roleplay, no sarcasm.

Behavior (Docs-first):
1) If SOURCES contain the answer, answer from them and cite the relevant SOURCE titles/sections.
2) If SOURCES do not contain the answer, still help: give practical guidance and ask 1–2 targeted follow-up questions.
   - In that case, be explicit: “I don’t see this explicitly in the docs I have loaded.”
3) Never invent Gigaverse-specific mechanics that are not supported by SOURCES.

Output (JSON only):
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
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
