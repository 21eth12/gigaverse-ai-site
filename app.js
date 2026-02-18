/* app.js — Gigaverse Docs AI (Vercel + Groq)
   - Loads docs_index.json
   - Picks relevant chunks (lightweight search)
   - Sends to /api/chat
   - Renders answer + followups + citations (only when docs mode)
*/

(() => {
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

  function killCommandPalette() {
    hideIfExists("#commandModal");
    hideIfExists(".command-modal");
    hideIfExists(".commandPalette");
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

  const state = { docs: [], ready: false, view: "chat" };

  const dom = {
    viewChat: $("#view-chat") || $("#chatView") || $("#ai-chat") || $("#mainChat"),
    viewSources: $("#view-sources") || $("#sourcesView"),
    viewAbout: $("#view-about") || $("#aboutView"),

    btnChat: $("#nav-chat") || $("#btnChat") || $$("button, a").find((b) => (b.textContent || "").trim().toLowerCase() === "ai chat"),
    btnSources: $("#nav-sources") || $("#btnSources") || $$("button, a").find((b) => (b.textContent || "").trim().toLowerCase() === "sources"),
    btnAbout: $("#nav-about") || $("#btnAbout") || $$("button, a").find((b) => (b.textContent || "").trim().toLowerCase() === "about"),

    messages: $("#messages") || $("#chatMessages") || $("#terminal") || $(".messages"),
    input: $("#chatInput") || $("#prompt") || $("input[type='text']") || $("textarea"),
    sendBtn: $("#sendBtn") || $("#askBtn") || $$("button").find((b) => (b.textContent || "").trim().toLowerCase() === "ask"),

    docsBadge: $("#docsBadge") || $("#docsLoaded") || $("[data-docs-badge]"),
    bootLine: $("#bootLine") || $("#bootingLine") || $("[data-boot-line]"),

    sourcesList: $("#sourcesList") || $("#sources") || $("[data-sources-list]"),
  };

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
    if (view === "sources") renderSources();
  }

  function wireNav() {
    if (dom.btnChat) dom.btnChat.addEventListener("click", () => setView("chat"));
    if (dom.btnSources) dom.btnSources.addEventListener("click", () => setView("sources"));
    if (dom.btnAbout) dom.btnAbout.addEventListener("click", () => setView("about"));
  }

  function normalizeDocChunk(raw, idx) {
    const title = safeText(raw.title || raw.file || raw.source || raw.doc || "Untitled");
    const section = safeText(raw.section || raw.heading || raw.subheading || "");
    const text = safeText(raw.text || raw.content || raw.body || raw.chunk || "");
    return { id: raw.id ?? idx, title, section, text };
  }

  async function loadDocs() {
    try {
      if (dom.bootLine) dom.bootLine.textContent = "Loading docs…";
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
    const textSet = new Set(tokenize(chunk.text));

    let score = 0;
    for (const t of qTokens) {
      if (titleTokens.has(t)) score += 6;
      if (sectionTokens.has(t)) score += 4;
      if (textSet.has(t)) score += 1;
    }

    const len = clamp(chunk.text.length, 200, 2000);
    score += score > 0 ? 2000 / len : 0;
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

    // Followups (helper mode)
    if (role === "assistant" && Array.isArray(meta.followups) && meta.followups.length) {
      wrapper.appendChild(el("div", { class: "msg-cite-title", text: "Quick questions:" }));
      const ul = el("ul", { class: "msg-cites" });
      meta.followups.slice(0, 2).forEach((q) => ul.appendChild(el("li", { text: safeText(q) })));
      wrapper.appendChild(ul);
    }

    // Citations (docs mode)
    if (role === "assistant" && Array.isArray(meta.citations) && meta.citations.length) {
      wrapper.appendChild(el("div", { class: "msg-cite-title", text: "Sources:" }));
      const ul = el("ul", { class: "msg-cites" });

      // dedupe
      const seen = new Set();
      const unique = [];
      for (const c of meta.citations) {
        const t = safeText(c.title).trim();
        const s = safeText(c.section).trim();
        const key = `${t}__${s}`;
        if (!t) continue;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push({ title: t, section: s });
        }
      }

      unique.slice(0, 3).forEach((c) => {
        ul.appendChild(el("li", { text: c.section ? `${c.title} — ${c.section}` : c.title }));
      });
      wrapper.appendChild(ul);
    }

    dom.messages.appendChild(wrapper);
    dom.messages.scrollTop = dom.messages.scrollHeight;
    return wrapper;
  }

  function setBusy(isBusy) {
    if (dom.sendBtn) dom.sendBtn.disabled = isBusy;
    if (dom.input) dom.input.disabled = isBusy;
  }

  async function askServer(question) {
    const chunks = pickTopChunks(question, 8);

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
        const label = c.section ? c.section : "(no section)";
        ul.appendChild(el("li", { text: label }));
      });
      box.appendChild(ul);
      dom.sourcesList.appendChild(box);
    }
  }

  function wireChat() {
    if (!dom.input || !dom.sendBtn) return;

    const send = async () => {
      const q = safeText(dom.input.value).trim();
      if (!q) return;

      dom.input.value = "";
      setBusy(true);

      addMessage("user", q);
      const typing = addMessage("assistant", "Thinking…", { tag: "working" });

      try {
        if (!state.ready) throw new Error("Docs not loaded yet. Check docs_index.json is accessible.");

        const out = await askServer(q);

        // Replace typing message body
        typing.querySelector(".msg-tag")?.remove();
        typing.querySelector(".msg-body").textContent = out.answer;

        if (out.mode === "helper" && out.followups.length) {
          typing.appendChild(el("div", { class: "msg-cite-title", text: "Quick questions:" }));
          const ul = el("ul", { class: "msg-cites" });
          out.followups.slice(0, 2).forEach((x) => ul.appendChild(el("li", { text: safeText(x) })));
          typing.appendChild(ul);
        }

        if (out.mode === "docs" && out.citations.length) {
          typing.appendChild(el("div", { class: "msg-cite-title", text: "Sources:" }));
          const ul = el("ul", { class: "msg-cites" });

          const seen = new Set();
          const unique = [];
          for (const c of out.citations) {
            const t = safeText(c.title).trim();
            const s = safeText(c.section).trim();
            const key = `${t}__${s}`;
            if (!t) continue;
            if (!seen.has(key)) { seen.add(key); unique.push({ title: t, section: s }); }
          }

          unique.slice(0, 3).forEach((c) => {
            ul.appendChild(el("li", { text: c.section ? `${c.title} — ${c.section}` : c.title }));
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

  async function init() {
    killCommandPalette();
    wireNav();
    wireChat();
    setView("chat");

    await loadDocs();

    if (dom.messages && dom.messages.childElementCount === 0) {
      addMessage(
        "assistant",
        "Ask a Gigaverse question and I’ll answer using the docs. If it’s not in the docs yet, I’ll guide you to the right place.",
        { }
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
