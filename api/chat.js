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
    const context = safeChunks
      .map((c, i) => {
        const title = c?.title || "Untitled";
        const section = c?.section ? ` — ${c.section}` : "";
        const text = c?.text || "";
        const source = c?.source || c?.url || title;
        return `[#${i + 1}] ${title}${section}\nSOURCE: ${source}\n${text}`.trim();
      })
      .join("\n\n---\n\n");

    const system = `
You are "GIGUS", the Gigaverse Docs AI.
Answer ONLY using the DOC CHUNKS provided below.
If the answer is not in the chunks, say you don't know and ask the user to check Sources.
Return JSON ONLY with keys:
- answer (string)
- phrase (string) // short fun 1-liner
- citations (array of { index:number, title:string, section?:string, source?:string })
`;

    const user = `
USER QUESTION:
${question}

DOC CHUNKS:
${context || "(none provided)"}
`;

    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system.trim() },
          { role: "user", content: user.trim() },
        ],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: data?.error?.message || "Groq API error",
        details: data,
      });
    }

    const content = data?.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // fallback if model returns imperfect json
      parsed = { answer: content, phrase: "⚡ Processing complete.", citations: [] };
    }

    // minimal guardrails
    if (!parsed.phrase) parsed.phrase = "⚡ Done.";
    if (!parsed.citations) parsed.citations = [];

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
