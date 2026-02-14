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

  // Kill any old command palette / overlay that can trap clicks
  function killCommandPalette() {
    hideIfExists("#commandModal");
    hideIfExists(".command-modal");
    hideIfExists(".commandPalette");

    // Hide common backdrops/overlays that block clicks
    $$(".modal-backdrop, .backdrop, .overlay, [data-overlay]").forEach((n) => {
      n.style.display = "none";
      n.style.pointerEvents = "none";
    });

    // Stop Ctrl/Cmd+K from opening anything unknown
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
  function findNavButtonByText(txt) {
    const needle = String(txt).trim().toLowerCase();
    return (
      $$("button, a").find((b) => (b.textContent || "").trim().toLowerCase() === needle) ||
      null
    );
  }

  const dom = {
    // Views/sections (optional)
    viewChat: $("#view-chat") || $("#chatView") || $("#ai-chat") || $("#mainChat"),
    viewSources: $("#view-sources") || $("#sourcesView"),
    viewAbout: $("#view-about") || $("#aboutView"),

    // Nav buttons
    btnChat: $("#nav-chat") || $("#btnChat") || findNavButtonByText("ai chat"),
    btnSources: $("#nav-sources") || $("#btnSources") || findNavButtonByText("sources"),
    btnAbout: $("#nav-about") || $("#btnAbout") || findNavButtonByText("about"),

    // Chat UI
    messages: $("#messages") || $("#chatMessages") || $("#terminal") || $(".messages"),
    input: $("#chatInput") || $("#prompt") || $("textarea") || $("input[type='text']"),
    sendBtn: $("#sendBtn") || $("#askBtn") || findNavButtonByText("ask"),

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

    // If your HTML has separate containers, toggle them
    if (dom.viewChat) dom.viewChat.style.display = view === "chat" ? "block" : "none";
    if (dom.viewSources) dom.viewSources.style.display = view === "sources" ? "block" : "none";
    if (dom.viewAbout) dom.viewAbout.style.display = view === "about" ? "block" : "none";

    if (view === "sources") renderSources();
  }

  function wireNav() {
    if (dom.btnChat) dom.btnChat.addEventListener("click", (e) => (e.preventDefault(), setView("chat")));
    if (dom.btnSources) dom.btnSources.addEventListener("click", (e) => (e.preventDefault(), setView("sources")));
    if (dom.btnAbout) dom.btnAbout.addEventListener("click", (e) => (e.preventDefault(), setView("about")));
  }

  // -----------------------------
  // Docs loading
  // -----------------------------
  function normalizeDocChunk(raw, idx) {
    const title = safeText(raw.title || raw.file || raw.source || raw.doc || "Untitled");
    const section = safeText(raw.section || raw.heading || raw.subheading || "");
    const text = safeText(raw.text || raw.content || raw.body || raw.chunk || "");
    return { id: raw.id ?? idx, title, section, text };
  }

  function docsUrl() {
    // Works on Vercel (/) and GitHub Pages (/repo/)
    return new URL(`docs_index.json?cb=${Date.now()}`, window.location.href).toString();
  }

  async function loadDocs() {
    try {
      if (dom.bootLine) dom.bootLine.textContent = "Booting Docs AI Terminal…";

      const res = await fetch(docsUrl(), { cache: "no-store" });
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

    // Only build a Set for text once we know we might need it
    const textSet = new Set(tokenize(chunk.text));

    let score = 0;
    for (const t of qTokens) {
      if (titleTokens.has(t)) score += 6;
      if (sectionTokens.has(t)) score += 4;
      if (textSet.has(t)) score += 1;
    }

    // Slight preference for tighter chunks when they match
    const len = clamp(chunk.text.length, 200, 2000);
    if (score > 0) score += 2000 / len;

    return score;
  }

  function pickTopChunks(question, k = 6) {
    const qTokens = tokenize(question);

    const scored = state.docs
      .map((c) => ({ c, s: scoreChunk(qTokens, c) }))
      .sort((a, b) => b.s - a.s);

    const picked = scored.filter((x) => x.s > 0).slice(0, k).map((x) => x.c);

    // If nothing matched, still send a few chunks (so it can respond at all)
    return picked.length ? picked : state.docs.slice(0, k);
  }

  // -----------------------------
  // Chat rendering
  // -----------------------------
  function ensureMessagesBox() {
    if (!dom.messages) {
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
    body.textContent = safeText(text);

    wrapper.appendChild(header);
    wrapper.appendChild(body);

    if (role === "assistant" && meta.phrase) {
      wrapper.appendChild(el("div", { class: "msg-phrase", text: safeText(meta.phrase) }));
    }

    if (role === "assistant" && Array.isArray(meta.citations) && meta.citations.length) {
      wrapper.appendChild(el("div", { class: "msg-cite-title", text: "Sources:" }));
      const citeList = el("ul", { class: "msg-cites" });

      meta.citations.slice(0, 6).forEach((c) => {
        const t = safeText(c.title || "Untitled");
        const s = safeText(c.section || "");
        citeList.appendChild(el("li", { text: s ? `${t} — ${s}` : t }));
      });

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
        ul.appendChild(el("li", { text: c.section ? c.section : "(no section)" }));
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

      // Show a proper "thinking" line
      const typing = addMessage("assistant", "GIGUS thinking…", { tag: "thinking" });

      try {
        if (!state.ready) {
          throw new Error("Docs not loaded yet. Make sure docs_index.json exists and refresh.");
        }

        const out = await askServer(q);

        // Update typing message in-place
        typing.querySelector(".msg-tag")?.remove();
        const body = typing.querySelector(".msg-body");
        if (body) body.textContent = out.answer;

        // Remove old phrase/cites if any (safety)
        typing.querySelector(".msg-phrase")?.remove();
        typing.querySelector(".msg-cite-title")?.remove();
        typing.querySelector(".msg-cites")?.remove();

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
        const body = typing.querySelector(".msg-body");
        if (body) body.textContent = `Error: ${err.message}`;
      } finally {
        setBusy(false);
        dom.input.focus();
      }
    };

    dom.sendBtn.addEventListener("click", send);

    dom.input.addEventListener("keydown", (e) => {
      // If input is textarea, allow Shift+Enter for newline
      const isTextArea = dom.input && dom.input.tagName === "TEXTAREA";
      if (e.key === "Enter" && (!isTextArea || !e.shiftKey)) {
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

    setView("chat");

    await loadDocs();

    ensureMessagesBox();
    if (dom.messages && dom.messages.childElementCount === 0) {
      addMessage(
        "assistant",
        "Ask me anything about the game. I’ll answer using the docs I have, and I’ll cite sources.",
        { phrase: "Boot sequence complete. Awaiting input…" }
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
