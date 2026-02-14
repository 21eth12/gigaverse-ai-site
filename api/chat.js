export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { question } = req.body || {};

  if (!question) {
    return res.status(400).json({ error: "Missing question" });
  }

  return res.status(200).json({
    answer: `Quick pulse: AI is alive.

You asked: "${question}"

(We will connect this to real docs + OpenAI next step.)`,
  });
}
