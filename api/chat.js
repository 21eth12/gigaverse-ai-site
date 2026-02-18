// /api/chat.js — Gigaverse AI (Groq)
// Expects POST { question: string, chunks: [{title, section, text}] }
// Returns JSON: { mode, answer, followups, citations }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing GROQ_API_KEY in Vercel env vars" });
    }

    const { question, chunks } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing 'question' string" });
    }

    const safeChunks = Array.isArray(chunks) ? chunks.slice(0, 8) : [];

    // Build context from chunks (short + clean)
    const context = safeChunks
      .map((c, i) => {
        const title = (c?.title || "Untitled").toString();
        const section = (c?.section || "").toString();
        const text = (c?.text || "").toString();
        return `CHUNK ${i + 1}\nTITLE: ${title}\nSECTION: ${section}\nTEXT:\n${text}`.trim();
      })
      .join("\n\n---\n\n");

    const SYSTEM = `
You are Gigaverse Support AI for the Gigaverse community.

GOALS:
- Be professional, clear, and helpful.
- Prefer answers grounded in the provided DOC CHUNKS.
- If the answer is not in DOC CHUNKS, do NOT guess facts.
  Instead, switch to HELPER MODE: give guidance, troubleshooting steps, and ask 1–2 clarifying questions.

STYLE:
- No jokes, no roleplay, no sarcasm, no “mystery” lines.
- Use short structured answers (bullets when useful).
- If citing, cite only what is in DOC CHUNKS.
- If user asks something general (e.g. “how do I craft?”) and docs are missing, guide them on what to check + what info you need.

OUTPUT (JSON ONLY):
{
  "mode": "docs" | "helper",
  "answer": string,
  "followups": string[],
  "citations": [{"title": string, "section": string}]
}
`.trim();

    const userPrompt = `
DOC CHUNKS:
${context || "(no chunks provided)"}

USER QUESTION:
${question}

Instructions:
- If DOC CHUNKS contain the answer, set mode="docs" and cite the best matching chunks.
- If DOC CHUNKS do NOT contain the answer, set mode="helper" and provide helpful steps + 1–2 follow-up questions.
- citations must be empty in helper mode.
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
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const raw = await groqRes.json().catch(() => null);

    if (!groqRes.ok) {
      const msg =
        raw?.error?.message ||
        raw?.error ||
        `Groq error (${groqRes.status})`;
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
    const answer = typeof parsed?.answer === "string" ? parsed.answer : "I can help—what are you trying to do?";
    const followups = Array.isArray(parsed?.followups) ? parsed.followups.slice(0, 2).map(String) : [];
    let citations = Array.isArray(parsed?.citations) ? parsed.citations : [];

    // In helper mode: no citations
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
