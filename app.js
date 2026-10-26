/* Daybreak News: builds today's paper in the browser from free, no-key public APIs. */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const WIKI = "https://en.wikipedia.org";
  const REFRESH_MS = 30 * 60 * 1000;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const nf = new Intl.NumberFormat();
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

  /* ---------- storage (per-device conveniences only) ---------- */
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem("daybreak:" + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem("daybreak:" + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };

  /* ---------- helpers ---------- */
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const utcYmd = d => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const ago = iso => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? "yesterday" : `${d} days ago`;
  };
  /* Wikimedia only serves standard thumbnail widths; fall back to the original thumb if a size is missing. */
  const thumb = (src, w) => src ? src.replace(/\/\d+px-/, `/${w}px-`) : src;
  const imgTag = (src, w, alt = "") => `<img src="${esc(thumb(src, w))}" alt="${esc(alt)}" loading="lazy" onerror="if(this.src!==this.dataset.f){this.src=this.dataset.f}else{this.remove()}" data-f="${esc(src)}">`;
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  async function getJSON(url, { timeout = 12000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function errorBox(target, source, retry) {
    target.innerHTML = `<div class="err"><p>We couldn't reach ${esc(source)} just now. It's usually back within a minute.</p><button class="btn btn-ghost" type="button">Try again</button></div>`;
    $("button", target).addEventListener("click", retry);
  }

  /* Turn Wikipedia HTML into safe markup: only text, bold, italics and links survive. */
  function cleanWikiHTML(node, { markSource = false } = {}) {
    const out = document.createDocumentFragment();
    const walk = (src, dst) => {
      for (const n of src.childNodes) {
        if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.textContent)); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (tag === "STYLE" || tag === "SCRIPT" || tag === "SUP" || tag === "UL" || tag === "LINK") continue;
        if (tag === "A") {
          let href = n.getAttribute("href") || "";
          if (href.startsWith("./")) href = WIKI + "/wiki/" + href.slice(2);
          else if (href.startsWith("/wiki/")) href = WIKI + href;
          else if (href.startsWith("//")) href = "https:" + href;
          if (!/^https?:\/\//.test(href)) { walk(n, dst); continue; }
          const a = document.createElement("a");
          a.href = href; a.target = "_blank"; a.rel = "noopener";
          if (markSource && n.classList.contains("external")) a.className = "src";
          walk(n, a); dst.appendChild(a); continue;
        }
        if (tag === "B" || tag === "I" || tag === "EM" || tag === "STRONG") {
          const el = document.createElement(tag.toLowerCase()); walk(n, el); dst.appendChild(el); continue;
        }
        walk(n, dst);
      }
    };
    walk(node, out);
    return out;
  }

  /* ---------- saved stories + search registry ---------- */
  let saved = store.get("saved", []);
  const registry = new Map(); // id -> {title,url,source}

  function register(item) { registry.set(item.id, item); return item.id; }
  const isSaved = id => saved.some(s => s.id === id);
  const bookmarkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
  const shareIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v7h14v-7"/></svg>';

  function actionButtons(id, { compact: small = false, shareBtn = true } = {}) {
    const on = isSaved(id);
    const cls = small ? "pill-btn mini-btn" : "pill-btn";
    return `<button class="${cls}${on ? " saved" : ""}" type="button" data-save="${esc(id)}" aria-pressed="${on}" aria-label="${on ? "Remove from saved" : "Save for later"}">${bookmarkIcon}${small ? "" : `<span>${on ? "Saved" : "Save"}</span>`}</button>` +
      (shareBtn ? `<button class="${cls}" type="button" data-share="${esc(id)}" aria-label="Share this story">${shareIcon}${small ? "" : "<span>Share</span>"}</button>` : "");
  }

  function toggleSave(id) {
    const item = registry.get(id);
    if (isSaved(id)) { saved = saved.filter(s => s.id !== id); toast("Removed from saved"); }
    else if (item) { saved.unshift({ id, title: item.title, url: item.url, source: item.source, at: Date.now() }); saved = saved.slice(0, 100); toast("Saved for later"); }
    store.set("saved", saved);
    $$(`[data-save="${CSS.escape(id)}"]`).forEach(b => {
      const on = isSaved(id);
      b.classList.toggle("saved", on); b.setAttribute("aria-pressed", on);
      b.setAttribute("aria-label", on ? "Remove from saved" : "Save for later");
      const span = $("span", b); if (span) span.textContent = on ? "Saved" : "Save";
    });
    renderSaved();
  }

  async function share(id) {
    const item = registry.get(id) || saved.find(s => s.id === id);
    if (!item) return;
    const data = { title: item.title, text: `${item.title} (via Daybreak News)`, url: item.url };
    if (navigator.share) { try { await navigator.share(data); return; } catch (e) { if (e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(item.url); toast("Link copied"); }
    catch { toast("Copy this link: " + item.url); }
  }

  function renderSaved() {
    const n = saved.length;
    const badge = $("#saved-count");
    badge.textContent = n; badge.hidden = n === 0;
    $("#saved-empty").hidden = n > 0;
    $("#saved-list").innerHTML = saved.map(s => `<li><div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><span class="s">${esc(s.source)}</span></div>
      <button class="pill-btn mini-btn" type="button" data-unsave="${esc(s.id)}" aria-label="Remove ${esc(s.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></li>`).join("");
  }

  document.addEventListener("click", e => {
    const s = e.target.closest("[data-save]"); if (s) { toggleSave(s.dataset.save); return; }
    const sh = e.target.closest("[data-share]"); if (sh) { share(sh.dataset.share); return; }
    const u = e.target.closest("[data-unsave]"); if (u) { toggleSave(u.dataset.unsave); }
  });

  /* ---------- masthead ---------- */
  function setEdition(loadedAt) {
    const now = new Date();
    $("#edition-date").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    $("#edition-time").textContent = loadedAt ? `Updated ${loadedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Loading the news";
    const h = now.getHours();
    const g = h < 5 ? "Up late?" : h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : h < 22 ? "Good evening." : "Up late?";
    $("#greeting").textContent = g;
  }

  function initTheme() {
    const saved = store.get("theme", null);
    if (saved) document.documentElement.dataset.theme = saved;
    $("#theme-btn").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      store.set("theme", next);
    });
  }

  function initStreak() {
    const today = ymd(new Date());
    const yesterday = ymd(addDays(new Date(), -1));
    let { last, count } = store.get("streak", { last: null, count: 0 });
    if (last !== today) { count = last === yesterday ? count + 1 : 1; last = today; store.set("streak", { last, count }); }
    $("#streak-num").textContent = count;
    $("#streak-text").textContent = count === 1
      ? "Day one. Come back tomorrow to start a streak."
      : `${count} days in a row. ${count >= 7 ? "You're a regular." : "Keep it going tomorrow."}`;
  }

  /* ---------- Wikipedia featured feed: brief, trending, picture, on this day, game ---------- */
  async function loadFeed() {
    const now = new Date();
    const today = await getJSON(`${WIKI}/api/rest_v1/feed/featured/${utcYmd(now)}`);
    if (!today.news?.length || !today.mostread) {
      try {
        const prev = await getJSON(`${WIKI}/api/rest_v1/feed/featured/${utcYmd(addDays(now, -1))}`);
        if (!today.news?.length) today.news = prev.news;
        if (!today.mostread) today.mostread = prev.mostread;
        if (!today.onthisday) today.onthisday = prev.onthisday;
      } catch { /* keep what we have */ }
    }
    return today;
  }

  /* The Brief */
  let brief = { items: [], i: 0, timer: null };

  function renderBrief(news) {
    const stage = $("#brief-stage");
    brief.items = (news || []).map((n, k) => {
      const doc = new DOMParser().parseFromString(`<div>${n.story}</div>`, "text/html");
      const boldHref = doc.querySelector("b a")?.getAttribute("href")?.replace("./", "") || "";
      const links = n.links || [];
      const main = links.find(l => l.title === decodeURIComponent(boldHref)) || links.find(l => l.thumbnail) || links[0] || {};
      const img = (main.thumbnail ? main : links.find(l => l.thumbnail))?.thumbnail?.source;
      const url = main.content_urls?.desktop?.page || (boldHref ? `${WIKI}/wiki/${boldHref}` : WIKI);
      const text = doc.body.textContent.trim();
      const id = register({ id: "brief:" + (main.title || k), title: text, url, source: "Wikipedia · In the news" });
      return { id, doc, img: img || null, extract: main.extract, mainTitle: main.normalizedtitle || main.title, url, text };
    });
    if (!brief.items.length) { stage.innerHTML = `<p class="muted">Today's top stories are still being written. Check the wire below.</p>`; return; }
    $("#brief-progress").innerHTML = brief.items.map((_, k) => `<button type="button" aria-label="Story ${k + 1}"></button>`).join("");
    $$("#brief-progress button").forEach((b, k) => b.addEventListener("click", () => showBrief(k, true)));
    showBrief(Math.min(brief.i, brief.items.length - 1));
  }

  function showBrief(i, user = false) {
    const n = brief.items.length; if (!n) return;
    brief.i = (i + n) % n;
    const it = brief.items[brief.i];
    const stage = $("#brief-stage");
    const h = document.createElement("h3");
    h.appendChild(cleanWikiHTML(it.doc.body.firstChild));
    stage.innerHTML = `<article class="story${it.img ? "" : " no-img"}">
        <div class="story-text"></div>
        ${it.img ? `<div class="story-img">${imgTag(it.img, 500, it.mainTitle || "")}</div>` : ""}
      </article>`;
    const pic = $(".story-img img", stage);
    if (pic) pic.addEventListener("load", () => pic.classList.toggle("fit", pic.naturalWidth / pic.naturalHeight > 1.9));
    const txt = $(".story-text", stage);
    txt.appendChild(h);
    if (it.extract) {
      txt.insertAdjacentHTML("beforeend", `<details class="explain"><summary>What's this about?</summary><p>${esc(it.extract)}</p></details>`);
    }
    txt.insertAdjacentHTML("beforeend", `<div class="story-actions"><a class="pill-btn" href="${esc(it.url)}" target="_blank" rel="noopener">Read more</a>${actionButtons(it.id)}</div>`);
    $("#brief-pos").textContent = `${brief.i + 1} / ${n}`;
    $$("#brief-progress button").forEach((b, k) => b.classList.toggle("on", k <= brief.i));
    if (user) restartBriefTimer();
  }

  function restartBriefTimer() {
    clearInterval(brief.timer);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    brief.timer = setInterval(() => {
      const card = $(".brief");
      if (document.hidden || card.matches(":hover") || card.contains(document.activeElement) || $(".explain[open]", card)) return;
      showBrief(brief.i + 1);
    }, 9000);
  }

  function initBriefControls() {
    $("#brief-prev").addEventListener("click", () => showBrief(brief.i - 1, true));
    $("#brief-next").addEventListener("click", () => showBrief(brief.i + 1, true));
    const stage = $("#brief-stage");
    let x0 = null;
    stage.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse") x0 = e.clientX; });
    stage.addEventListener("pointerup", e => {
      if (x0 == null) return;
      const dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) showBrief(brief.i + (dx < 0 ? 1 : -1), true);
    });
    document.addEventListener("keydown", e => {
      if (e.target.matches("input, textarea")) return;
      const r = $(".brief").getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      if (e.key === "ArrowRight") showBrief(brief.i + 1, true);
      if (e.key === "ArrowLeft") showBrief(brief.i - 1, true);
    });
  }

  /* Picture of the day */
  function renderPotd(image) {
    const fig = $("#potd");
    if (!image) { fig.hidden = true; return; }
    const src = image.thumbnail?.source || image.image?.source || "";
    const cap = (image.description?.text || image.title || "").replace(/\s+/g, " ").trim();
    $(".potd-img", fig).outerHTML = `<a class="potd-img" href="${esc(image.file_page || WIKI)}" target="_blank" rel="noopener">${imgTag(src, 500, cap)}</a>`;
    $("#potd-cap").textContent = cap.length > 160 ? cap.slice(0, 157) + "…" : cap;
  }

  /* Trending */
  const EXCLUDE = /porn|sex|erotic|nude|onlyfans|xxx/i;
  function trendingPool(mostread) {
    return (mostread?.articles || []).filter(a => a.views && !EXCLUDE.test(`${a.title} ${a.description || ""}`) && a.namespace?.id !== -1);
  }

  function sparkline(hist) {
    const v = (hist || []).map(h => h.views);
    if (v.length < 2) return "";
    const w = 70, h = 22, max = Math.max(...v), min = Math.min(...v);
    const pts = v.map((y, i) => [(i / (v.length - 1)) * (w - 4) + 2, h - 3 - ((y - min) / (max - min || 1)) * (h - 6)]);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="a" d="${d} L${last[0].toFixed(1)} ${h} L2 ${h} Z"/><path class="l" d="${d}"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4"/></svg>`;
  }

  function renderTrending(mostread) {
    const body = $("#trend-body");
    const pool = trendingPool(mostread).slice(0, 12);
    if (mostread?.date) {
      const d = new Date(mostread.date.replace("Z", "") + "T12:00:00");
      $("#trend-date").textContent = `Page views · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    }
    if (!pool.length) { body.innerHTML = `<p class="muted">No reading list yet today.</p>`; return; }
    body.innerHTML = pool.map((a, k) => {
      const url = a.content_urls?.desktop?.page || `${WIKI}/wiki/${encodeURIComponent(a.title)}`;
      const id = register({ id: "trend:" + a.title, title: a.normalizedtitle || a.title, url, source: "Trending on Wikipedia" });
      const img = a.thumbnail?.source;
      return `<a class="trend" href="${esc(url)}" target="_blank" rel="noopener" data-search="${esc((a.normalizedtitle || "") + " " + (a.description || ""))}" data-id="${esc(id)}">
        <span class="trend-rank">${k + 1}</span>
        <span class="trend-thumb${img ? "" : " blank"}">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : esc((a.normalizedtitle || "?")[0])}</span>
        <span><h3>${esc(a.normalizedtitle || a.title)}</h3><p>${esc(a.description || a.extract || "")}</p>
        <span class="trend-stats"><span class="mono">${compact.format(a.views)} reads</span>${sparkline(a.view_history)}</span></span>
      </a>`;
    }).join("");
  }

  /* Higher or lower */
  const hl = { pool: [], a: null, b: null, score: 0, best: store.get("hlBest", 0), locked: false };

  function hlPick(exclude) {
    const opts = hl.pool.filter(p => p !== exclude && (!hl.a || p !== hl.a));
    return opts[Math.floor(Math.random() * opts.length)];
  }

  function hlCard(p, reveal) {
    const img = p.thumbnail?.source;
    return `<div class="hl-card">
      <div class="hl-img${img ? "" : " blank"}">${img ? imgTag(img, 330) : esc((p.normalizedtitle || "?")[0])}</div>
      <div class="hl-info"><h3>${esc(p.normalizedtitle || p.title)}</h3><p>${esc(p.description || "")}</p>
      <div class="hl-views" ${reveal ? "" : 'data-hidden="1"'}>${reveal ? `${nf.format(p.views)} <small>readers</small>` : "?"}</div></div>
      ${reveal ? "" : `<div class="hl-btns"><button class="btn" type="button" data-guess="higher">More readers</button><button class="btn btn-ghost" type="button" data-guess="lower">Fewer readers</button></div>`}
    </div>`;
  }

  function hlRender(msg = "", cls = "") {
    const body = $("#hl-body");
    if (hl.pool.length < 3) { body.innerHTML = `<p class="muted">Today's game is still loading its numbers.</p>`; return; }
    body.innerHTML = `<div class="hl-pair">${hlCard(hl.a, true)}<span class="hl-vs" aria-hidden="true">VS</span>${hlCard(hl.b, false)}</div><p class="hl-result ${cls}" aria-live="polite">${msg}</p>`;
    $("#hl-score").textContent = `Score ${hl.score} · Best ${hl.best}`;
    $$("[data-guess]", body).forEach(b => b.addEventListener("click", () => hlGuess(b.dataset.guess)));
  }

  function hlGuess(g) {
    if (hl.locked) return;
    hl.locked = true;
    const right = g === "higher" ? hl.b.views >= hl.a.views : hl.b.views <= hl.a.views;
    const v = $('.hl-views[data-hidden]');
    v.innerHTML = `${nf.format(hl.b.views)} <small>readers</small>`;
    v.classList.add("pop");
    $$("[data-guess]").forEach(b => { b.disabled = true; });
    const res = $(".hl-result");
    if (right) {
      hl.score++;
      if (hl.score > hl.best) { hl.best = hl.score; store.set("hlBest", hl.best); }
      res.textContent = hl.score % 5 === 0 ? `${hl.score} in a row. You really know the internet.` : "Correct!";
      res.className = "hl-result good";
      setTimeout(() => { hl.a = hl.b; hl.b = hlPick(hl.a); hl.locked = false; hlRender(`Streak: ${hl.score}`, "good"); }, 1300);
    } else {
      res.innerHTML = `Not quite. ${esc(hl.b.normalizedtitle)} had ${nf.format(hl.b.views)} readers. Final score: ${hl.score}. <button class="btn btn-ghost" type="button" id="hl-again">Play again</button>`;
      res.className = "hl-result bad";
      $("#hl-score").textContent = `Score ${hl.score} · Best ${hl.best}`;
      $("#hl-again").addEventListener("click", hlStart);
    }
  }

  function hlStart() {
    hl.score = 0; hl.locked = false;
    hl.a = hl.pool[Math.floor(Math.random() * hl.pool.length)];
    hl.b = hlPick(hl.a);
    hlRender();
  }

  /* On this day */
  let historyAll = [], historyShown = 8;
  function renderHistory(events) {
    const now = new Date();
    $("#history-date").textContent = `${MONTHS[now.getMonth()]} ${now.getDate()} in history`;
    historyAll = (events || []).slice().sort((a, b) => b.year - a.year);
    drawHistory();
  }
  function drawHistory() {
    const body = $("#history-body");
    if (!historyAll.length) { body.innerHTML = `<li class="muted">No history entries today.</li>`; return; }
    const year = new Date().getFullYear();
    body.innerHTML = "";
    historyAll.slice(0, historyShown).forEach(ev => {
      const li = document.createElement("li");
      const yrs = year - ev.year;
      li.dataset.search = ev.text;
      const main = ev.pages?.[0];
      const url = main?.content_urls?.desktop?.page;
      li.innerHTML = `<span class="yr">${ev.year}</span><div class="ev">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(ev.text)}</a>` : esc(ev.text)}<span class="ago">${yrs === 1 ? "1 year ago" : `${nf.format(yrs)} years ago`}</span></div>`;
      body.appendChild(li);
    });
    $("#history-more").hidden = historyShown >= historyAll.length;
  }

  async function feedSections() {
    try {
      const feed = await loadFeed();
      renderBrief(feed.news);
      restartBriefTimer();
      renderPotd(feed.image);
      renderTrending(feed.mostread);
      hl.pool = trendingPool(feed.mostread).filter(a => a.thumbnail || a.description);
      hlStart();
      renderHistory(feed.onthisday);
      return true;
    } catch (e) {
      console.warn("feed", e);
      errorBox($("#brief-stage"), "Wikipedia", reload);
      errorBox($("#trend-body"), "Wikipedia", reload);
      $("#hl-body").innerHTML = `<p class="muted">The game needs today's reading numbers. Try refreshing.</p>`;
      $("#history-body").innerHTML = `<li class="muted">History is taking a break. Try refreshing.</li>`;
      $("#potd").hidden = true;
      return false;
    }
  }

  /* ---------- World wire: Wikipedia Current Events portal ---------- */
  const wire = { days: [], active: 0 };

  function parseCurrentEvents(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const content = doc.querySelector(".current-events-content");
    if (!content) return [];
    const groups = [];
    let cur = null;
    const walk = (ul, ctx, out) => {
      for (const li of ul.children) {
        if (li.tagName !== "LI") continue;
        const sub = li.querySelector(":scope > ul");
        const own = li.cloneNode(true);
        own.querySelectorAll("ul").forEach(u => u.remove());
        const label = own.textContent.replace(/\s+/g, " ").trim();
        if (sub) {
          if (label.length > 110) out.push({ ctx, node: own, text: label });
          walk(sub, label.length > 110 ? ctx : [...ctx, label], out);
        } else if (label) out.push({ ctx, node: own, text: label });
      }
    };
    for (const el of content.children) {
      if (el.tagName === "P" && el.querySelector("b")) { cur = { name: el.textContent.trim(), items: [] }; groups.push(cur); }
      else if (el.tagName === "UL") {
        if (!cur) { cur = { name: "Other news", items: [] }; groups.push(cur); }
        walk(el, [], cur.items);
      }
    }
    return groups.filter(g => g.items.length);
  }

  async function loadWireDay(date) {
    const page = `Portal:Current_events/${date.getFullYear()}_${MONTHS[date.getMonth()]}_${date.getDate()}`;
    const data = await getJSON(`${WIKI}/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2&origin=*`);
    if (data.error) return null;
    const groups = parseCurrentEvents(data.parse.text);
    return groups.length ? { date, groups } : null;
  }

  async function wireSection() {
    const body = $("#world-body");
    try {
      const now = new Date();
      const days = await Promise.all([0, -1, -2, -3].map(n => loadWireDay(addDays(now, n)).catch(() => null)));
      wire.days = days.filter(Boolean).slice(0, 3);
      if (!wire.days.length) throw new Error("no current events");
      wire.active = Math.min(wire.active, wire.days.length - 1);
      const label = d => {
        const diff = Math.round((new Date(ymd(now)) - new Date(ymd(d))) / 86400000);
        return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long" });
      };
      $("#world-days").innerHTML = wire.days.map((d, k) =>
        `<button type="button" role="tab" aria-selected="${k === wire.active}" data-day="${k}">${label(d.date)} <span class="mono">${d.groups.reduce((s, g) => s + g.items.length, 0)}</span></button>`).join("");
      $$("#world-days button").forEach(b => b.addEventListener("click", () => {
        wire.active = +b.dataset.day;
        $$("#world-days button").forEach(x => x.setAttribute("aria-selected", x === b));
        drawWire();
      }));
      drawWire();
      return true;
    } catch (e) {
      console.warn("wire", e);
      errorBox(body, "Wikipedia Current Events", reload);
      return false;
    }
  }

  function drawWire() {
    const body = $("#world-body");
    body.innerHTML = "";
    const day = wire.days[wire.active];
    for (const g of day.groups) {
      const sec = document.createElement("section");
      sec.className = "wire-group";
      sec.innerHTML = `<h3>${esc(g.name)}</h3>`;
      const LIMIT = 5;
      g.items.forEach((it, k) => {
        const srcA = [...it.node.querySelectorAll("a.external")].pop();
        const url = srcA?.getAttribute("href") || `${WIKI}/wiki/Portal:Current_events`;
        const title = it.text.replace(/\s*\([^)]*\)\s*$/, "");
        const id = register({ id: `wire:${ymd(day.date)}:${g.name}:${k}`, title, url, source: (srcA?.textContent.replace(/[()]/g, "") || "Wikipedia") + " · " + g.name });
        const row = document.createElement("div");
        row.className = "wire-item";
        row.dataset.search = it.ctx.join(" ") + " " + it.text;
        row.dataset.id = id;
        if (k >= LIMIT) row.classList.add("more");
        const left = document.createElement("div");
        if (it.ctx.length) left.innerHTML = `<span class="wire-ctx">${esc(it.ctx.slice(-2).join(" › "))}</span>`;
        const p = document.createElement("div");
        p.className = "wire-text";
        p.appendChild(cleanWikiHTML(it.node, { markSource: true }));
        left.appendChild(p);
        row.appendChild(left);
        row.insertAdjacentHTML("beforeend", `<div class="row-actions">${actionButtons(id, { compact: true, shareBtn: false })}</div>`);
        sec.appendChild(row);
      });
      if (g.items.length > LIMIT) {
        sec.classList.add("collapsed");
        sec.insertAdjacentHTML("beforeend", `<button class="link-btn wire-more" type="button">Show ${g.items.length - LIMIT} more</button>`);
        $(".wire-more", sec).addEventListener("click", e => { sec.classList.remove("collapsed"); e.currentTarget.remove(); });
      }
      body.appendChild(sec);
    }
    applySearch();
  }

  /* ---------- Hacker News ---------- */
  async function techSection() {
    const body = $("#tech-body");
    try {
      const ids = (await getJSON("https://hacker-news.firebaseio.com/v0/topstories.json")).slice(0, 15);
      const items = (await Promise.all(ids.map(id => getJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null))))
        .filter(x => x && !x.deleted && !x.dead && x.title);
      body.innerHTML = items.map(s => {
        const discuss = `https://news.ycombinator.com/item?id=${s.id}`;
        const url = s.url || discuss;
        const id = register({ id: "hn:" + s.id, title: s.title, url, source: "Hacker News" });
        return `<li data-search="${esc(s.title)}" data-id="${esc(id)}"><div><a class="t" href="${esc(url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
          <div class="meta"><span class="mono">${nf.format(s.score || 0)} pts</span>${s.url ? `<span>${esc(host(s.url))}</span>` : ""}<a href="${discuss}" target="_blank" rel="noopener">${nf.format(s.descendants || 0)} comments</a><span>${ago(s.time * 1000)}</span></div></div>
          ${actionButtons(id, { compact: true, shareBtn: false })}</li>`;
      }).join("");
      return true;
    } catch (e) {
      console.warn("hn", e);
      errorBox(body, "Hacker News", reload);
      return false;
    }
  }

  /* ---------- Spaceflight News ---------- */
  async function spaceSection() {
    const body = $("#space-body");
    try {
      const data = await getJSON("https://api.spaceflightnewsapi.net/v4/articles/?limit=9");
      body.innerHTML = data.results.map(a => {
        const id = register({ id: "space:" + a.id, title: a.title, url: a.url, source: a.news_site });
        return `<article class="space-card" data-search="${esc(a.title + " " + a.summary)}" data-id="${esc(id)}">
          <a class="img" href="${esc(a.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${a.image_url ? `<img src="${esc(a.image_url)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</a>
          <div class="body"><span class="src">${esc(a.news_site)} · ${ago(a.published_at)}</span>
          <h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
          <p>${esc(a.summary)}</p>
          <div class="card-foot"><span></span><span class="row">${actionButtons(id, { compact: true })}</span></div></div>
        </article>`;
      }).join("");
      return true;
    } catch (e) {
      console.warn("space", e);
      errorBox(body, "Spaceflight News", reload);
      return false;
    }
  }

  /* ---------- Florida Man ---------- */
  const FM_BLOCK = /murder|kill|dead|death|die[sd]?\b|shot|shoot|stab|rape|sex|child|abus|assault|porn|molest|gun|weapon|body|corpse|overdose|suicide|fatal|crash|victim|teen|girl|boy|baby|infant/i;
  const fm = { list: [], i: 0 };

  async function weirdSection() {
    const body = $("#weird-body");
    try {
      const now = new Date();
      const list = await getJSON(`https://juliayxhuang.github.io/florida-man-api/api/${pad(now.getMonth() + 1)}/${pad(now.getDate())}.json`);
      fm.list = shuffle(list.filter(h => h.title && /florida man/i.test(h.title) && !FM_BLOCK.test(h.title)));
      fm.i = 0;
      drawFm();
      return true;
    } catch (e) {
      console.warn("fm", e);
      errorBox(body, "the Florida Man archive", reload);
      return false;
    }
  }

  function drawFm() {
    const body = $("#weird-body");
    if (!fm.list.length) { body.innerHTML = `<p class="muted">Florida Man is having a quiet day.</p>`; return; }
    const h = fm.list[fm.i % fm.list.length];
    const yr = (h.date || "").slice(0, 4);
    const id = register({ id: "fm:" + h.url, title: h.title, url: h.url, source: "Florida Man · " + (h.source || "") });
    body.innerHTML = `<span class="fm-year">${yr ? `${esc(yr)} · ` : ""}${esc(h.source || "")}</span>
      <blockquote data-search="${esc(h.title)}"><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a></blockquote>
      <div class="row"><button class="btn" type="button" id="fm-next">Another one</button>${actionButtons(id, { compact: true })}
      <span class="muted small mono">${(fm.i % fm.list.length) + 1} of ${fm.list.length} on this date</span></div>`;
    $("#fm-next").addEventListener("click", () => { fm.i++; drawFm(); $("#weird-body blockquote").classList.add("pop"); });
  }

  /* ---------- Weather (Open-Meteo) ---------- */
  const WX = [
    [[0], "Clear", "sun"], [[1, 2], "Partly cloudy", "partly"], [[3], "Cloudy", "cloud"], [[45, 48], "Foggy", "fog"],
    [[51, 53, 55, 56, 57], "Drizzle", "rain"], [[61, 63, 65, 66, 67, 80, 81, 82], "Rain", "rain"],
    [[71, 73, 75, 77, 85, 86], "Snow", "snow"], [[95, 96, 99], "Thunderstorms", "storm"],
  ];
  const wxInfo = c => { const m = WX.find(w => w[0].includes(c)); return m ? { label: m[1], icon: m[2] } : { label: "Mixed", icon: "cloud" }; };
  const WX_ICON = {
    sun: '<circle cx="32" cy="32" r="12" fill="var(--sun)"/><g stroke="var(--sun)" stroke-width="4" stroke-linecap="round"><path d="M32 6v6M32 52v6M6 32h6M52 32h6M13.6 13.6l4.2 4.2M46.2 46.2l4.2 4.2M13.6 50.4l4.2-4.2M46.2 17.8l4.2-4.2"/></g>',
    partly: '<circle cx="24" cy="24" r="10" fill="var(--sun)"/><path d="M20 50h26a10 10 0 0 0 0-20 14 14 0 0 0-26 4 8 8 0 0 0 0 16z" fill="var(--surface-2)" stroke="var(--ink)" stroke-width="3"/>',
    cloud: '<path d="M16 48h30a11 11 0 0 0 0-22 15 15 0 0 0-29 4 9 9 0 0 0-1 18z" fill="var(--surface-2)" stroke="var(--ink)" stroke-width="3"/>',
    fog: '<g stroke="var(--muted)" stroke-width="4" stroke-linecap="round"><path d="M10 24h44M14 34h36M10 44h44"/></g>',
    rain: '<path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4 8 8 0 0 0-3 16z" fill="var(--surface-2)" stroke="var(--ink)" stroke-width="3"/><g stroke="var(--world)" stroke-width="4" stroke-linecap="round"><path d="M22 46l-3 8M33 46l-3 8M44 46l-3 8"/></g>',
    snow: '<path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4 8 8 0 0 0-3 16z" fill="var(--surface-2)" stroke="var(--ink)" stroke-width="3"/><g fill="var(--world)"><circle cx="21" cy="50" r="3"/><circle cx="32" cy="54" r="3"/><circle cx="43" cy="50" r="3"/></g>',
    storm: '<path d="M16 38h30a10 10 0 0 0 0-20 14 14 0 0 0-27 4 8 8 0 0 0-3 16z" fill="var(--surface-2)" stroke="var(--ink)" stroke-width="3"/><path d="M34 40l-8 12h7l-3 9 10-14h-7l3-7z" fill="var(--sun)"/>',
  };
  const useF = () => store.get("units", /US|LR|MM/.test(navigator.language.split("-")[1] || "") ? "F" : "C") === "F";

  async function loadWeather(loc) {
    const body = $("#weather-body");
    body.innerHTML = `<div class="skeleton-block" style="min-height:120px"></div>`;
    try {
      const f = useF();
      const q = `latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto` +
        (f ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
      const w = await getJSON(`https://api.open-meteo.com/v1/forecast?${q}`);
      const c = w.current, info = wxInfo(c.weather_code), u = f ? "°F" : "°C";
      const days = w.daily.time.map((t, i) => ({ t, hi: w.daily.temperature_2m_max[i], lo: w.daily.temperature_2m_min[i], code: w.daily.weather_code[i] }));
      body.innerHTML = `<div class="weather-now"><svg viewBox="0 0 64 64" aria-hidden="true">${WX_ICON[info.icon]}</svg>
          <div><div class="weather-temp mono">${Math.round(c.temperature_2m)}${u}</div><div class="weather-meta">${info.label} · feels ${Math.round(c.apparent_temperature)}° · ${esc(loc.name)}</div></div></div>
        <div class="weather-days">${days.map((d, i) => `<div><span>${i === 0 ? "Today" : new Date(d.t + "T12:00").toLocaleDateString(undefined, { weekday: "short" })}</span><b>${Math.round(d.hi)}°</b><span class="muted">${Math.round(d.lo)}°</span></div>`).join("")}</div>
        <p class="small" style="margin:10px 0 0;display:flex;gap:12px"><button class="link-btn" type="button" id="wx-units">Show ${f ? "°C" : "°F"}</button><button class="link-btn" type="button" id="wx-change">Change place</button></p>`;
      $("#wx-units").addEventListener("click", () => { store.set("units", f ? "C" : "F"); loadWeather(loc); });
      $("#wx-change").addEventListener("click", () => { store.set("place", null); resetWeather(); });
    } catch (e) {
      console.warn("weather", e);
      body.innerHTML = `<p class="muted small">Weather is unavailable right now.</p>`;
    }
  }

  let weatherTemplate = "";
  function resetWeather() {
    $("#weather-body").innerHTML = weatherTemplate;
    bindWeatherForm();
  }
  function bindWeatherForm() {
    $("#weather-locate")?.addEventListener("click", () => {
      if (!navigator.geolocation) { toast("Location isn't available here. Type a city instead."); return; }
      navigator.geolocation.getCurrentPosition(p => {
        const loc = { lat: p.coords.latitude.toFixed(3), lon: p.coords.longitude.toFixed(3), name: "Your location" };
        store.set("place", loc); loadWeather(loc);
      }, () => toast("Location was blocked. Type a city instead."), { timeout: 10000 });
    });
    $("#weather-form")?.addEventListener("submit", async e => {
      e.preventDefault();
      const name = $("#weather-city").value.trim();
      if (!name) return;
      try {
        const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en`);
        const r = g.results?.[0];
        if (!r) { toast(`Couldn't find "${name}". Check the spelling.`); return; }
        const loc = { lat: r.latitude, lon: r.longitude, name: r.name + (r.admin1 ? ", " + r.admin1 : "") };
        store.set("place", loc); loadWeather(loc);
      } catch { toast("City search is unavailable right now."); }
    });
  }
  function initWeather() {
    weatherTemplate = $("#weather-body").innerHTML;
    bindWeatherForm();
    const place = store.get("place", null);
    if (place) loadWeather(place);
  }

  /* ---------- Search ---------- */
  function applySearch() {
    const q = $("#search").value.trim().toLowerCase();
    let hits = 0;
    $$("[data-search]").forEach(el => {
      const show = !q || el.dataset.search.toLowerCase().includes(q);
      el.classList.toggle("search-hide", !show);
      if (show && q) hits++;
    });
    $$(".wire-group").forEach(g => g.classList.toggle("search-hide", !!q && !$(".wire-item:not(.search-hide)", g)));
    document.body.classList.toggle("searching", !!q);
    $("#no-results").hidden = !q || hits > 0;
  }
  function initSearch() {
    const input = $("#search");
    input.addEventListener("input", applySearch);
    document.addEventListener("keydown", e => {
      if (e.key === "/" && !e.target.matches("input, textarea")) { e.preventDefault(); input.focus(); }
      if (e.key === "Escape" && document.activeElement === input) { input.value = ""; applySearch(); input.blur(); }
    });
  }

  /* ---------- Surprise me ---------- */
  function surprise() {
    const els = $$("[data-id]").filter(el => !el.classList.contains("search-hide") && el.offsetParent);
    if (!els.length) { toast("Stories are still loading"); return; }
    const el = els[Math.floor(Math.random() * els.length)];
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    toast("Here's one you might have missed");
  }

  /* ---------- Load + refresh ---------- */
  let loadedAt = 0, loading = false;
  async function reload() {
    if (loading) return;
    loading = true;
    $("#refresh-btn").classList.add("spinning");
    setEdition(null);
    const results = await Promise.all([feedSections(), wireSection(), techSection(), spaceSection(), weirdSection()]);
    loadedAt = Date.now();
    setEdition(new Date(loadedAt));
    initStreak();
    applySearch();
    $("#refresh-btn").classList.remove("spinning");
    loading = false;
    if (results.every(r => !r)) toast("You might be offline. We'll try again soon.");
  }

  function init() {
    initTheme();
    setEdition(null);
    initStreak();
    renderSaved();
    initBriefControls();
    initSearch();
    initWeather();
    $("#refresh-btn").addEventListener("click", () => reload().then(() => toast("You're up to date")));
    $("#surprise-btn").addEventListener("click", surprise);
    $("#history-more").addEventListener("click", () => { historyShown += 10; drawHistory(); applySearch(); });
    const drawer = $("#saved-drawer");
    $("#saved-btn").addEventListener("click", () => { renderSaved(); drawer.showModal(); });
    $("#saved-close").addEventListener("click", () => drawer.close());
    drawer.addEventListener("click", e => { if (e.target === drawer) drawer.close(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - loadedAt > REFRESH_MS) reload(); });
    setInterval(() => { if (!document.hidden && Date.now() - loadedAt > REFRESH_MS) reload(); }, 60 * 1000);
    reload();
  }

  init();
})();
