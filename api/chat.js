// /api/chat.js — Gigaverse AI (Groq) — Docs-first (PRO retrieval)
// Expects POST { question: string, chunks?: [{title, section, text, url?}] }
// Returns JSON: { mode, answer, followups, citations }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GROQ_API_KEY in Vercel env vars" });

    const { question, chunks } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing 'question' string" });
    }

    // -----------------------------
    // Retrieval (server-side re-rank + fallback)
    // -----------------------------
    const normalize = (s) =>
      (typeof s === "string" ? s : "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const qRaw = question.trim();
    const q = normalize(qRaw);
    const qWords = q.split(" ").filter((w) => w.length >= 3);

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

      // intent boosts (helps "how do I..." style)
      const intentBoostWords = ["how", "where", "what", "drop", "drops", "craft", "earn", "get", "use", "fight", "best"];
      for (const ib of intentBoostWords) {
        if (q.includes(ib)) {
          score += 2;
          break;
        }
      }

      // small penalty if text is extremely tiny (often noise)
      const len = (chunk?.text || "").length;
      if (len > 0 && len < 120) score -= 3;

      return score;
    }

    function rerankAndPick(allChunks, k = 6) {
      const list = Array.isArray(allChunks) ? allChunks : [];
      const scored = list
        .map((c) => ({
          title: (c?.title || "Untitled").toString(),
          section: (c?.section || "").toString(),
          url: (c?.url || "").toString(),
          text: (c?.text || "").toString(),
          _score: scoreChunk(c),
        }))
        .sort((a, b) => b._score - a._score);

      const picked = scored.filter((x) => x._score > 0).slice(0, k);

      // If nothing matched, return empty (we'll go helper mode)
      return picked;
    }

    async function fetchDocsIndexFromSite() {
      // Build origin from request headers (works on Vercel)
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

    // Use chunks sent from client, but ALWAYS rerank them for best relevance.
    const clientChunks = Array.isArray(chunks) ? chunks : [];
    let picked = rerankAndPick(clientChunks, 6);

    // If client didn't send chunks (or they were bad), fallback to server fetching docs_index.json
    if (picked.length === 0) {
      const docsIndex = await fetchDocsIndexFromSite();
      // Rerank from full index, but cap to avoid huge CPU if docs get massive
      // (If docsIndex is huge, we still score it — but this keeps worst-case safer)
      const capped = docsIndex.length > 6000 ? docsIndex.slice(0, 6000) : docsIndex;
      picked = rerankAndPick(capped, 6);
    }

    // Build context (clean + structured)
    const context = picked
      .map((c, i) => {
        const title = (c.title || "Untitled").toString().trim();
        const section = (c.section || "").toString().trim();
        const url = (c.url || "").toString().trim();
        const text = (c.text || "").toString().trim();
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

    // -----------------------------
    // Model prompting (Docs-first)
    // -----------------------------
    const SYSTEM = `
You are Gigaverse AI, the official AI assistant for the Gigaverse community.

Style:
- Speak clearly and confidently.
- Be helpful and professional.
- Avoid robotic phrases.
- Do not mention internal implementation details (no “chunks”, no “docs index”, no “RAG”).
- Do not say “I don't know” unless absolutely necessary.
- No jokes, no roleplay, no sarcasm, no “mystery” lines.

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

    // Normalize output
    const mode = parsed?.mode === "docs" ? "docs" : "helper";
    const answer =
      typeof parsed?.answer === "string" && parsed.answer.trim()
        ? parsed.answer
        : "I can help—what are you trying to do in Gigaverse?";

    const followups = Array.isArray(parsed?.followups)
      ? parsed.followups.slice(0, 2).map((x) => String(x)).filter(Boolean)
      : [];

    let citations = Array.isArray(parsed?.citations) ? parsed.citations : [];
    if (mode === "helper") citations = [];

    // Dedupe citations (title+section)
    const seen = new Set();
    const unique = [];
    for (const c of citations) {
      const t = (c?.title || "").toString().trim();
      const s = (c?.section || "").toString().trim();
      const key = `${t}__${s}`;
      if (!t) continue;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({ title: t, section: s });
      }
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
