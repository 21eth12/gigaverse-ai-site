export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

    const { question, chunks } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing 'question' string" });
    }

    const safeChunks = Array.isArray(chunks) ? chunks.slice(0, 6) : [];
    const context = safeChunks.map((c, i) => {
      const title = c.title || "Untitled";
      const section = c.section ? ` — ${c.section}` : "";
      const text = c.text || "";
      return `[${i + 1}] ${title}${section}\n${text}`;
    }).join("\n\n");

    // We’ll ask the model to return JSON (easy to parse reliably)
    const prompt = `
You are "GIGUS", the Gigaverse Docs AI.
Answer ONLY using the provided DOC CHUNKS. If not in chunks, say you don't know.
Return JSON ONLY with keys: answer, phrase, citations.

- answer: clear helpful answer (short/medium)
- phrase: a short, fun, interactive 1-liner (like a terminal quip)
- citations: array of numbers referencing chunks you used, e.g. [1,3]

DOC CHUNKS:
${context || "(no chunks provided)"}

QUESTION:
${question}
`;

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-5",
        input: prompt,
        // keep it snappy
        reasoning: { effort: "low" }
      })
    });

    const raw = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        error: raw?.error?.message || "OpenAI request failed",
        details: raw
      });
    }

    // Responses API returns output_text inside output array items.
    // We'll extract the combined output_text.
    let text = "";
    try {
      const out = raw.output || [];
      for (const item of out) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === "output_text" && typeof c.text === "string") {
              text += c.text;
            }
          }
        }
      }
    } catch {}

    // Parse JSON from model
    let parsed = null;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      // fallback if model didn't obey strict JSON
      parsed = { answer: text.trim() || "No answer.", phrase: "", citations: [] };
    }

    const citeNums = Array.isArray(parsed.citations) ? parsed.citations : [];
    const citations = citeNums
      .map(n => safeChunks[(n - 1)])
      .filter(Boolean)
      .map(c => ({ title: c.title, section: c.section, id: c.id }));

    // If model didn't cite, just return the chunks we sent (still transparent)
    const finalCitations = citations.length ? citations : safeChunks.map(c => ({
      title: c.title, section: c.section, id: c.id
    }));

    return res.status(200).json({
      answer: parsed.answer || "No answer.",
      phrase: parsed.phrase || "",
      citations: finalCitations
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

