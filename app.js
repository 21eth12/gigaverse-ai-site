/* app.js — Gigaverse Docs AI (Vercel + Groq)
   - Loads docs_index.json
   - Picks relevant chunks (lightweight search)
   - Sends to /api/chat
   - Renders:
      ✅ Answer panel (latest answer only)
      ✅ Terminal chat log (history)
      ✅ Sources + About views
*/

(() => {
  // ---------- tiny helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const safeText = (v) => (typeof v === "string" ? v : "");
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    });
    children.forEach((c) => node.appendChild(c));
    return node;
  }

  // ---------- app state ----------
  const state = {
    docs: [],
    ready: false,
    view: "chat",
  };

  // ---------- dom ----------
  const dom = {
    // views
    viewChat: $("#view-chat"),
    viewSources: $("#view-sources"),
    viewAbout: $("#view-about"),

    // nav (uses data-view in your HTML)
    navBtns: $$(".nav-btn[data-view]"),

    // chat
    chatLog: $("#chatLog"),
    input: $("#chatInput"),
    sendBtn: $("#askBtn"),

    // status badge in top bar
    docsStatus: $("#docsStatus"),

    // sources view
    sourcesPre: $("#sourcesPre"),

    // answer panel
    answerText: $("#answerText"),
    answerModeBadge: $("#answerModeBadge"),
    answerMeta: $("#answerMeta"),
    answerSources: $("#answerSources"),
    answerFollowups: $("#answerFollowups"),
  };

  // ---------- UX: disable Ctrl/Cmd+K palette (if any) ----------
  function killCommandPalette() {
    // hide common palette/modals if present
    ["#commandModal", ".command-modal", ".commandPalette"].forEach((sel) => {
      const n = $(sel);
      if (n) n.style.display = "none";
    });
    $$(".modal-backdrop, .backdrop, .overlay").forEach((n) => (n.style.display = "none"));

    window.addEventListener(
      "keydown",
      (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  }

  // ---------- navigation ----------
  function setView(view) {
    state.view = view;

    // nav active class
    dom.navBtns.forEach((b) => b.classList.toggle("active", b.getAttribute("data-view") === view));

    if (dom.viewChat) dom.viewChat.classList.toggle("hidden", view !== "chat");
    if (dom.viewSources) dom.viewSources.classList.toggle("hidden", view !== "sources");
    if (dom.viewAbout) dom.viewAbout.classList.toggle("hidden", view !== "about");

    if (view === "sources") renderSourcesView();
  }

  function wireNav() {
    dom.navBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.getAttribute("data-view") || "chat";
        setView(view);
      });
    });
  }

  // ---------- docs loading ----------
  function normalizeDocChunk(raw, idx) {
    const title = safeText(raw.title || raw.file || raw.source || raw.doc || "Untitled");
    const section = safeText(raw.section || raw.heading || raw.subheading || "");
    const text = safeText(raw.text || raw.content || raw.body || raw.chunk || "");
    const url = safeText(raw.url || raw.link || "");
    return { id: raw.id ?? idx, title, section, text, url };
  }

  async function loadDocs() {
    try {
      if (dom.docsStatus) dom.docsStatus.textContent = "Loading docs…";

      const res = await fetch(`docs_index.json?cb=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`docs_index.json failed: ${res.status}`);
      const data = await res.json();

      const rawChunks = Array.isArray(data)
        ? data
        : Array.isArray(data.chunks)
        ? data.chunks
        : Array.isArray(data.docs)
        ? data.docs
        : [];

      state.docs = rawChunks.map(normalizeDocChunk).filter((c) => c.text.trim().length > 0);
      state.ready = true;

      const n = state.docs.length;
      if (dom.docsStatus) dom.docsStatus.textContent = `Docs loaded: ${n} chunks`;
    } catch (err) {
      state.ready = false;
      if (dom.docsStatus) dom.docsStatus.textContent = "Docs failed to load";
      console.error(err);
      // Also show in sources view if user clicks it
    }
  }

  // ---------- lightweight retrieval ----------
  function tokenize(str) {
    return safeText(str)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }

  function scoreChunk(qTokens, chunk) {
    if (!qTokens.length) return 0;

    const titleTokens = new Set(tokenize(chunk.title));
    const sectionTokens = new Set(tokenize(chunk.section));
    const textTokens = new Set(tokenize(chunk.text));

    let score = 0;
    for (const t of qTokens) {
      if (titleTokens.has(t)) score += 6;
      if (sectionTokens.has(t)) score += 4;
      if (textTokens.has(t)) score += 1;
    }

    // slight length normalization
    const len = clamp(chunk.text.length, 200, 2200);
    score += score > 0 ? 2200 / len : 0;

    return score;
  }

  function pickTopChunks(question, k = 8) {
    const qTokens = tokenize(question);
    const scored = state.docs
      .map((c) => ({ c, s: scoreChunk(qTokens, c) }))
      .sort((a, b) => b.s - a.s);

    const picked = scored.filter((x) => x.s > 0).slice(0, k).map((x) => x.c);
    return picked.length ? picked : state.docs.slice(0, k);
  }

  // ---------- rendering ----------
  function addBubble(role, text, meta = {}) {
    if (!dom.chatLog) return null;

    const wrapper = el("div", { class: `bubble ${role === "user" ? "user" : "ai"}` });

    const metaLine = el("div", { class: "meta" });
    metaLine.textContent = role === "user" ? "YOU" : "GIGUS";
    if (meta.tag) metaLine.textContent += ` • ${meta.tag}`;
    wrapper.appendChild(metaLine);

    const body = el("div", { class: "text" });
    body.textContent = safeText(text);
    wrapper.appendChild(body);

    // docs citations
    if (role === "assistant" && meta.mode === "docs" && Array.isArray(meta.citations) && meta.citations.length) {
      const cite = el("div", { class: "cite" });
      const unique = dedupeCitations(meta.citations).slice(0, 3);
      cite.innerHTML =
        "Sources: " +
        unique
          .map((c) => `<code>${escapeHtml(c.section ? `${c.title} — ${c.section}` : c.title)}</code>`)
          .join(" ");
      wrapper.appendChild(cite);
    }

    // helper followups
    if (role === "assistant" && meta.mode === "helper" && Array.isArray(meta.followups) && meta.followups.length) {
      const cite = el("div", { class: "cite" });
      const qs = meta.followups.slice(0, 2);
      cite.textContent = `Quick questions: ${qs.join(" • ")}`;
      wrapper.appendChild(cite);
    }

    dom.chatLog.appendChild(wrapper);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    return wrapper;
  }

  function escapeHtml(s) {
    return safeText(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function dedupeCitations(citations) {
    const seen = new Set();
    const out = [];
    for (const c of citations || []) {
      const t = safeText(c.title).trim();
      const s = safeText(c.section).trim();
      if (!t) continue;
      const key = `${t}__${s}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: t, section: s });
    }
    return out;
  }

  function renderAnswerPanel(out) {
    if (!dom.answerText || !dom.answerModeBadge) return;

    dom.answerText.textContent = safeText(out.answer);

    // mode badge
    const mode = out.mode === "docs" ? "docs" : "helper";
    dom.answerModeBadge.textContent = mode === "docs" ? "DOCS" : "HELPER";
    dom.answerModeBadge.className = `badge ${mode}`;

    const cites = mode === "docs" ? dedupeCitations(out.citations).slice(0, 3) : [];
    const followups = mode === "helper" ? (Array.isArray(out.followups) ? out.followups.slice(0, 2) : []) : [];

    const hasMeta = cites.length > 0 || followups.length > 0;
    if (dom.answerMeta) dom.answerMeta.style.display = hasMeta ? "flex" : "none";

    if (dom.answerSources) {
      dom.answerSources.innerHTML = "";
      cites.forEach((c) => {
        const li = document.createElement("li");
        li.textContent = c.section ? `${c.title} — ${c.section}` : c.title;
        dom.answerSources.appendChild(li);
      });
    }

    if (dom.answerFollowups) {
      dom.answerFollowups.innerHTML = "";
      followups.forEach((q) => {
        const chip = el("div", { class: "pill", text: q });
        chip.style.cursor = "pointer";
        chip.title = "Click to copy into input";
        chip.addEventListener("click", () => {
          if (dom.input) dom.input.value = q;
          dom.input?.focus();
        });
        dom.answerFollowups.appendChild(chip);
      });
    }
  }

  function renderSourcesView() {
    if (!dom.sourcesPre) return;

    if (!state.ready) {
      dom.sourcesPre.textContent = "Docs not loaded yet (or failed to load).";
      return;
    }

    // show a compact overview (not full massive JSON)
    const byTitle = new Map();
    state.docs.forEach((c) => {
      if (!byTitle.has(c.title)) byTitle.set(c.title, new Set());
      byTitle.get(c.title).add(c.section || "(no section)");
    });

    const lines = [];
    lines.push(`Docs chunks: ${state.docs.length}`);
    lines.push("");
    for (const [title, sectionsSet] of byTitle.entries()) {
      const sections = Array.from(sectionsSet).slice(0, 20);
      lines.push(`• ${title}`);
      sections.forEach((s) => lines.push(`   - ${s}`));
      if (sectionsSet.size > sections.length) lines.push(`   - … (${sectionsSet.size - sections.length} more)`);
      lines.push("");
    }

    dom.sourcesPre.textContent = lines.join("\n").trim();
  }

  // ---------- server call ----------
  async function askServer(question) {
    const chunks = pickTopChunks(question, 8).map((c) => ({
      title: c.title,
      section: c.section,
      text: c.text,
      url: c.url,
    }));

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, chunks }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Server error (${res.status})`);

    return {
      mode: data.mode === "docs" ? "docs" : "helper",
      answer: safeText(data.answer) || "(No answer returned.)",
      followups: Array.isArray(data.followups) ? data.followups : [],
      citations: Array.isArray(data.citations) ? data.citations : [],
    };
  }

  // ---------- busy state ----------
  function setBusy(isBusy) {
    if (dom.sendBtn) dom.sendBtn.disabled = isBusy;
    if (dom.input) dom.input.disabled = isBusy;
  }

  // ---------- chat wiring ----------
  function wireChat() {
    if (!dom.input || !dom.sendBtn) return;

    const send = async () => {
      const q = safeText(dom.input.value).trim();
      if (!q) return;

      if (!state.ready) {
        addBubble("assistant", "Docs are not loaded yet. Refresh the page or check docs_index.json is accessible.", {
          mode: "helper",
        });
        return;
      }

      dom.input.value = "";
      setBusy(true);

      addBubble("user", q);

      const thinking = addBubble("assistant", "Thinking…", { tag: "working" });

      try {
        const out = await askServer(q);

        // update terminal bubble
        if (thinking) {
          const body = thinking.querySelector(".text");
          if (body) body.textContent = out.answer;

          // remove tag line if present
          const meta = thinking.querySelector(".meta");
          if (meta) meta.textContent = "GIGUS";

          // append citations/followups onto this bubble
          // easiest: re-render by adding a new bubble and removing old
          thinking.remove();
          addBubble("assistant", out.answer, {
            mode: out.mode,
            citations: out.citations,
            followups: out.followups,
          });
        } else {
          addBubble("assistant", out.answer, {
            mode: out.mode,
            citations: out.citations,
            followups: out.followups,
          });
        }

        // update answer panel (latest only)
        renderAnswerPanel(out);
      } catch (err) {
        if (thinking) {
          const body = thinking.querySelector(".text");
          if (body) body.textContent = `Error: ${err.message}`;
          const meta = thinking.querySelector(".meta");
          if (meta) meta.textContent = "GIGUS";
        } else {
          addBubble("assistant", `Error: ${err.message}`, { mode: "helper" });
        }
      } finally {
        setBusy(false);
        dom.input?.focus();
      }
    };

    dom.sendBtn.addEventListener("click", send);
    dom.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
  }

  // ---------- init ----------
  async function init() {
    killCommandPalette();
    wireNav();
    wireChat();
    setView("chat");

    await loadDocs();

    // seed answer panel
    if (dom.answerText) {
      dom.answerText.textContent = "Ask a question to see the answer here.";
    }
    if (dom.answerMeta) dom.answerMeta.style.display = "none";

    // optional: welcome bubble in terminal if empty
    if (dom.chatLog && dom.chatLog.childElementCount === 0) {
      addBubble(
        "assistant",
        "Ask a Gigaverse question and I’ll answer using the docs. If it’s not in the docs yet, I’ll guide you to the right place.",
        { mode: "helper" }
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
