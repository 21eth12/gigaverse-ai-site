/* Gigaverse Docs AI Terminal (Real AI + RAG)
   - Loads docs_index.json
   - Simple scoring search over chunks
   - Calls /api/chat (Vercel function) with top chunks
   - Renders answer + phrase + citations
*/

const state = {
  view: "chat",
  docs: [],
  docsLoaded: false,
};

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function setStatus(text, ok = false) {
  const el = $("#docsStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("muted", !ok);
}

function switchView(view) {
  state.view = view;
  $all(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#view-chat").classList.toggle("hidden", view !== "chat");
  $("#view-sources").classList.toggle("hidden", view !== "sources");
  $("#view-about").classList.toggle("hidden", view !== "about");
}

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Simple term-frequency scoring (good enough to start)
function scoreChunk(queryTokens, chunkText) {
  const textTokens = tokenize(chunkText);
  if (!textTokens.length) return 0;

  const tf = new Map();
  for (const t of textTokens) tf.set(t, (tf.get(t) || 0) + 1);

  let score = 0;
  for (const q of queryTokens) {
    score += (tf.get(q) || 0);
  }
  return score / Math.sqrt(textTokens.length);
}

function searchDocs(query, k = 4) {
  const qTok = tokenize(query);
  const ranked = state.docs
    .map(d => ({
      ...d,
      _score: scoreChunk(qTok, `${d.title} ${d.section} ${d.text}`)
    }))
    .filter(d => d._score > 0)
    .sort((a,b) => b._score - a._score)
    .slice(0, k);

  // fallback: if nothing matches, just take a few (still lets AI respond)
  if (ranked.length === 0) return state.docs.slice(0, Math.min(k, state.docs.length));
  return ranked;
}

function addBubble({ role, title, text, citations }) {
  const log = $("#chatLog");
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role === "user" ? "user" : "ai"}`;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = title;

  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;

  wrap.appendChild(meta);
  wrap.appendChild(body);

  if (citations && citations.length) {
    const cite = document.createElement("div");
    cite.className = "cite";
    const lines = citations.map((c, i) => {
      const t = c.title || "Untitled";
      const s = c.section ? ` • ${c.section}` : "";
      return `${i + 1}. ${t}${s}`;
    });
    cite.innerHTML = `Sources:<br/><code>${lines.join("\n")}</code>`;
    wrap.appendChild(cite);
  }

  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

async function loadDocs() {
  setStatus("Loading docs…");
  try {
    const res = await fetch("./docs_index.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`docs_index.json HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error("docs_index.json must be an array");
    state.docs = json;
    state.docsLoaded = true;
    setStatus(`Docs loaded: ${state.docs.length} chunks`, true);
    $("#sourcesPre").textContent = JSON.stringify(state.docs, null, 2);
  } catch (e) {
    console.error(e);
    state.docsLoaded = false;
    setStatus("Docs failed to load", false);
    $("#sourcesPre").textContent = `ERROR loading docs_index.json:\n${String(e)}`;
  }
}

async function askAI() {
  const input = $("#chatInput");
  const askBtn = $("#askBtn");
  const question = (input.value || "").trim();
  if (!question) return;

  addBubble({ role: "user", title: "YOU • user", text: question });
  input.value = "";

  askBtn.disabled = true;
  askBtn.textContent = "…";

  try {
    // RAG: pick best chunks
    const top = searchDocs(question, 4).map(d => ({
      id: d.id,
      title: d.title,
      section: d.section,
      text: d.text
    }));

    // Call your REAL AI backend
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, chunks: top })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `API error: HTTP ${res.status}`);
    }

    const phrase = data.phrase ? `\n\n${data.phrase}` : "";
    addBubble({
      role: "ai",
      title: "GIGUS • assistant",
      text: (data.answer || "No answer returned.") + phrase,
      citations: data.citations || top
    });
  } catch (e) {
    console.error(e);
    addBubble({
      role: "ai",
      title: "GIGUS • error",
      text: `Something broke:\n${String(e)}\n\nCheck Vercel logs + make sure OPENAI_API_KEY is set.`,
      citations: []
    });
  } finally {
    askBtn.disabled = false;
    askBtn.textContent = "Ask";
  }
}

function bindUI() {
  // sidebar nav
  $all(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  $("#askBtn").addEventListener("click", askAI);
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") askAI();
  });

  // optional: Ctrl/Cmd+K focuses input (instead of opening a modal)
  window.addEventListener("keydown", (e) => {
    const isK = e.key.toLowerCase() === "k";
    const isCmdK = (e.ctrlKey || e.metaKey) && isK;
    if (isCmdK) {
      e.preventDefault();
      switchView("chat");
      $("#chatInput").focus();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindUI();
  switchView("chat");
  await loadDocs();
});

