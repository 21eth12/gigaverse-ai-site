/* app.js — Gigaverse Docs AI (Vercel + Real AI)
   - Loads docs_index.json
   - Picks relevant chunks (lightweight search)
   - Sends to /api/chat (Vercel serverless function)
   - Renders answer + short phrase + citations
*/

(() => {
  // -----------------------------
  // Helpers
  // -----------------------------
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

  function hideIfExists(sel) {
    const node = $(sel);
    if (node) node.style.display = "none";
  }

  // If a command palette modal exists from earlier versions, hide it.
  function killCommandPalette() {
    hideIfExists("#commandModal");
    hideIfExists(".command-modal");
    hideIfExists(".commandPalette");
    // Also remove any overlay/backdrop that might trap clicks
    $$(".modal-backdrop, .backdrop, .overlay").forEach((n) => (n.style.display = "none"));
    // Remove keybind listener if any existed (we don't know its name, so we just stop propagation)
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

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    docs: [],
    ready: false,
    view: "chat", // chat | sources | about
  };

  // -----------------------------
  // DOM bindings (with fallbacks)
  // -----------------------------
  const dom = {
    // Views/sections
    viewChat: $("#view-chat") || $("#chatView") || $("#ai-chat") || $("#mainChat"),
    viewSources: $("#view-sources") || $("#sourcesView"),
    viewAbout: $("#view-about") || $("#aboutView"),

    // Nav buttons
    btnChat: $("#nav-chat") || $("#btnChat") || $$("button, a").find((b) => (b.textContent || "").trim().toLowerCase() === "ai chat"),
    btnSources: $("#nav-sources") || $("#btnSources") || $$("button, a").find((b) => (b.textContent || "").trim().toLowerCase() === "sources"),
    btnAbout: $("#nav-about") || $("#btnAbout") || $$("button, a").find((b) => (b.textContent || "").trim().toLowerCase() === "about"),

    // Chat UI
    messages: $("#messages") || $("#chatMessages") || $("#terminal") || $(".messages"),
    input: $("#chatInput") || $("#prompt") || $("input[type='text']") || $("textarea"),
    sendBtn: $("#sendBtn") || $("#askBtn") || $$("button").find((b) => (b.textContent || "").trim().toLowerCase() === "ask"),

    // Status badges
    docsBadge: $("#docsBadge") || $("#docsLoaded") || $("[data-docs-badge]"),
    bootLine: $("#bootLine") || $("#bootingLine") || $("[data-boot-line]"),

    // Sources list
    sourcesList: $("#sourcesList") || $("#sources") || $("[data-sources-list]"),
  };

  // -----------------------------
  // Navigation
  // -----------------------------
  function setActiveNav() {
    const activeClass = "active";
    [dom.btnChat, dom.btnSources, dom.btnAbout].forEach((b) => b && b.classList.remove(activeClass));
    if (state.view === "chat" && dom.btnChat) dom.btnChat.classList.add(activeClass);
    if (state.view === "sources" && dom.btnSources) dom.btnSources.classList.add(activeClass);
    if (state.view === "about" && dom.btnAbout) dom.btnAbout.classList.add(activeClass);
  }

  function setView(view) {
    state.view = view;
    setActiveNav();

    if (dom.viewChat) dom.viewChat.style.display = view === "chat" ? "block" : "none";
    if (dom.viewSources) dom.viewSources.style.display = view === "sources" ? "block" : "none";
    if (dom.viewAbout) dom.viewAbout.style.display = view === "about" ? "block" : "none";

    // If your HTML doesn't have separate view containers,
    // clicking nav still shouldn't break anything.
    if (view === "sources") renderSources();
  }

  function wireNav() {
    if (dom.btnChat) dom.btnChat.addEventListener("click", () => setView("chat"));
    if (dom.btnSources) dom.btnSources.addEventListener("click", () => setView("sources"));
    if (dom.btnAbout) dom.btnAbout.addEventListener("click", () => setView("about"));
  }

  // -----------------------------
  // Docs loading
  // -----------------------------
  function normalizeDocChunk(raw, idx) {
    // Supports a bunch of formats:
    // {title, section, text}
    // {file, heading, content}
    // {source, chunk, body}
    const title = safeText(raw.title || raw.file || raw.source || raw.doc || "Untitled");
    const section = safeText(raw.section || raw.heading || raw.subheading || "");
    const text = safeText(raw.text || raw.content || raw.body || raw.chunk || "");
    return {
      id: raw.id ?? idx,
      title,
      section,
      text,
    };
  }

  async function loadDocs() {
    try {
      if (dom.bootLine) dom.bootLine.textContent = "Booting Docs AI Terminal…";
      // cache bust so GH pages / Vercel doesn’t serve stale json
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
      if (dom.docsBadge) dom.docsBadge.textContent = `Docs loaded: ${n} chunks`;
      if (dom.bootLine) dom.bootLine.textContent = n ? `Docs loaded: ${n} chunks.` : "Docs loaded, but 0 chunks found.";
    } catch (err) {
      state.ready = false;
      if (dom.bootLine) dom.bootLine.textContent = `Docs load failed: ${err.message}`;
      if (dom.docsBadge) dom.docsBadge.textContent = "Docs failed to load";
      console.error(err);
    }
  }

  // -----------------------------
  // Lightweight retrieval (client-side)
  // -----------------------------
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
    const textTokens = tokenize(chunk.text);

    // quick membership for text (use Set for speed on medium docs)
    const textSet = new Set(textTokens);

    let score = 0;
    for (const t of qTokens) {
      if (titleTokens.has(t)) score += 6;
      if (sectionTokens.has(t)) score += 4;
      if (textSet.has(t)) score += 1;
    }

    // small boost for shorter chunks that match well (less noisy)
    const len = clamp(chunk.text.length, 200, 2000);
    score += (score > 0 ? 2000 / len : 0);

    return score;
  }

  function pickTopChunks(question, k = 6) {
    const qTokens = tokenize(question);
    const scored = state.docs
      .map((c) => ({ c, s: scoreChunk(qTokens, c) }))
      .sort((a, b) => b.s - a.s);

    const picked = scored.filter((x) => x.s > 0).slice(0, k).map((x) => x.c);

    // fallback: if nothing matched, still send a few chunks so model can answer basics
    return picked.length ? picked : state.docs.slice(0, k);
  }

  // -----------------------------
  // Chat rendering
  // -----------------------------
  function ensureMessagesBox() {
    if (!dom.messages) {
      // Create a messages area if the HTML doesn't have one
      const host = dom.viewChat || document.body;
      dom.messages = el("div", { id: "messages", class: "messages" });
      host.appendChild(dom.messages);
    }
  }

  function addMessage(role, text, meta = {}) {
    ensureMessagesBox();

    const name = role === "user" ? "YOU" : "GIGUS";
    const wrapper = el("div", { class: `msg ${role}` });

    const header = el("div", { class: "msg-header" }, [
      el("span", { class: "msg-name", text: name }),
      meta.tag ? el("span", { class: "msg-tag", text: meta.tag }) : el("span"),
    ]);

    const body = el("div", { class: "msg-body" });
    // Preserve line breaks like terminal output
    body.textContent = safeText(text);

    wrapper.appendChild(header);
    wrapper.appendChild(body);

    // Phrase (1-liner)
    if (role === "assistant" && meta.phrase) {
      wrapper.appendChild(
        el("div", { class: "msg-phrase", text: safeText(meta.phrase) })
      );
    }

    // Citations
    if (role === "assistant" && Array.isArray(meta.citations) && meta.citations.length) {
      const citeTitle = el("div", { class: "msg-cite-title", text: "Sources:" });
      const citeList = el("ul", { class: "msg-cites" });

      meta.citations.slice(0, 6).forEach((c) => {
        const t = safeText(c.title || "Untitled");
        const s = safeText(c.section || "");
        citeList.appendChild(el("li", { text: s ? `${t} — ${s}` : t }));
      });

      wrapper.appendChild(citeTitle);
      wrapper.appendChild(citeList);
    }

    dom.messages.appendChild(wrapper);
    dom.messages.scrollTop = dom.messages.scrollHeight;

    return wrapper;
  }

  function setBusy(isBusy) {
    if (dom.sendBtn) dom.sendBtn.disabled = isBusy;
    if (dom.input) dom.input.disabled = isBusy;
  }

  // -----------------------------
  // Call Vercel API
  // -----------------------------
  async function askServer(question) {
    const chunks = pickTopChunks(question, 6);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, chunks }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error || `Server error (${res.status})`;
      throw new Error(msg);
    }

    // expected: { answer, phrase, citations }
    return {
      answer: safeText(data.answer) || "(No answer returned.)",
      phrase: safeText(data.phrase),
      citations: Array.isArray(data.citations) ? data.citations : [],
    };
  }

  // -----------------------------
  // Sources view
  // -----------------------------
  function renderSources() {
    if (!dom.sourcesList) return;

    dom.sourcesList.innerHTML = "";
    if (!state.docs.length) {
      dom.sourcesList.appendChild(el("div", { text: "No docs loaded yet." }));
      return;
    }

    // Group by title
    const byTitle = new Map();
    state.docs.forEach((c) => {
      if (!byTitle.has(c.title)) byTitle.set(c.title, []);
      byTitle.get(c.title).push(c);
    });

    for (const [title, chunks] of byTitle.entries()) {
      const box = el("div", { class: "source-card" });
      box.appendChild(el("div", { class: "source-title", text: title }));
      const ul = el("ul", { class: "source-sections" });
      chunks.slice(0, 10).forEach((c) => {
        const label = c.section ? c.section : "(no section)";
        ul.appendChild(el("li", { text: label }));
      });
      box.appendChild(ul);
      dom.sourcesList.appendChild(box);
    }
  }

  // -----------------------------
  // Wire chat input
  // -----------------------------
  function wireChat() {
    if (!dom.input || !dom.sendBtn) return;

    const send = async () => {
      const q = safeText(dom.input.value).trim();
      if (!q) return;

      dom.input.value = "";
      setBusy(true);

      addMessage("user", q);

      const typing = addMessage("assistant", "…", { tag: "thinking" });

      try {
        if (!state.ready) {
          throw new Error("Docs not loaded yet. Refresh once docs_index.json is available.");
        }
        const out = await askServer(q);
        // Replace typing message content
        typing.querySelector(".msg-tag")?.remove();
        typing.querySelector(".msg-body").textContent = out.answer;
        if (out.phrase) typing.appendChild(el("div", { class: "msg-phrase", text: out.phrase }));

        if (out.citations?.length) {
          typing.appendChild(el("div", { class: "msg-cite-title", text: "Sources:" }));
          const ul = el("ul", { class: "msg-cites" });
          out.citations.slice(0, 6).forEach((c) => {
            const t = safeText(c.title || "Untitled");
            const s = safeText(c.section || "");
            ul.appendChild(el("li", { text: s ? `${t} — ${s}` : t }));
          });
          typing.appendChild(ul);
        }
      } catch (err) {
        typing.querySelector(".msg-tag")?.remove();
        typing.querySelector(".msg-body").textContent = `Error: ${err.message}`;
      } finally {
        setBusy(false);
        dom.input.focus();
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

  // -----------------------------
  // Boot
  // -----------------------------
  async function init() {
    killCommandPalette();
    wireNav();
    wireChat();

    // Default view
    setView("chat");

    // Load docs
    await loadDocs();

    // First system message (optional)
    if (dom.messages && dom.messages.childElementCount === 0) {
      addMessage("assistant", "Ask me anything about the game. I’ll answer using the docs I have, and I’ll cite sources.", {
        phrase: "Boot sequence complete. Awaiting input…",
      });
    }
  }

  // Run after DOM loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
