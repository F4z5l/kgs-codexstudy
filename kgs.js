/* Khan Global Studies live API + in-app classroom (subjects -> lectures -> player). */
(function () {
  "use strict";

  const API_BASE = "https://apicf.udemylover.workers.dev";
  const PROXY_BASE = "/api/kgs"; // optional Vercel fallback (api/kgs.js) if the browser is blocked by CORS
  const PAGE_LIMIT = 50;
  const HLS_FALLBACK_SRC = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js";
  const SPEED_KEY = "codex-studys-speed";

  const memo = new Map();
  let preferProxy = false;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const safeUrl = (u) => {
    try { const x = new URL(String(u || ""), location.href); return /^https?:$/.test(x.protocol) ? x.href : ""; }
    catch (e) { return ""; }
  };
  const $ = (sel, root) => (root || document).querySelector(sel);
  const fmtDate = (v) => {
    const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  let toastTimer;
  function toast(msg) {
    let t = $(".kgs-toast");
    if (!t) { t = document.createElement("div"); t.className = "kgs-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3200);
  }

  /* ---------- API ---------- */
  async function fetchJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json, text/plain, */*" }, signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = JSON.parse(await res.text());
      if (json && typeof json === "object" && "success" in json) {
        if (!json.success) throw new Error(json.message || "API error");
        return json.data;
      }
      return json;
    } finally { clearTimeout(timer); }
  }

  async function api(path) {
    if (memo.has(path)) return memo.get(path);
    let data;
    const direct = () => fetchJson(API_BASE + path);
    const proxy = () => fetchJson(PROXY_BASE + "?path=" + encodeURIComponent(path));
    if (preferProxy) {
      try { data = await proxy(); } catch (e) { data = await direct(); }
    } else {
      try { data = await direct(); }
      catch (e) { data = await proxy(); preferProxy = true; } // throws if both fail
    }
    memo.set(path, data);
    return data;
  }

  async function fetchBatchPage(page) {
    const data = await api("/api/courses/?page_id=" + encodeURIComponent(page) + "&batch_id=0&limit=" + PAGE_LIMIT);
    return { total: Number(data && data.total) || 0, items: Array.isArray(data && data.items) ? data.items : [] };
  }

  /* ---------- view state ---------- */
  const S = { batch: null, detail: null, room: null, list: null, level: 0, pushed: 0, token: 0, tab: "videos", hls: null, sources: null, videoId: null, retries: 0 };
  let view, bodyEl;

  function ensureView() {
    if (view) return;
    view = document.createElement("div");
    view.className = "kgs-view";
    view.hidden = true;
    view.setAttribute("role", "dialog");
    view.setAttribute("aria-modal", "true");
    view.innerHTML =
      '<div class="kgs-bar">' +
      '<button class="kgs-iconbtn" data-act="back" type="button" aria-label="Back">←</button>' +
      '<div class="kgs-crumb"><b id="kgsTitle"></b><span id="kgsSub"></span></div>' +
      '<button class="kgs-iconbtn" data-act="close" type="button" aria-label="Close">✕</button>' +
      "</div>" +
      '<div class="kgs-body" id="kgsBody"></div>';
    document.body.appendChild(view);
    bodyEl = $("#kgsBody", view);
    view.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    document.addEventListener("keydown", onKey, true);
  }

  const setBar = (title, sub) => { $("#kgsTitle", view).textContent = title || ""; $("#kgsSub", view).textContent = sub || ""; };
  const loadingHtml = (t) => '<div class="kgs-msg"><div class="spin"></div><div>' + esc(t || "Loading…") + "</div></div>";
  const errorHtml = (t, act) => '<div class="kgs-msg"><div>' + esc(t) + '</div><button class="kgs-btn" type="button" data-act="' + act + '">Try again</button></div>';

  function push(level) {
    S.level = level;
    history.pushState({ kgs: level }, "");
    S.pushed++;
  }

  function onPop() {
    if (!view || view.hidden) return;
    const lvl = (history.state && history.state.kgs) || 0;
    if (!lvl) { hide(); return; }
    S.pushed = lvl;
    show(lvl);
  }

  function onKey(e) {
    if (!view || view.hidden) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (e.key === "Escape") { e.stopPropagation(); back(); return; }
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const k = e.key.toLowerCase();
    if (["f", "t", "/", "?"].includes(k)) e.stopPropagation(); // keep the page's shortcuts from firing behind the player
    const v = $("#kgsVideo");
    if (S.level !== 3 || !v) return;
    if (k === "f") { const st = $(".kgs-stage", view); if (document.fullscreenElement) document.exitFullscreen(); else if (st && st.requestFullscreen) st.requestFullscreen(); }
    else if (e.key === "ArrowLeft") { v.currentTime = Math.max(0, v.currentTime - 10); e.preventDefault(); }
    else if (e.key === "ArrowRight") { v.currentTime = v.currentTime + 10; e.preventDefault(); }
    else if (k === " " && tag !== "VIDEO" && tag !== "BUTTON") { v.paused ? v.play().catch(() => {}) : v.pause(); e.preventDefault(); }
  }

  function back() {
    if (S.level <= 1) { close(); return; }
    history.back();
  }

  function close() {
    if (S.pushed > 0) history.go(-S.pushed);
    else hide();
  }

  function hide() {
    destroyPlayer();
    S.token++;
    S.level = 0; S.pushed = 0;
    if (view) view.hidden = true;
    document.body.style.overflow = "";
  }

  function show(level) {
    if (level !== 3) destroyPlayer();
    S.level = level;
    if (level === 1) showSubjects();
    else if (level === 2) showLectures();
    else if (level === 3) showPlayer(S.videoId, true);
  }

  /* ---------- level 1: subjects ---------- */
  function openBatch(batch) {
    ensureView();
    S.batch = batch; S.detail = null; S.room = null; S.list = null; S.videoId = null; S.tab = "videos"; S.pushed = 0;
    view.hidden = false;
    document.body.style.overflow = "hidden";
    push(1);
    showSubjects();
  }

  async function showSubjects() {
    const tok = ++S.token;
    setBar(S.batch.name, "Subjects");
    if (S.detail) { renderSubjects(); return; }
    bodyEl.innerHTML = loadingHtml("Loading subjects…");
    try {
      const d = await api("/api/courses/" + encodeURIComponent(S.batch.slug));
      if (tok !== S.token) return;
      S.detail = d;
      renderSubjects();
    } catch (e) {
      if (tok !== S.token) return;
      bodyEl.innerHTML = errorHtml("Couldn't load this batch. Check your connection and try again.", "retry-subjects");
    }
  }

  function renderSubjects() {
    const d = S.detail || {};
    const rooms = Array.isArray(d.classrooms) ? d.classrooms : [];
    const teachers = (Array.isArray(d.teachers) ? d.teachers : []).map((t) => (t && (t.name || t.title)) || (typeof t === "string" ? t : "")).filter(Boolean).slice(0, 4).join(", ");
    const img = safeUrl(d.image || S.batch.previewImage);
    const price = d.price != null && d.price !== "" ? (Number(d.price) === 0 ? "Free" : "₹" + d.price) : "";
    let html = '<div class="kgs-wrap"><div class="kgs-hero">' +
      (img ? '<img src="' + esc(img) + '" alt="" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">' : "") +
      "<div><h2>" + esc(d.title || S.batch.name) + "</h2><p>" + esc([price, teachers, rooms.length + " subjects"].filter(Boolean).join(" · ")) + "</p></div></div>";
    html += '<div class="kgs-sec">Subjects</div>';
    if (!rooms.length) html += '<div class="kgs-msg">No subjects have been published for this batch yet.</div>';
    else {
      html += '<div class="kgs-list">' + rooms.map((r, i) =>
        '<button class="kgs-row" type="button" data-room="' + i + '"><span class="ico">📚</span><span class="txt"><b>' + esc(r.name || "Subject") + "</b><small>🎬 " + (Number(r.video) || 0) + " lectures · 📄 " + (Number(r.note) || 0) + ' notes</small></span><span class="go">›</span></button>').join("") + "</div>";
    }
    bodyEl.innerHTML = html + "</div>";
    bodyEl.scrollTop = 0;
  }

  /* ---------- level 2: lectures + notes ---------- */
  function openRoom(room) {
    S.room = room; S.list = null; S.tab = "videos";
    push(2);
    showLectures();
  }

  async function showLectures() {
    const tok = ++S.token;
    setBar(S.room.name, S.batch.name);
    if (S.list) { renderLectures(); return; }
    bodyEl.innerHTML = loadingHtml("Loading lectures…");
    try {
      const courseId = (S.detail && S.detail.id) || S.batch.id;
      const d = await api("/api/courses/" + encodeURIComponent(courseId) + "/" + encodeURIComponent(S.room.id));
      if (tok !== S.token) return;
      S.list = { videos: Array.isArray(d && d.videos) ? d.videos : [], notes: Array.isArray(d && d.notes) ? d.notes : [] };
      renderLectures();
    } catch (e) {
      if (tok !== S.token) return;
      bodyEl.innerHTML = errorHtml("Couldn't load lectures for this subject.", "retry-lectures");
    }
  }

  function lectureRow(v, active) {
    const th = safeUrl(v.thumb);
    return '<button class="kgs-row' + (active ? " active" : "") + '" type="button" data-video="' + esc(v.id) + '">' +
      (th ? '<img class="thumb" src="' + esc(th) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<span class=&quot;thumb-ph&quot;>▶</span>\'">' : '<span class="thumb-ph">▶</span>') +
      '<span class="txt"><b>' + esc(v.name || "Lecture") + "</b><small>" + esc(fmtDate(v.published_at)) + '</small></span><span class="go">▶</span></button>';
  }

  function renderLectures() {
    const { videos, notes } = S.list;
    let html = '<div class="kgs-wrap"><div class="kgs-tabs">' +
      '<button class="kgs-tab' + (S.tab === "videos" ? " active" : "") + '" data-tab="videos" type="button">🎬 Lectures (' + videos.length + ")</button>" +
      '<button class="kgs-tab' + (S.tab === "notes" ? " active" : "") + '" data-tab="notes" type="button">📄 Notes (' + notes.length + ")</button></div>";
    if (S.tab === "videos") {
      html += videos.length ? '<div class="kgs-list">' + videos.map((v) => lectureRow(v, false)).join("") + "</div>" : '<div class="kgs-msg">No lectures in this subject yet.</div>';
    } else {
      html += notes.length ? '<div class="kgs-list">' + notes.map((n) =>
        '<button class="kgs-row" type="button" data-note="' + esc(n.id) + '" data-name="' + esc(n.name || "Notes") + '"><span class="ico">📄</span><span class="txt"><b>' + esc(n.name || "Notes") + "</b><small>" + esc(String(n.type || "pdf").toUpperCase()) + '</small></span><span class="go">↗</span></button>').join("") + "</div>" : '<div class="kgs-msg">No notes in this subject yet.</div>';
    }
    bodyEl.innerHTML = html + "</div>";
    bodyEl.scrollTop = 0;
  }

  /* ---------- notes (PDF) ---------- */
  function collectPdfs(d) {
    const out = [];
    if (d && Array.isArray(d.pdfs)) d.pdfs.forEach((p) => { const u = safeUrl(p && (p.url || p.link)); if (u) out.push({ title: (p && p.title) || "PDF", url: u }); });
    ["pdf_url", "pdf", "file", "url", "note_url"].forEach((k) => { const u = d && typeof d[k] === "string" ? safeUrl(d[k]) : ""; if (u && /\.pdf(\?|$)/i.test(u) && !out.some((o) => o.url === u)) out.push({ title: "PDF", url: u }); });
    return out;
  }

  async function openNote(id, name) {
    const w = window.open("about:blank", "_blank");
    try {
      const d = await api("/api/courses/video/" + encodeURIComponent(id));
      const pdfs = collectPdfs(d);
      if (!pdfs.length) throw new Error("no pdf");
      if (w) { w.opener = null; w.location.href = pdfs[0].url; }
      else toast("Pop-up blocked — allow pop-ups to open the PDF.");
    } catch (e) {
      if (w) w.close();
      toast("Couldn't find a PDF link for “" + (name || "this note") + "”.");
    }
  }

  /* ---------- level 3: player ---------- */
  function openVideo(id) {
    S.videoId = id;
    push(3);
    showPlayer(id, false);
  }

  function findVideo(id) { return (S.list.videos || []).find((v) => String(v.id) === String(id)); }

  function destroyPlayer() {
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    const v = $("#kgsVideo");
    if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} }
    S.sources = null;
  }

  async function showPlayer(id, keepScroll) {
    destroyPlayer();
    const tok = ++S.token;
    S.videoId = id;
    const meta = findVideo(id) || { id, name: "Lecture" };
    setBar(meta.name, S.room ? S.room.name : "");
    const savedSpeed = localStorage.getItem(SPEED_KEY) || "1";
    const speeds = ["0.5", "0.75", "1", "1.25", "1.5", "1.75", "2"];
    const poster = safeUrl(meta.thumb);
    bodyEl.innerHTML =
      '<div class="kgs-wrap kgs-player"><div>' +
      '<div class="kgs-stage"><video id="kgsVideo" controls playsinline preload="metadata"' + (poster ? ' poster="' + esc(poster) + '"' : "") + '></video><div class="kgs-stage-msg" id="kgsStageMsg"><div class="spin" style="width:26px;height:26px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:kgs-spin .8s linear infinite"></div><div>Loading stream…</div></div></div>' +
      '<div class="kgs-pmeta"><h2>' + esc(meta.name) + "</h2>" +
      '<div class="kgs-ctrls"><label>Speed <select id="kgsSpeed">' + speeds.map((s) => '<option value="' + s + '"' + (s === savedSpeed ? " selected" : "") + ">" + s + "×</option>").join("") + "</select></label>" +
      '<label>Quality <select id="kgsQuality" disabled><option>—</option></select></label>' +
      '<button class="kgs-btn quiet" type="button" data-act="rew">⏪ 10s</button><button class="kgs-btn quiet" type="button" data-act="fwd">10s ⏩</button></div>' +
      '<div class="kgs-files" id="kgsFiles"></div></div></div>' +
      '<aside class="kgs-next"><h3>' + esc(S.room ? S.room.name : "Lectures") + '</h3><div class="kgs-list">' + (S.list.videos || []).map((v) => lectureRow(v, String(v.id) === String(id))).join("") + "</div></aside></div>";
    if (!keepScroll) bodyEl.scrollTop = 0;
    const active = $(".kgs-next .kgs-row.active", bodyEl);
    if (active) active.scrollIntoView({ block: "nearest" });

    const v = $("#kgsVideo");
    v.addEventListener("ended", () => playNext());
    v.addEventListener("error", () => { if (!S.hls && v.getAttribute("src")) stageMsg("This stream couldn't be played. Try another quality or lecture."); });
    $("#kgsSpeed").addEventListener("change", (e) => { localStorage.setItem(SPEED_KEY, e.target.value); v.playbackRate = Number(e.target.value); });
    $("#kgsQuality").addEventListener("change", (e) => switchQuality(e.target.value));

    try {
      const d = await api("/api/courses/video/" + encodeURIComponent(id));
      if (tok !== S.token) return;
      setupSources(d);
    } catch (e) {
      if (tok !== S.token) return;
      stageMsg("Couldn't load this lecture.", "retry-video");
    }
  }

  function stageMsg(text, retryAct) {
    const m = $("#kgsStageMsg");
    if (!m) return;
    m.hidden = !text;
    m.style.pointerEvents = retryAct ? "auto" : "none";
    m.innerHTML = text ? "<div>" + esc(text) + "</div>" + (retryAct ? '<button class="kgs-btn" type="button" data-act="' + retryAct + '">Try again</button>' : "") : "";
  }

  function playNext() {
    const vids = (S.list && S.list.videos) || [];
    const i = vids.findIndex((v) => String(v.id) === String(S.videoId));
    if (i >= 0 && i < vids.length - 1) { history.replaceState({ kgs: 3 }, ""); showPlayer(vids[i + 1].id, false); }
  }

  function setupSources(d) {
    const main = safeUrl(d && (d.video_url || d.hls_url || d.url));
    const mp4s = Object.entries((d && d.mp4s && typeof d.mp4s === "object") ? d.mp4s : {})
      .map(([q, u]) => ({ q, url: safeUrl(u) })).filter((x) => x.url)
      .sort((a, b) => parseInt(a.q, 10) - parseInt(b.q, 10));
    const isHls = !!main && /\.m3u8(\?|$)/i.test(main);
    S.sources = { hls: isHls ? main : "", direct: main && !isHls ? main : "", mp4s, mode: "", retries: 0 };

    // attachments
    const files = $("#kgsFiles");
    const pdfs = collectPdfs(d);
    files.innerHTML =
      pdfs.map((p, i) => '<a class="kgs-btn" target="_blank" rel="noopener" href="' + esc(p.url) + '">📄 ' + esc(pdfs.length > 1 ? p.title || "PDF " + (i + 1) : p.title || "Notes PDF") + "</a>").join("") +
      mp4s.map((m) => '<a class="kgs-btn quiet" target="_blank" rel="noopener" download href="' + esc(m.url) + '">⬇ ' + esc(m.q) + " MP4</a>").join("");

    fillQuality([]);
    if (!S.sources.hls && !S.sources.direct && !mp4s.length) { stageMsg(pdfs.length ? "No video for this item — notes are available below." : "No playable stream was returned for this lecture."); return; }
    startBest(0, true);
  }

  function fillQuality(levels, current) {
    const sel = $("#kgsQuality");
    if (!sel) return;
    const s = S.sources;
    const opts = [];
    if (s.hls) { opts.push(["hls:-1", "Auto"]); levels.forEach((l, i) => opts.push(["hls:" + i, (l.height ? l.height + "p" : Math.round(l.bitrate / 1000) + "kbps")])); }
    if (s.direct) opts.push(["direct", "Original"]);
    s.mp4s.forEach((m) => opts.push(["mp4:" + m.q, m.q + " · MP4"]));
    sel.innerHTML = opts.map(([v, t]) => '<option value="' + esc(v) + '">' + esc(t) + "</option>").join("");
    sel.disabled = opts.length < 2;
    if (current && opts.some((o) => o[0] === current)) sel.value = current;
  }

  function ensureHls() {
    if (window.Hls) return Promise.resolve(true);
    return new Promise((resolve) => {
      const el = document.createElement("script");
      el.src = HLS_FALLBACK_SRC;
      el.onload = () => resolve(!!window.Hls);
      el.onerror = () => resolve(false);
      document.head.appendChild(el);
    });
  }

  function startBest(resumeAt, autoplay) {
    const s = S.sources;
    if (s.hls) return startHls(resumeAt, autoplay);
    if (s.direct) return startFile(s.direct, "direct", resumeAt, autoplay);
    const best = s.mp4s[s.mp4s.length - 1];
    return startFile(best.url, "mp4:" + best.q, resumeAt, autoplay);
  }

  function applyStart(v, resumeAt, autoplay) {
    const go = () => {
      if (resumeAt > 0) { try { v.currentTime = resumeAt; } catch (e) {} }
      v.playbackRate = Number(localStorage.getItem(SPEED_KEY) || 1);
      stageMsg("");
      if (autoplay) v.play().catch(() => {});
    };
    if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
  }

  function startFile(url, choice, resumeAt, autoplay) {
    const v = $("#kgsVideo");
    if (!v) return;
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    S.sources.mode = choice;
    v.src = url;
    v.load();
    applyStart(v, resumeAt, autoplay);
    fillQuality(S.sources._levels || [], choice);
  }

  async function startHls(resumeAt, autoplay) {
    const v = $("#kgsVideo");
    if (!v) return;
    const tok = S.token;
    const url = S.sources.hls;
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    S.sources.mode = "hls:-1";
    const hlsOk = await ensureHls();
    if (tok !== S.token) return;
    if (hlsOk && window.Hls.isSupported()) {
      const hls = new window.Hls({ enableWorker: true, maxBufferLength: 40, startLevel: -1 });
      S.hls = hls;
      hls.loadSource(url);
      hls.attachMedia(v);
      hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
        S.sources._levels = data.levels || [];
        const pl = S.sources.pendingLevel;
        S.sources.pendingLevel = null;
        if (pl != null && pl >= 0 && pl < S.sources._levels.length) { hls.currentLevel = pl; S.sources.mode = "hls:" + pl; }
        fillQuality(S.sources._levels, S.sources.mode);
        applyStart(v, resumeAt, autoplay);
      });
      hls.on(window.Hls.Events.ERROR, (_e, err) => {
        if (!err.fatal) return;
        if (err.type === window.Hls.ErrorTypes.NETWORK_ERROR && S.sources.retries < 2) { S.sources.retries++; hls.startLoad(); return; }
        if (err.type === window.Hls.ErrorTypes.MEDIA_ERROR && S.sources.retries < 2) { S.sources.retries++; hls.recoverMediaError(); return; }
        fallbackFromHls(v.currentTime, !v.paused);
      });
    } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
      S.sources.mode = "hls:-1";
      v.src = url;
      v.load();
      applyStart(v, resumeAt, autoplay);
      fillQuality([], "hls:-1");
    } else {
      fallbackFromHls(resumeAt, autoplay);
    }
  }

  function fallbackFromHls(resumeAt, autoplay) {
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    const s = S.sources;
    const best = s && s.mp4s[s.mp4s.length - 1];
    if (best) { toast("Live stream failed — switched to " + best.q + " MP4."); s.hls = ""; startFile(best.url, "mp4:" + best.q, resumeAt, autoplay); }
    else stageMsg("This stream couldn't be played on your device.", "retry-video");
  }

  function switchQuality(value) {
    const s = S.sources, v = $("#kgsVideo");
    if (!s || !v) return;
    const resume = v.currentTime || 0, autoplay = !v.paused;
    if (value.startsWith("hls:")) {
      const idx = Number(value.slice(4));
      if (S.hls && s.mode.startsWith("hls:")) { S.hls.currentLevel = idx; s.mode = value; return; }
      s.pendingLevel = idx;
      startHls(resume, autoplay);
    } else if (value === "direct") startFile(s.direct, "direct", resume, autoplay);
    else { const q = value.slice(4); const m = s.mp4s.find((x) => x.q === q); if (m) startFile(m.url, value, resume, autoplay); }
  }

  /* ---------- click handling ---------- */
  function onClick(e) {
    const el = e.target.closest("[data-act],[data-room],[data-video],[data-tab],[data-note]");
    if (!el) return;
    if (el.dataset.act) {
      const a = el.dataset.act;
      if (a === "back") back();
      else if (a === "close") close();
      else if (a === "retry-subjects") showSubjects();
      else if (a === "retry-lectures") showLectures();
      else if (a === "retry-video") { memo.delete("/api/courses/video/" + encodeURIComponent(S.videoId)); showPlayer(S.videoId, true); }
      else if (a === "rew" || a === "fwd") { const v = $("#kgsVideo"); if (v) v.currentTime = Math.max(0, v.currentTime + (a === "fwd" ? 10 : -10)); }
    } else if (el.dataset.room != null) {
      const room = ((S.detail && S.detail.classrooms) || [])[Number(el.dataset.room)];
      if (room) openRoom(room);
    } else if (el.dataset.tab) {
      S.tab = el.dataset.tab; renderLectures();
    } else if (el.dataset.note) {
      openNote(el.dataset.note, el.dataset.name);
    } else if (el.dataset.video) {
      if (S.level === 3) { if (String(el.dataset.video) !== String(S.videoId)) { history.replaceState({ kgs: 3 }, ""); showPlayer(el.dataset.video, false); } }
      else openVideo(el.dataset.video);
    }
  }

  window.KGS = { fetchBatchPage, openBatch, api, PAGE_LIMIT };
})();
