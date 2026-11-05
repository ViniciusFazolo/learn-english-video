"use strict";
const $ = (s) => document.querySelector(s);
const audio = $("#audio");

const S = {
  song: null,          // {artist, track, duration, lrc, key}
  audioReady: false,
  audioUrl: null,
  lines: [],           // [{start, end, text, tokens:[...]}]
  idx: 0,
  phase: "idle",       // listening | typing | checked
  reachedEnd: false,
  tries: 0,
  offset: 0,           // ajuste fino manual (segundos), somado ao automático
  autoMap: null,       // [[tempo_na_letra, deslocamento], ...] calculado comparando os áudios
  stats: { ok: 0, total: 0, missed: [], hints: 0 },
  difficulty: "hard",
  ytdlp: false,
};

/* ---------------- utilidades ---------------- */
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function norm(w) {
  return w.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}
function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
  if (id !== "practice") document.body.classList.remove("drawer-open");
  window.scrollTo(0, 0);
}
const ICON = (n) => `<i class="ti ti-${n}"></i>`;
const MSG_ICON = { ok: "circle-check", err: "alert-circle", loading: "loader-2", info: "info-circle" };
function setMsg(el, text, cls = "") {
  el.className = "msg " + cls;
  el.innerHTML = text ? (MSG_ICON[cls] ? ICON(MSG_ICON[cls]) : "") + `<span>${escapeHtml(text)}</span>` : "";
}
function load(key, def) { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } }
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// Deslocamento total para um instante da letra: automático (mapa) + ajuste fino.
function off(t) {
  let auto = 0;
  const m = S.autoMap;
  if (m && m.length) {
    let best = m[0];
    for (const p of m) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    auto = best[1];
  }
  return auto + S.offset;
}

/* ---------------- letra LRC ---------------- */
function parseLRC(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(":", ".")), text });
  }
  out.sort((a, b) => a.t - b.t);
  const lines = [];
  out.forEach((e, i) => {
    if (!/[a-zA-Z0-9]/.test(e.text)) return; // linhas vazias/instrumentais servem só de marcação
    const next = out[i + 1] ? out[i + 1].t : e.t + 8;
    const words = e.text.split(/\s+/).length;
    const maxLen = Math.min(15, Math.max(5, words * 0.8 + 3));
    lines.push({ start: e.t, end: Math.min(next, e.t + maxLen), text: e.text });
  });
  return lines;
}

function tokenize(text) {
  // Cada token: {pre, core, post, blank}
  return text.split(/\s+/).filter(Boolean).map((w) => {
    const m = w.match(/^([^A-Za-z0-9À-ɏ]*)(.*?)([^A-Za-z0-9À-ɏ]*)$/);
    return { pre: m[1], core: m[2], post: m[3], blank: false };
  });
}

function chooseBlanks(tokens) {
  const words = tokens.filter((t) => norm(t.core));
  if (!words.length) return;
  if (S.difficulty === "hard") { words.forEach((t) => (t.blank = true)); return; }
  const n = S.difficulty === "medium" ? Math.ceil(words.length / 2) : Math.min(words.length, words.length > 6 ? 2 : 1);
  // prefere palavras mais longas (mais interessantes), com um pouco de sorte
  const ranked = [...words].sort((a, b) => (norm(b.core).length + Math.random() * 3) - (norm(a.core).length + Math.random() * 3));
  ranked.slice(0, n).forEach((t) => (t.blank = true));
}

/* ---------------- busca ---------------- */
let searchSeq = 0;
function ytId(q) {
  const m = q.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
// Miniatura (quando houver) ou um ícone no lugar.
function thumbHtml(s, icon = "music") {
  return s.thumb ? `<span class="s-thumb"><img src="${escapeHtml(s.thumb)}" alt=""></span>`
    : `<span class="s-thumb no-img">${ICON(icon)}</span>`;
}
// Só os campos que identificam a música/vídeo (sem recorde, datas etc.)
function songRef(s) {
  const out = {};
  for (const k of ["kind", "id", "vid", "artist", "track", "duration", "lrc", "videoSynced", "thumb"]) if (s[k] != null) out[k] = s[k];
  return out;
}

async function search(q) {
  const seq = ++searchSeq;
  $("#results").innerHTML = "";
  $("#videoResults").innerHTML = "";
  $("#songResultsBox").hidden = $("#videoResultsBox").hidden = true;
  const id = ytId(q);
  if (id) { setMsg($("#searchMsg"), ""); return chooseSong({ kind: "video", id, track: "Vídeo do YouTube", artist: "" }); }
  setMsg($("#searchMsg"), "Procurando músicas e vídeos…", "loading");
  const [songs, videos] = await Promise.all([searchLyrics(q, seq), searchVideos(q, seq)]);
  if (seq !== searchSeq) return;
  if (songs === null && videos === null) setMsg($("#searchMsg"), "Não consegui buscar agora (sem internet?). Tente de novo em instantes.", "err");
  else if (!songs && !videos) setMsg($("#searchMsg"), "Nada encontrado. Tente “artista + nome da música” ou cole o link de um vídeo do YouTube.", "err");
  else setMsg($("#searchMsg"), "");
}

async function searchLyrics(q, seq) {
  try {
    const r = await fetch("/api/lyrics?q=" + encodeURIComponent(q));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "erro");
    if (seq !== searchSeq) return 0;
    const synced = data.filter((d) => d.syncedLyrics && !d.instrumental).slice(0, 8);
    $("#songResultsBox").hidden = !synced.length;
    const ul = $("#results");
    for (const d of synced) {
      // letras marcadas como "video" já foram sincronizadas com o clipe
      const song = { artist: d.artistName, track: d.trackName, duration: d.duration, lrc: d.syncedLyrics,
        videoSynced: /video|vídeo|clipe/i.test(d.trackName + " " + (d.albumName || "")) };
      const li = document.createElement("li");
      li.innerHTML = `${thumbHtml(song)}<div class="s-main"><div class="t">${escapeHtml(d.trackName)}</div><div class="a">${escapeHtml(d.artistName)}${d.albumName ? " · " + escapeHtml(d.albumName) : ""}</div></div><span class="d">${d.duration ? fmtTime(d.duration) : ""}</span><span class="go">${ICON("chevron-right")}</span>`;
      li.onclick = () => chooseSong(song);
      ul.appendChild(li);
      // miniatura do vídeo que vai tocar (o mesmo que será baixado)
      if (S.ytdlp) fetch(`/api/songvideo?q=${encodeURIComponent(videoQuery(song))}&duration=${song.duration || 0}`)
        .then((r) => (r.ok ? r.json() : null)).then((v) => {
          if (!v || !v.id) return;
          song.vid = v.id; song.thumb = v.thumb;
          li.querySelector(".s-thumb").outerHTML = thumbHtml(song);
        }).catch(() => {});
    }
    return synced.length;
  } catch { return null; }
}

async function searchVideos(q, seq) {
  if (!S.ytdlp) return 0;
  try {
    const r = await fetch("/api/ytsearch?q=" + encodeURIComponent(q));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "erro");
    if (seq !== searchSeq) return 0;
    const list = data.filter((v) => !v.live).slice(0, 6);
    $("#videoResultsBox").hidden = !list.length;
    const ul = $("#videoResults");
    for (const v of list) {
      const item = { kind: "video", id: v.id, track: v.title, artist: v.channel, duration: v.duration, thumb: v.thumb };
      const li = document.createElement("li");
      li.innerHTML = `${thumbHtml(item, "brand-youtube")}<div class="s-main"><div class="t">${escapeHtml(v.title)}</div><div class="a">${escapeHtml(v.channel)}</div></div><span class="d">${v.duration ? fmtTime(v.duration) : ""}</span><span class="go">${ICON("chevron-right")}</span>`;
      li.onclick = () => chooseSong(item);
      ul.appendChild(li);
    }
    return list.length;
  } catch { return null; }
}

/* ---------------- escolha da música e do áudio ---------------- */
// Título para exibir: no YouTube o nome do canal já costuma estar no título.
const songTitle = (s) => !s.artist || s.track.toLowerCase().includes(s.artist.toLowerCase()) ? s.track : `${s.track} — ${s.artist}`;
const videoQuery = (song) => song.artist + " " + song.track + " official video";
function setCover(song) {
  $("#setup .cover").innerHTML = song.thumb ? `<img src="${escapeHtml(song.thumb)}" alt="">` : ICON(song.kind === "video" ? "brand-youtube" : "music");
}
function chooseSong(song) {
  song = songRef(song);
  song.key = song.kind === "video" ? "yt:" + song.id : (song.artist + " " + song.track).toLowerCase();
  S.song = song;
  S.audioReady = false;
  S.offset = load("manualOffsets", {})[song.key] || 0;
  S.autoMap = null;
  $("#results").innerHTML = "";
  $("#videoResults").innerHTML = "";
  $("#songResultsBox").hidden = $("#videoResultsBox").hidden = true;
  searchSeq++;
  setMsg($("#searchMsg"), "");
  setMsg($("#syncMsg"), "");
  setCover(song);
  $("#fileLink").hidden = song.kind === "video";
  $("#setupEyebrow").textContent = song.kind === "video" ? "Vídeo escolhido" : "Música escolhida";
  $("#setup").hidden = false;
  $("#howto").hidden = true;
  $("#setupTitle").textContent = songTitle(song);
  $("#startBtn").disabled = true;
  updateResume();
  $("#setup").scrollIntoView({ behavior: "smooth" });
  if (S.ytdlp) (song.kind === "video" ? fetchVideo : fetchAudio)();
  else if (song.kind === "video") setMsg($("#audioMsg"), "Para usar vídeos do YouTube é preciso o yt-dlp (rode ./iniciar.sh).", "err");
  else setMsg($("#audioMsg"), "Escolha o arquivo de áudio desta música no seu computador (o download automático precisa do yt-dlp; rode ./iniciar.sh).", "err");
}

async function fetchAudio() {
  const song = S.song;
  const msg = $("#audioMsg");
  setMsg(msg, "Baixando o vídeo do YouTube… (na primeira vez pode levar alguns segundos)", "loading");
  try {
    const r = await fetch(`/api/audio?q=${encodeURIComponent(videoQuery(song))}&duration=${song.duration || 0}&id=${song.vid || ""}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (data.thumb && !song.thumb) { song.thumb = data.thumb; setCover(song); }
    if (S.song !== song) return; // usuário trocou de música
    await loadMedia(data.url);
    if (S.song !== song) return;
    setMsg(msg, `Vídeo pronto: “${data.title}”`, "ok");
    addRecent(song);
    await autoSync(song, data.file);
  } catch (e) {
    if (S.song !== song) return;
    setMsg(msg, "Não consegui baixar o vídeo: " + (e.message || e) + ". Você pode escolher um arquivo do computador.", "err");
  }
}

// Vídeo qualquer (filme, série, podcast): as frases vêm da legenda do próprio vídeo.
async function fetchVideo() {
  const song = S.song;
  const msg = $("#audioMsg");
  setMsg(msg, "Baixando o vídeo e a legenda do YouTube… (vídeos longos podem levar um tempo)", "loading");
  try {
    const r = await fetch("/api/video?id=" + song.id);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (S.song !== song) return;
    Object.assign(song, { track: data.title || song.track, artist: data.channel || song.artist, duration: data.duration,
      thumb: data.thumb, subs: data.subs, lines: data.lines });
    $("#setupTitle").textContent = songTitle(song);
    setCover(song);
    setMsg(msg, "Preparando o player…", "loading");
    if (S.song !== song) return;
    await loadMedia(data.url);
    if (S.song !== song) return;
    setMsg(msg, `Vídeo pronto · ${data.lines.length} frases`, "ok");
    setMsg($("#syncMsg"), data.subs === "manual"
      ? "Frases tiradas da legenda feita pelo próprio canal, já sincronizada com o vídeo."
      : "Frases tiradas da legenda automática do YouTube: pode ter erros e vem sem pontuação. Se uma palavra que você ouviu certo for recusada, use “Aceitar o que digitei”.",
      data.subs === "manual" ? "ok" : "info");
    addRecent(song);
  } catch (e) {
    if (S.song !== song) return;
    setMsg(msg, "Não consegui usar esse vídeo: " + (e.message || e) + ".", "err");
  }
}

// Compara o áudio do clipe com a versão do álbum (a que a letra segue) e ajusta a sincronia sozinho.
async function autoSync(song, videoFile) {
  const msg = $("#syncMsg");
  if (song.videoSynced) { setMsg(msg, "Esta letra já está sincronizada com o clipe.", "ok"); return; }
  $("#startBtn").disabled = true;
  setMsg(msg, "Sincronizando a letra com o vídeo…", "loading");
  try {
    const qs = new URLSearchParams({ artist: song.artist, track: song.track, duration: song.duration || 0, video: videoFile });
    const r = await fetch("/api/align?" + qs);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    if (S.song !== song) return;
    S.autoMap = d.map;
    const fmt = (v) => Math.abs(v).toFixed(1).replace(".", ",");
    const first = d.map[0][1];
    const changes = d.map.some((p) => Math.abs(p[1] - first) > 1);
    let text = Math.abs(first) < 0.5 ? "Letra sincronizada com o vídeo."
      : `Letra sincronizada: o vídeo tem ${fmt(first)}s ${first > 0 ? "a mais" : "a menos"} no começo.`;
    if (changes) text += " O clipe também tem cenas extras no meio da música, e isso já foi compensado.";
    setMsg(msg, text, "ok");
  } catch (e) {
    if (S.song !== song) return;
    setMsg(msg, "Não consegui sincronizar sozinho (" + (e.message || e) + "). Se a pausa vier fora de hora, ajuste em Ajustes › Sincronia.", "err");
  } finally {
    if (S.song === song) $("#startBtn").disabled = !S.audioReady;
  }
}

// Toca direto do servidor (sem carregar o arquivo inteiro antes) e confere se o navegador consegue tocar.
function loadMedia(url) {
  return new Promise((resolve, reject) => {
    const done = () => { audio.removeEventListener("loadedmetadata", ok); audio.removeEventListener("error", bad); };
    const ok = () => { done(); resolve(); };
    const bad = () => {
      done();
      S.audioReady = false;
      $("#startBtn").disabled = true;
      reject(new Error("o navegador não conseguiu tocar esse arquivo de vídeo"));
    };
    audio.addEventListener("loadedmetadata", ok);
    audio.addEventListener("error", bad);
    setAudio(url);
  });
}

function setAudio(url) {
  if (S.audioUrl && S.audioUrl.startsWith("blob:")) URL.revokeObjectURL(S.audioUrl);
  S.audioUrl = url;
  audio.src = url;
  S.audioReady = true;
  $("#startBtn").disabled = false;
}

$("#fileInput").onchange = (e) => {
  const f = e.target.files[0];
  if (!f || !S.song) return;
  setAudio(URL.createObjectURL(f));
  setMsg($("#audioMsg"), `Usando o arquivo “${f.name}”.`, "ok");
  setMsg($("#syncMsg"), "Com arquivo próprio, a sincronia é manual: ajuste em Ajustes › Sincronia se precisar.", "info");
};

/* ---------------- recentes ---------------- */
function addRecent(song) {
  const list = load("recent", []).filter((s) => s.key !== song.key);
  const old = load("recent", []).find((s) => s.key === song.key);
  list.unshift({ ...songRef(song), key: song.key, best: old?.best ?? null });
  save("recent", list.slice(0, 15));
  renderRecent();
}
function setBest(pct) {
  const list = load("recent", []);
  const it = list.find((s) => s.key === S.song.key);
  if (it && (it.best == null || pct > it.best)) { it.best = pct; save("recent", list); }
}
function renderRecent() {
  const list = load("recent", []).slice(0, 5);
  const progress = load("progress", {});
  $("#recentBox").hidden = !list.length;
  const ul = $("#recent");
  ul.innerHTML = "";
  for (const s of list) {
    const li = document.createElement("li");
    li.innerHTML = `${thumbHtml(s, s.kind === "video" ? "brand-youtube" : "music")}<div class="s-main"><div class="t">${escapeHtml(s.track)}</div><div class="a">${escapeHtml(s.artist)}</div></div>${progress[s.key] ? `<span class="badge progress">Frase ${progress[s.key].idx + 1} de ${progress[s.key].total}</span>` : ""}${s.best != null ? `<span class="badge">Recorde ${s.best}%</span>` : ""}<span class="go">${ICON("chevron-right")}</span>`;
    li.onclick = () => chooseSong(s);
    ul.appendChild(li);
  }
}

/* ---------------- progresso salvo ---------------- */
function saveProgress(idx) {
  const all = load("progress", {});
  const results = {};
  S.lines.forEach((l, i) => { if (l.result) results[i] = l.result; });
  if (!idx && !Object.keys(results).length) delete all[S.song.key];
  else all[S.song.key] = { idx: Math.min(idx, S.lines.length - 1), total: S.lines.length, results, hints: S.stats.hints,
                           difficulty: S.difficulty, speed: document.querySelector('input[name="speedSetup"]:checked').value };
  save("progress", all);
  renderRecent();
}
function clearProgress() {
  const all = load("progress", {});
  delete all[S.song.key];
  save("progress", all);
  renderRecent();
}
// Mostra "Continuar" na tela de escolha quando esta música/vídeo tem progresso salvo.
function updateResume() {
  const p = S.song && load("progress", {})[S.song.key];
  S.resume = p || null;
  $("#restartLink").hidden = !p;
  $("#startBtn").innerHTML = ICON("player-play-filled") + (p ? ` Continuar da frase ${p.idx + 1} de ${p.total}` : " Começar a praticar");
  if (!p) return;
  const pick = (name, value) => { const el = document.querySelector(`input[name="${name}"][value="${value}"]`); if (el) el.checked = true; };
  pick("difficulty", p.difficulty);
  pick("speedSetup", p.speed);
}

/* ---------------- músicas finalizadas ---------------- */
let showAllFinished = false;
// Primeira vez: quem já tinha recorde nas "recentes" foi finalizada antes desta seção existir.
if (load("finished", null) === null) {
  save("finished", load("recent", []).filter((s) => s.best != null)
    .map((s) => ({ ...s, last: s.best, times: 1, at: Date.now() })));
}
function addFinished(pct) {
  const song = S.song;
  const list = load("finished", []);
  const old = list.find((s) => s.key === song.key);
  const item = { ...songRef(song), key: song.key, best: Math.max(pct, old?.best ?? 0), last: pct, times: (old?.times || 0) + 1, at: Date.now() };
  save("finished", [item, ...list.filter((s) => s.key !== song.key)]);
  renderFinished();
}
function renderFinished() {
  const list = load("finished", []);
  $("#finishedBox").hidden = !list.length;
  $("#finishedCount").textContent = list.length;
  const ul = $("#finished");
  ul.innerHTML = "";
  const limit = showAllFinished ? list.length : 5;
  for (const s of list.slice(0, limit)) {
    const li = document.createElement("li");
    const date = new Date(s.at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
    li.innerHTML = `<span class="thumb-done">${thumbHtml(s, s.kind === "video" ? "brand-youtube" : "music")}<i class="ti ti-circle-check-filled"></i></span>
      <div class="s-main"><div class="t">${escapeHtml(s.track)}</div><div class="a">${escapeHtml(s.artist)}</div></div>
      <div class="meta">${s.times > 1 ? `${s.times} vezes · ` : ""}${date}</div>
      <span class="badge">Recorde ${s.best}%</span><span class="go">${ICON("chevron-right")}</span>`;
    li.onclick = () => chooseSong(s);
    ul.appendChild(li);
  }
  const more = $("#finishedMore");
  more.hidden = list.length <= 5;
  more.innerHTML = showAllFinished ? `${ICON("chevron-up")} Mostrar menos` : `${ICON("chevron-down")} Ver todas (${list.length})`;
}
$("#finishedMore").onclick = () => { showAllFinished = !showAllFinished; renderFinished(); };

/* ---------------- prática ---------------- */
function startPractice() {
  S.difficulty = document.querySelector('input[name="difficulty"]:checked').value;
  S.lines = (S.song.lines || parseLRC(S.song.lrc)).map((l) => {
    const tokens = tokenize(l.text);
    chooseBlanks(tokens);
    return { ...l, tokens };
  });
  if (!S.lines.length) { alert("Essa letra não tem frases utilizáveis."); return; }
  S.stats = { ok: 0, total: 0, missed: [], hints: 0 };
  // Se as frases mudaram desde que o progresso foi salvo, ele não vale mais.
  const resume = S.resume?.total === S.lines.length ? S.resume : null;
  S.resume = null;
  if (resume) {
    for (const [i, r] of Object.entries(resume.results)) S.lines[i].result = r;
    S.stats.hints = resume.hints || 0;
    recountStats();
  }
  $("#pTitle").textContent = songTitle(S.song);
  $("#prevLine").textContent = "";
  setSpeed(document.querySelector('input[name="speedSetup"]:checked').value);
  updateSync();
  show("practice");
  openDrawer(load("drawerOpen", false));
  const first = resume ? resume.idx : 0;
  const L = S.lines[first];
  audio.currentTime = first ? Math.max(0, L.start + off(L.start) - 0.3) : 0;
  goLine(first);
}

function goLine(i) {
  stopClip();
  hideClipPop();
  if (i >= S.lines.length) return finish();
  $("#prevLine").textContent = S.lines[i - 1] ? S.lines[i - 1].text : "";
  S.idx = i;
  S.tries = 0;
  S.reachedEnd = false;
  renderLine();
  $(".stage").classList.remove("checked");
  showNoteAlert();
  S.phase = "listening";
  renderLineNotes();
  setStatus("listen");
  $("#feedback").textContent = "";
  $("#feedback").className = "feedback";
  $("#explain").hidden = true;
  stopVoice();
  explainFor(i); explainFor(i + 1); // já vai preparando as explicações
  $("#checkBtn").innerHTML = `${ICON("check")} Verificar`;
  setActionsEnabled(true);
  $("#prevBtn").disabled = i === 0;
  // se o áudio já passou do início desta frase (ex.: pulou), volta um pouquinho
  const L = S.lines[i];
  if (audio.currentTime > L.end + off(L.end)) audio.currentTime = Math.max(0, L.start + off(L.start) - 0.3);
  playFade().catch(() => setStatus("blocked"));
  updateTop();
}

function renderLine() {
  const L = S.lines[S.idx];
  const box = $("#line");
  box.innerHTML = "";
  L.inputs = [];
  L.tokens.forEach((t) => {
    const span = document.createElement("span");
    span.className = "word";
    t.span = span;
    if (t.pre) span.insertAdjacentHTML("beforeend", `<span class="punct">${escapeHtml(t.pre)}</span>`);
    if (t.blank) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.autocomplete = "off";
      inp.spellcheck = false;
      inp.setAttribute("autocapitalize", "off");
      inp.maxLength = t.core.length;
      inp.style.width = `calc(${Math.max(3, t.core.length) + 1}ch + 14px)`;
      inp.token = t;
      t.input = inp;
      t.done = false;
      L.inputs.push(inp);
      span.appendChild(inp);
    } else if (t.core) {
      span.insertAdjacentHTML("beforeend", `<span class="given">${escapeHtml(t.core)}</span>`);
    }
    if (t.post) span.insertAdjacentHTML("beforeend", `<span class="punct">${escapeHtml(t.post)}</span>`);
    box.appendChild(span);
  });
  L.inputs.forEach((inp) => {
    inp.token.errors = 0;
    inp.addEventListener("keydown", (e) => onInputKey(e, inp));
    inp.addEventListener("input", () => {
      inp.classList.remove("err");
      if (norm(inp.value) === norm(inp.token.core)) acceptWord(inp);
    });
  });
  activateCurrent();
}

// Só a palavra atual fica liberada; as próximas só abrem quando ela estiver certa.
function activateCurrent() {
  const open = openInputs();
  open.forEach((inp, j) => (inp.disabled = j !== 0));
  if (open[0]) open[0].focus();
  return open[0];
}

function acceptWord(inp) {
  lockOk(inp);
  if (inp.token.errors) inp.token.result = "late";
  $("#feedback").textContent = "";
  $("#feedback").className = "feedback";
  activateCurrent();
  maybeAllDone();
}

function rejectWord(inp) {
  if (!inp.value.trim()) { shake(inp); return; }
  inp.token.errors++;
  shake(inp);
  const fb = $("#feedback");
  fb.className = "feedback err";
  fb.innerHTML = `${ICON("x")}<span>Ainda não está certa. Tente de novo, ouça outra vez ou peça uma dica.</span>`;
  const typed = inp.value.trim().replace(/\s+/g, "");
  if (S.song.kind === "video" && norm(typed)) {
    fb.insertAdjacentHTML("beforeend", `<span class="fb-break"></span><button type="button" class="btn ghost small accept-typed">${ICON("check")} A legenda errou? Aceitar “${escapeHtml(typed)}”</button>`);
    fb.querySelector(".accept-typed").onclick = () => acceptTyped(inp, typed);
  }
  inp.select();
}
// A legenda do vídeo estava errada: a palavra digitada passa a ser a certa.
function acceptTyped(inp, typed) {
  const L = S.lines[S.idx];
  inp.token.core = typed;
  inp.token.errors = 0;
  L.text = L.tokens.map((t) => t.pre + t.core + t.post).join(" ");
  L.exP = null; // explicação precisa ser refeita com o texto corrigido
  acceptWord(inp);
}
function shake(inp) { inp.classList.remove("err"); void inp.offsetWidth; inp.classList.add("err"); inp.focus(); }

function openInputs() { return S.lines[S.idx].inputs.filter((i) => !i.token.done); }
function onInputKey(e, inp) {
  if ((e.key === " " && !e.ctrlKey) || e.key === "Tab") {
    e.preventDefault();
    if (norm(inp.value) === norm(inp.token.core)) acceptWord(inp); else rejectWord(inp);
  }
}

function lockOk(inp) {
  inp.token.done = true;
  inp.token.result = "ok";
  inp.value = inp.token.core;
  inp.classList.remove("err");
  inp.classList.add("ok");
  inp.disabled = true;
}
function reveal(inp) {
  const t = inp.token;
  t.done = true;
  t.result = "miss";
  const span = document.createElement("span");
  span.className = "revealed";
  span.innerHTML = (inp.value.trim() ? `<del>${escapeHtml(inp.value.trim())}</del>` : "") + escapeHtml(t.core);
  inp.replaceWith(span);
}

function check() {
  if (S.phase === "checked") return goLine(S.idx + 1);
  const inp = openInputs()[0];
  if (!inp) return finishLine();
  if (norm(inp.value) === norm(inp.token.core)) acceptWord(inp); else rejectWord(inp);
}

function maybeAllDone() { if (S.phase !== "checked" && !openInputs().length) finishLine(); }

function finishLine() {
  const L = S.lines[S.idx];
  S.phase = "checked";
  const blanks = L.tokens.filter((t) => t.blank);
  const ok = blanks.filter((t) => t.result === "ok").length;
  L.result = { ok, total: blanks.length, missed: blanks.filter((t) => t.result !== "ok").map((t) => ({ word: t.core, line: L.text })) };
  recountStats();
  saveProgress(S.idx + 1);
  const fb = $("#feedback");
  if (ok === blanks.length) { fb.className = "feedback ok"; fb.innerHTML = ICON("circle-check") + `<span>${["Perfeito!", "Mandou bem!", "Isso aí!", "Excelente!"][Math.floor(Math.random() * 4)]}</span>`; }
  else { fb.className = "feedback warn"; fb.innerHTML = ICON("alert-circle") + `<span>De primeira você acertou ${ok} de ${blanks.length}. As respostas estão em amarelo.</span>`; }
  solidifyLine();
  highlightNotes();
  showExplain();
  $("#checkBtn").innerHTML = `Próxima frase ${ICON("arrow-right")}`;
  setActionsEnabled(false);
  $("#checkBtn").focus();
  setStatus(S.reachedEnd ? "next" : "listen");
  updateTop();
}

// O placar é a soma das frases concluídas (refazer uma frase substitui o resultado anterior).
function recountStats() {
  const done = S.lines.filter((l) => l.result).map((l) => l.result);
  S.stats.ok = done.reduce((a, r) => a + r.ok, 0);
  S.stats.total = done.reduce((a, r) => a + r.total, 0);
  S.stats.missed = done.flatMap((r) => r.missed);
}

// Volta para a frase anterior e deixa você fazer de novo.
function prevLine() {
  if (S.idx === 0 || !S.lines.length) return;
  const L = S.lines[S.idx - 1];
  delete L.result;
  L.tokens = tokenize(L.text);
  chooseBlanks(L.tokens);
  recountStats();
  audio.pause();
  audio.currentTime = Math.max(0, L.start + off(L.start) - 0.3);
  goLine(S.idx - 1);
  saveProgress(S.idx);
}

function replay() {
  const L = S.lines[S.idx];
  if (!L) return;
  stopClip(false);
  S.reachedEnd = false;
  if (S.phase === "typing") S.phase = "listening";
  audio.currentTime = Math.max(0, L.start + off(L.start) - 0.35);
  playFade();
  setStatus(S.phase === "checked" ? "next" : "listen");
  const f = openInputs()[0];
  if (f) f.focus();
}

function hint() {
  if (S.phase === "checked") return;
  const inp = openInputs()[0];
  if (!inp) return;
  const target = inp.token.core;
  const typed = inp.value;
  let n = 0;
  while (n < typed.length && n < target.length && typed[n].toLowerCase() === target[n].toLowerCase()) n++;
  inp.value = target.slice(0, n + 1);
  inp.focus();
  S.stats.hints++;
  inp.token.errors++; // usou dica: não conta como acerto de primeira
  if (norm(inp.value) === norm(target)) acceptWord(inp);
}

function skip() {
  if (S.phase === "checked") return goLine(S.idx + 1);
  openInputs().forEach(reveal);
  finishLine();
}

const STATUS = {
  listen: '<span class="eq"><i></i><i></i><i></i></span> Ouça a frase…',
  type: `${ICON("keyboard")} Sua vez! Escreva o que você ouviu`,
  next: `${ICON("circle-check")} Pressione Enter para a próxima frase`,
  blocked: `${ICON("player-play")} Clique em “Ouvir de novo” para tocar`,
};
function setStatus(mode) {
  const st = $("#status");
  st.innerHTML = STATUS[mode] || "";
  st.className = "status " + mode;
}
// Dica / mostrar resposta / pular só fazem sentido enquanto a frase não foi concluída
function setActionsEnabled(on) {
  for (const id of ["#hintBtn", "#revealBtn", "#skipBtn"]) $(id).disabled = !on;
}

function updateTop() {
  $("#pProgress").textContent = `Frase ${S.idx + 1} de ${S.lines.length}`;
  $("#pScore").textContent = `${S.stats.ok} / ${S.stats.total}`;
  $("#progressFill").style.width = `${(S.idx / S.lines.length) * 100}%`;
}

// laço que pausa a música no fim de cada frase
// fade: o volume desce suavemente antes da pausa e sobe ao voltar a tocar
const FADE_OUT = 0.6; // segundos de música antes do fim da frase
const FADE_IN = 400;  // ms ao retomar
let fadeInStart = 0;
function playFade() {
  if (audio.paused) { fadeInStart = performance.now(); audio.volume = 0; }
  return audio.play();
}

function tick() {
  if (!$("#practice").hidden && S.lines[S.idx] && !S.reachedEnd && !audio.paused) {
    const L = S.lines[S.idx];
    const left = L.end + off(L.end) - audio.currentTime;
    const vin = Math.min(1, (performance.now() - fadeInStart) / FADE_IN);
    const vout = Math.min(1, Math.max(0, left / FADE_OUT));
    audio.volume = Math.max(0, Math.min(1, vin * vout));
    if (left <= 0) {
      audio.pause();
      S.reachedEnd = true;
      if (S.phase === "listening") {
        S.phase = "typing";
        setStatus("type");
        const f = openInputs()[0];
        if (f && !S.lines[S.idx].inputs.includes(document.activeElement)) f.focus();
      } else if (S.phase === "checked") {
        setStatus("next");
      }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// fora do modo "pausa por frase" (ex.: fim da música tocando), volume normal
audio.addEventListener("play", () => { if ($("#practice").hidden) audio.volume = 1; });

audio.addEventListener("ended", () => {
  if (!$("#practice").hidden && S.phase !== "checked") { S.reachedEnd = true; S.phase = "typing"; setStatus("type"); }
});

function finish() {
  S.phase = "idle";
  const pct = S.stats.total ? Math.round((S.stats.ok / S.stats.total) * 100) : 0;
  $("#progressFill").style.width = "100%";
  $("#finalScore").textContent = pct + "%";
  $("#scoreRing").style.setProperty("--p", pct);
  $("#finalDetail").textContent = `Você acertou ${S.stats.ok} de ${S.stats.total} palavras` + (S.stats.hints ? ` · ${S.stats.hints} dica(s) usada(s)` : "") + ".";
  const seen = new Map();
  for (const m of S.stats.missed) { const k = norm(m.word); seen.set(k, { word: m.word, n: (seen.get(k)?.n || 0) + 1 }); }
  const ul = $("#missed");
  ul.innerHTML = "";
  [...seen.values()].sort((a, b) => b.n - a.n).forEach((m) => {
    ul.insertAdjacentHTML("beforeend", `<li>${escapeHtml(m.word)}${m.n > 1 ? `<small>${m.n}x</small>` : ""}</li>`);
  });
  $("#missedBox").hidden = !seen.size;
  setBest(pct);
  addFinished(pct);
  clearProgress();
  updateResume();
  show("done");
}

/* ---------------- anotações ---------------- */
let NOTES = [];
let editingNote = null;

async function notesApi(body) {
  const r = await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "erro");
  NOTES = d;
  refreshNotes();
}

// Procura, na frase, os trechos que você anotou (em qualquer música).
function matchNotes(tokens) {
  const words = tokens.map((t) => norm(t.core));
  const out = [];
  for (const n of NOTES) {
    const tw = n.term.split(/\s+/).map(norm).filter(Boolean);
    if (!tw.length) continue;
    for (let i = 0; i + tw.length <= words.length; i++) {
      if (tw.every((w, k) => words[i + k] === w)) { out.push({ note: n, start: i, end: i + tw.length - 1 }); break; }
    }
  }
  return out;
}

function noteItem(n, opts = {}) {
  const li = document.createElement("li");
  li.innerHTML = `<div class="note-main"><div class="note-term">${escapeHtml(n.term)}</div>
    <div class="note-text">${escapeHtml(n.note)}</div>
    ${opts.src && n.song ? `<div class="note-src" title="${escapeHtml(n.line || "")}">${ICON("music")} ${escapeHtml(n.song)}${n.line ? " · “" + escapeHtml(n.line) + "”" : ""}</div>` : ""}</div>
    <div class="note-actions">
      <button class="btn ghost" data-act="edit" title="Editar">${ICON("pencil")}</button>
      <button class="btn ghost" data-act="del" title="Apagar">${ICON("trash")}</button>
    </div>`;
  const del = li.querySelector('[data-act="del"]');
  del.onclick = async () => {
    if (li.dataset.confirm !== "1") {  // pede confirmação com um segundo clique
      li.dataset.confirm = "1";
      del.innerHTML = '<span style="font-size:.75rem">Apagar?</span>';
      del.style.width = "auto";
      del.style.padding = "0 8px";
      return;
    }
    await notesApi({ action: "delete", id: n.id });
  };
  li.querySelector('[data-act="edit"]').onclick = () => (opts.inForm ? editInForm(n) : editInline(li, n));
  return li;
}

function editInline(li, n) {
  li.className = "editing";
  li.innerHTML = `<div class="note-edit"><input value="${escapeHtml(n.term)}"><textarea rows="2">${escapeHtml(n.note)}</textarea>
    <div class="note-form-actions"><button class="btn ghost small" data-act="cancel">Cancelar</button>
    <button class="btn primary small" data-act="save">${ICON("device-floppy")} Salvar</button></div></div>`;
  li.querySelector('[data-act="cancel"]').onclick = refreshNotes;
  li.querySelector('[data-act="save"]').onclick = () =>
    notesApi({ note: { ...n, term: li.querySelector("input").value, note: li.querySelector("textarea").value } })
      .catch((e) => alert(e.message));
  li.querySelector("textarea").focus();
}

function editInForm(n) {
  editingNote = n;
  $("#noteTerm").value = n.term;
  $("#noteText").value = n.note;
  $("#noteCancel").hidden = false;
  $("#noteMsg").textContent = "";
  focusNoteForm();
}

function focusNoteForm() {
  openDrawer(true);
  const f = $("#noteForm");
  f.scrollIntoView({ behavior: "smooth", block: "center" });
  f.classList.remove("flash"); void f.offsetWidth; f.classList.add("flash");
  $("#noteText").focus();
}

function resetNoteForm() {
  editingNote = null;
  $("#noteTerm").value = "";
  $("#noteText").value = "";
  $("#noteCancel").hidden = true;
}

function renderNotesHome() {
  const q = norm($("#notesFilter").value || "");
  const list = NOTES.filter((n) => !q || norm(n.term + n.note + (n.song || "")).includes(q));
  $("#notesCount").textContent = NOTES.length;
  $("#notesSub").textContent = NOTES.length ? `${NOTES.length} anotação(ões)` : "";
  $("#notesEmpty").hidden = NOTES.length > 0;
  const ul = $("#notesList");
  ul.innerHTML = "";
  list.forEach((n) => ul.appendChild(noteItem(n, { src: true })));
}

function renderLineNotes() {
  const ul = $("#lineNotes");
  ul.innerHTML = "";
  const L = S.lines[S.idx];
  if (!L) return;
  const ms = matchNotes(L.tokens).filter((m, k, a) => a.findIndex((x) => x.note.id === m.note.id) === k);
  const badge = $("#drawerBadge");
  badge.hidden = !ms.length;
  badge.textContent = ms.length;
  const empty = $("#lineNotesEmpty");
  if (S.phase !== "checked") { // não entrega a resposta antes de você digitar
    empty.textContent = ms.length ? `Há ${ms.length > 1 ? ms.length + " anotações" : "uma anotação"} para esta frase. Ela aparece aqui quando você concluir a frase.` : "Nenhuma anotação para esta frase.";
    empty.hidden = false;
    return;
  }
  ms.forEach((m) => ul.appendChild(noteItem(m.note, { inForm: true })));
  empty.textContent = "Nenhuma anotação para esta frase ainda.";
  empty.hidden = ms.length > 0;
}

function renderDrawerAll() {
  const q = norm($("#drawerFilter").value || "");
  const ul = $("#drawerAll");
  ul.innerHTML = "";
  $("#drawerAllCount").textContent = NOTES.length;
  NOTES.filter((n) => !q || norm(n.term + n.note + (n.song || "")).includes(q))
    .forEach((n) => ul.appendChild(noteItem(n, { src: true, inForm: true })));
}

function openDrawer(open) {
  $("#notesDrawer").classList.toggle("open", open);
  document.body.classList.toggle("drawer-open", open);
  $("#drawerBtn").classList.toggle("active", open);
  save("drawerOpen", open);
  if (open) { renderLineNotes(); renderDrawerAll(); }
}

// Durante a escuta, avisa que há anotação sem entregar a resposta.
function showNoteAlert() {
  const box = $("#noteAlert");
  const ms = matchNotes(S.lines[S.idx].tokens);
  if (!ms.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `${ICON("notes")} <span>${ms.length > 1 ? `Há ${ms.length} anotações suas` : "Há uma anotação sua"} para um trecho desta frase.</span>
    <button type="button" class="btn small">${ICON("eye")} Ver</button>`;
  box.querySelector("button").onclick = () => {
    box.innerHTML = `<div class="revealed-notes">${ms.map((m) => `${ICON("notes")} <b>${escapeHtml(m.note.term)}</b>: ${escapeHtml(m.note.note)}`).join("<br>")}</div>`;
    const f = openInputs()[0];
    if (f) f.focus();
  };
}

// Depois de concluída, a frase vira texto normal (dá para selecionar e anotar).
function solidifyLine() {
  $(".stage").classList.add("checked");
  for (const inp of S.lines[S.idx].inputs) {
    if (!inp.isConnected) continue;
    const sp = document.createElement("span");
    sp.className = "solved";
    sp.textContent = inp.token.core;
    inp.replaceWith(sp);
  }
  $("#noteAlert").hidden = true;
}

function highlightNotes() {
  const L = S.lines[S.idx];
  L.tokens.forEach((t) => { t.span.classList.remove("noted"); t.span.removeAttribute("title"); });
  for (const m of matchNotes(L.tokens))
    for (let i = m.start; i <= m.end; i++) {
      L.tokens[i].span.classList.add("noted");
      L.tokens[i].span.title = `${m.note.term}: ${m.note.note}`;
    }
}

function refreshNotes() {
  renderNotesHome();
  if (!$("#practice").hidden) {
    renderLineNotes();
    renderDrawerAll();
    if (S.phase === "checked") highlightNotes();
  }
}

/* ---------------- ouvir só uma palavra / um trecho ---------------- */
// Quando cada palavra começa (em segundos, no tempo da letra/legenda).
function wordTimes(L) {
  const n = L.tokens.length;
  if (L.wt && L.wt.length === n) return { t: L.wt, exact: true }; // legenda do YouTube: tempo de verdade
  // letra de música: só sabemos o início da frase; estimamos pelo tamanho das palavras
  const dur = Math.min(L.end - L.start, Math.max(1.5, 0.55 * n + 0.5));
  const w = L.tokens.map((t) => Math.max(2, t.core.length) + 1);
  const total = w.reduce((x, y) => x + y, 0);
  let acc = 0;
  return { t: w.map((x) => { const v = L.start + (dur * acc) / total; acc += x; return v; }), exact: false };
}

let clip = null; // {end, resume, rate}
function playClip(i, j, slow = false) {
  const L = S.lines[S.idx];
  const { t, exact } = wordTimes(L);
  const pad = exact ? 0.12 : 0.3;
  const a = Math.max(0, t[i] - pad);
  const b = (j + 1 < t.length ? t[j + 1] : L.end) + (exact ? 0.08 : 0.25);
  stopClip(false);
  clip = { end: b + off(b), resume: audio.currentTime, rate: audio.playbackRate, i, j, slow };
  S.reachedEnd = true; // não deixa o laço da frase interferir
  audio.currentTime = a + off(a);
  audio.playbackRate = slow ? 0.6 : clip.rate;
  audio.volume = 0;
  fadeInStart = performance.now();
  L.tokens.forEach((tk, k) => tk.span.classList.toggle("playing", k >= i && k <= j));
  audio.play().catch(() => stopClip());
}
function stopClip(restore = true) {
  if (!clip) return;
  const c = clip;
  clip = null;
  audio.pause();
  audio.playbackRate = c.rate;
  if (restore) audio.currentTime = c.resume; // volta para onde estava, sem bagunçar a próxima frase
  document.querySelectorAll("#line .playing").forEach((e) => e.classList.remove("playing"));
}
function clipTick() {
  if (clip && !audio.paused) {
    const left = clip.end - audio.currentTime;
    audio.volume = Math.max(0, Math.min(1, (performance.now() - fadeInStart) / 80, left / 0.12));
    if (left <= 0) stopClip();
  }
  requestAnimationFrame(clipTick);
}
requestAnimationFrame(clipTick);

// Clique numa palavra ou selecione várias: toca só esse trecho do vídeo.
function tokenRange() {
  const L = S.lines[S.idx];
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const idx = L.tokens.map((t, k) => (norm(t.core) && sel.containsNode(t.span, true) ? k : -1)).filter((k) => k >= 0);
  return idx.length ? [idx[0], idx[idx.length - 1]] : null;
}
function onLinePick(e) {
  if (S.phase !== "checked") return;
  const L = S.lines[S.idx];
  let r = tokenRange();
  if (!r) {
    const span = e.target.closest && e.target.closest(".word");
    const k = L.tokens.findIndex((t) => t.span === span);
    if (k < 0 || !norm(L.tokens[k].core)) return hideClipPop();
    r = [k, k];
  }
  showClipPop(r[0], r[1]);
  playClip(r[0], r[1]);
}
function showClipPop(i, j) {
  const L = S.lines[S.idx];
  const text = L.tokens.slice(i, j + 1).map((t) => t.core).join(" ");
  const pop = $("#clipPop");
  pop.innerHTML = `<span class="clip-text">“${escapeHtml(text)}”</span>
    <button type="button" class="btn small" data-a="again" title="Ouvir de novo">${ICON("repeat")}</button>
    <button type="button" class="btn small" data-a="slow" title="Ouvir mais devagar">${ICON("gauge")} Devagar</button>
    <button type="button" class="btn small" data-a="note" title="Anotar este trecho">${ICON("notes")} Anotar</button>`;
  pop.querySelector('[data-a="again"]').onclick = () => playClip(i, j);
  pop.querySelector('[data-a="slow"]').onclick = () => playClip(i, j, true);
  pop.querySelector('[data-a="note"]').onclick = () => {
    editingNote = null;
    $("#noteCancel").hidden = true;
    $("#noteTerm").value = text;
    $("#noteText").value = "";
    $("#noteMsg").textContent = "";
    focusNoteForm();
  };
  pop.hidden = false;
  // posiciona logo abaixo das palavras escolhidas
  const stage = $(".stage").getBoundingClientRect();
  const a = L.tokens[i].span.getBoundingClientRect(), b = L.tokens[j].span.getBoundingClientRect();
  const center = (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2 - stage.left;
  pop.style.top = `${Math.max(a.bottom, b.bottom) - stage.top + 8}px`;
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(stage.width - w - 8, center - w / 2))}px`;
}
function hideClipPop() { $("#clipPop").hidden = true; }
$("#line").addEventListener("mouseup", (e) => setTimeout(() => onLinePick(e), 0));
$("#line").addEventListener("touchend", (e) => setTimeout(() => onLinePick(e), 300));
document.addEventListener("mousedown", (e) => {
  if (!$("#clipPop").hidden && !e.target.closest("#clipPop, #line")) hideClipPop();
});

$("#noteForm").onsubmit = async (e) => {
  e.preventDefault();
  const L = S.lines[S.idx];
  try {
    await notesApi({ note: { id: editingNote?.id, term: $("#noteTerm").value, note: $("#noteText").value,
      song: S.song ? `${S.song.track} — ${S.song.artist}` : "", line: L ? L.text : "" } });
    resetNoteForm();
    $("#noteMsg").innerHTML = `${ICON("circle-check")} Anotação salva`;
  } catch (err) {
    $("#noteMsg").innerHTML = `<span style="color:var(--err)">${escapeHtml(err.message)}</span>`;
  }
};
$("#noteCancel").onclick = resetNoteForm;
$("#notesFilter").oninput = renderNotesHome;
$("#drawerFilter").oninput = renderDrawerAll;
$("#drawerBtn").onclick = () => openDrawer(!$("#notesDrawer").classList.contains("open"));
$("#drawerClose").onclick = () => openDrawer(false);
$("#noteFromExplain").onclick = () => { resetNoteForm(); focusNoteForm(); };
$("#noteText").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) $("#noteForm").requestSubmit(); });

/* ---------------- significado da frase ---------------- */
function explainFor(i) {
  const L = S.lines[i];
  if (!L) return null;
  if (!L.exP) {
    const qs = new URLSearchParams({ text: L.text, prev: S.lines[i - 1]?.text || "", artist: S.song.artist, track: S.song.track });
    L.exP = fetch("/api/explain?" + qs).then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      return d;
    });
    L.exP.catch(() => (L.exP = null)); // permite tentar de novo depois
  }
  return L.exP;
}

async function showExplain() {
  const i = S.idx;
  const box = $("#exBody");
  $("#explain").hidden = false;
  $("#micResult").hidden = true;
  box.innerHTML = `<p class="loading-line">${ICON("loader-2")} Preparando o significado e os exemplos…</p>`;
  renderWordChips();
  renderLineNotes();
  $("#noteMsg").textContent = "";
  resetNoteForm();
  let d;
  try { d = await explainFor(i); } catch { d = null; }
  if (S.idx !== i) return;
  if (!d) { box.innerHTML = `<p class="loading-line">${ICON("alert-circle")} Não consegui carregar o significado desta frase agora.</p>`; return; }
  let html = `<p class="ex-trad">“${escapeHtml(d.traducao || "")}”</p>`;
  if (d.explicacao) html += `<p class="ex-expl">${escapeHtml(d.explicacao)}</p>`;
  if (d.expressoes?.length) html += '<div class="ex-chips">' + d.expressoes.map((x) => `<span><b>${escapeHtml(x.en)}</b> = ${escapeHtml(x.pt)}</span>`).join("") + "</div>";
  if (d.exemplos?.length) {
    html += `<h4 class="sub-title">${ICON("message-circle")} No dia a dia</h4><ul class="ex-list">` + d.exemplos.map((x, k) =>
      `<li><button class="say-btn" data-say="${k}" title="Ouvir">${ICON("volume")}</button><div><div class="en">${escapeHtml(x.en)}</div><div class="pt">${escapeHtml(x.pt)}</div></div></li>`).join("") + "</ul>";
  }
  if (d.fonte === "mymemory") html += `<p class="loading-line">${ICON("info-circle")} Só a tradução está disponível agora (explicação e exemplos precisam do Claude Code ou do OpenCode instalado).</p>`;
  box.innerHTML = html;
  box.querySelectorAll("[data-say]").forEach((b) => (b.onclick = () => speak(d.exemplos[+b.dataset.say].en)));
}

/* ---------------- significado de uma palavra ---------------- */
function renderWordChips() {
  const L = S.lines[S.idx];
  const seen = new Set();
  const box = $("#wordChips");
  box.innerHTML = "";
  $("#wordResult").hidden = true;
  $("#askInput").value = "";
  for (const t of L.tokens) {
    const k = norm(t.core);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t.core;
    b.onclick = () => askWord(t.core, b);
    box.appendChild(b);
  }
}

async function askWord(word, chip) {
  word = word.trim();
  if (!word) return;
  const i = S.idx;
  document.querySelectorAll("#wordChips button").forEach((b) => b.classList.toggle("active", b === chip));
  const out = $("#wordResult");
  out.hidden = false;
  out.innerHTML = `<p class="loading-line">${ICON("loader-2")} Procurando o significado de “${escapeHtml(word)}”…</p>`;
  let d;
  try {
    const qs = new URLSearchParams({ word, line: S.lines[i].text, artist: S.song.artist, track: S.song.track });
    const r = await fetch("/api/word?" + qs);
    d = await r.json();
    if (!r.ok) throw new Error(d.error);
  } catch { d = null; }
  if (S.idx !== i) return;
  if (!d) { out.innerHTML = `<p class="loading-line">${ICON("alert-circle")} Não consegui buscar o significado agora. Tente de novo.</p>`; return; }
  const term = d.termo || word;
  let html = `<div class="w-head"><span class="w-term">${escapeHtml(term)}</span>
    <button type="button" class="say-btn" data-say-term title="Ouvir">${ICON("volume")}</button>
    ${d.pronuncia ? `<span class="w-pron">/${escapeHtml(d.pronuncia)}/</span>` : ""}
    ${d.classe ? `<span class="w-class">${escapeHtml(d.classe)}</span>` : ""}</div>
    <p class="w-mean">${escapeHtml(d.significado || "")}</p>`;
  if (d.fonte === "mymemory") html += `<p class="loading-line">${ICON("info-circle")} Tradução da palavra isolada: pode não ser o sentido usado nesta frase (o significado no contexto precisa do Claude Code ou do OpenCode instalado).</p>`;
  if (d.nota) html += `<p class="w-note">${ICON("bulb")}<span>${escapeHtml(d.nota)}</span></p>`;
  if (d.outros?.length) html += `<p class="w-other">Também pode significar: ${d.outros.map(escapeHtml).join(" · ")}</p>`;
  if (d.exemplos?.length) html += '<ul class="ex-list">' + d.exemplos.map((x, k) =>
    `<li><button type="button" class="say-btn" data-say-ex="${k}" title="Ouvir">${ICON("volume")}</button><div><div class="en">${escapeHtml(x.en)}</div><div class="pt">${escapeHtml(x.pt)}</div></div></li>`).join("") + "</ul>";
  html += `<div class="note-form-actions" style="margin-top:10px"><button type="button" class="btn small" data-note-term>${ICON("notes")} Anotar “${escapeHtml(term)}”</button></div>`;
  out.innerHTML = html;
  out.querySelector("[data-note-term]").onclick = () => {
    editingNote = null; $("#noteCancel").hidden = true;
    $("#noteTerm").value = term; $("#noteText").value = ""; focusNoteForm();
  };
  out.querySelector("[data-say-term]").onclick = () => speak(term, 0.8);
  out.querySelectorAll("[data-say-ex]").forEach((b) => (b.onclick = () => speak(d.exemplos[+b.dataset.sayEx].en)));
}

$("#askForm").onsubmit = (e) => { e.preventDefault(); askWord($("#askInput").value, null); };

/* ---------------- voz (pronúncia) ---------------- */
let enVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang) || v.lang === "en");
  const score = (v) => (/en[-_]US/i.test(v.lang) ? 4 : 0) + (/google|natural|neural|microsoft|samantha/i.test(v.name) ? 3 : 0) + (v.localService ? 0 : 1);
  enVoice = vs.sort((a, b) => score(b) - score(a))[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function speak(text, rate = 0.95) {
  if (!("speechSynthesis" in window)) return alert("Seu navegador não tem leitura em voz alta.");
  speechSynthesis.cancel();
  if (!audio.paused) audio.pause();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  if (enVoice) u.voice = enVoice;
  u.rate = rate;
  speechSynthesis.speak(u);
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function micIdle() { const b = $("#micBtn"); b.classList.remove("recording"); b.innerHTML = `${ICON("microphone")} <span>Falar e verificar</span>`; }
function micRecording() { const b = $("#micBtn"); b.classList.add("recording"); b.innerHTML = `${ICON("player-stop")} <span>Parar</span>`; }
let rec = null;
function stopVoice() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (rec) { try { rec.abort(); } catch {} rec = null; }
  micIdle();
}

// compara a frase falada com a original (maior subsequência comum de palavras)
function compareSpeech(target, spoken) {
  const t = target.split(/\s+/).map((w) => ({ w, n: norm(w) })).filter((x) => x.n);
  const s = spoken.split(/\s+/).map(norm).filter(Boolean);
  const dp = Array.from({ length: t.length + 1 }, () => new Array(s.length + 1).fill(0));
  for (let a = t.length - 1; a >= 0; a--)
    for (let b = s.length - 1; b >= 0; b--)
      dp[a][b] = t[a].n === s[b] ? dp[a + 1][b + 1] + 1 : Math.max(dp[a + 1][b], dp[a][b + 1]);
  const ok = new Array(t.length).fill(false);
  for (let a = 0, b = 0; a < t.length && b < s.length;) {
    if (t[a].n === s[b]) { ok[a] = true; a++; b++; }
    else if (dp[a + 1][b] >= dp[a][b + 1]) a++; else b++;
  }
  return { words: t.map((x, k) => ({ w: x.w, ok: ok[k] })), pct: t.length ? Math.round((dp[0][0] / t.length) * 100) : 0 };
}

function micCheck() {
  const out = $("#micResult");
  if (!SR) {
    out.hidden = false;
    out.innerHTML = "Seu navegador não reconhece fala. Para verificar a pronúncia pelo microfone, abra o app no <b>Google Chrome</b>.";
    return;
  }
  if (rec) return stopVoice();
  stopVoice();
  if (!audio.paused) audio.pause();
  const target = S.lines[S.idx].text;
  rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  micRecording();
  out.hidden = false;
  out.innerHTML = `<span class="loading-line" style="margin:0">${ICON("microphone")} Pode falar a frase em inglês…</span>`;
  rec.onresult = (e) => {
    const alts = [...e.results[0]].map((a) => a.transcript);
    let best = null;
    for (const a of alts) { const c = compareSpeech(target, a); if (!best || c.pct > best.pct) best = { ...c, heard: a }; }
    const msg = best.pct >= 90 ? "Excelente pronúncia!" : best.pct >= 60 ? "Quase lá! Treine as palavras em vermelho." : "Vamos de novo? Ouça a pronúncia e repita.";
    out.innerHTML = `<div>${best.words.map((x) => `<span class="${x.ok ? "w-ok" : "w-bad"}">${escapeHtml(x.w)}</span>`).join(" ")}</div>
      <small><b>${best.pct}%</b> · ${msg} · Entendi: “${escapeHtml(best.heard)}”</small>`;
  };
  rec.onerror = (e) => {
    const m = { "not-allowed": "Permita o uso do microfone no navegador.", "no-speech": "Não ouvi nada. Tente de novo.", network: "O reconhecimento de fala precisa de internet (e funciona melhor no Google Chrome)." };
    out.innerHTML = m[e.error] || "Erro no reconhecimento: " + e.error;
  };
  rec.onend = () => { rec = null; micIdle(); };
  rec.start();
}

$("#sayBtn").onclick = () => speak(S.lines[S.idx].text);
$("#saySlowBtn").onclick = () => speak(S.lines[S.idx].text, 0.65);
$("#micBtn").onclick = micCheck;

/* ---------------- vídeo ---------------- */
let videoHidden = load("videoHidden", false);
function updateVideo() {
  const hasPicture = audio.videoWidth > 0;
  audio.hidden = !hasPicture || videoHidden;
  $("#toggleVideo").closest(".settings-row").hidden = !hasPicture;
  $("#toggleVideo").innerHTML = videoHidden ? `${ICON("eye")} Mostrar vídeo` : `${ICON("eye-off")} Esconder vídeo`;
}
audio.addEventListener("loadedmetadata", updateVideo);
$("#toggleVideo").onclick = () => { videoHidden = !videoHidden; save("videoHidden", videoHidden); updateVideo(); };
updateVideo();

/* ---------------- ajustes ---------------- */
function setSpeed(v) {
  audio.playbackRate = +v;
  audio.preservesPitch = true;
  for (const name of ["speedSetup", "speedPractice"]) {
    const r = document.querySelector(`input[name="${name}"][value="${v}"]`);
    if (r) r.checked = true;
  }
}
function updateSync() {
  $("#syncValue").textContent = (S.offset >= 0 ? "+" : "") + S.offset.toFixed(2).replace(".", ",") + "s";
  const all = load("manualOffsets", {});
  all[S.song.key] = S.offset;
  save("manualOffsets", all);
}
const shiftSync = (d) => { S.offset = Math.round((S.offset + d) * 100) / 100; updateSync(); };
$("#syncMinus").onclick = () => shiftSync(-0.25);
$("#syncPlus").onclick = () => shiftSync(0.25);
$("#syncMinus1").onclick = () => shiftSync(-1);
$("#syncPlus1").onclick = () => shiftSync(1);
$("#speedPractice").onchange = (e) => setSpeed(e.target.value);
$("#settingsBtn").onclick = () => { $("#settingsPanel").hidden = !$("#settingsPanel").hidden; };

/* ---------------- eventos ---------------- */
$("#searchForm").onsubmit = (e) => { e.preventDefault(); const q = $("#searchInput").value.trim(); if (q) search(q); };
$("#changeSong").onclick = () => { $("#setup").hidden = true; $("#howto").hidden = false; S.song = null; audio.pause(); $("#searchInput").focus(); };
$("#startBtn").onclick = startPractice;
$("#restartLink").onclick = () => {
  S.resume = null;
  $("#restartLink").hidden = true;
  $("#startBtn").innerHTML = ICON("player-play-filled") + " Começar a praticar";
};
$("#checkBtn").onclick = check;
$("#replayBtn").onclick = replay;
$("#hintBtn").onclick = hint;
$("#skipBtn").onclick = skip;
$("#prevBtn").onclick = prevLine;
$("#revealBtn").onclick = () => { if (S.phase !== "checked") { openInputs().forEach(reveal); finishLine(); } };
$("#backBtn").onclick = () => { stopClip(false); hideClipPop(); audio.pause(); stopVoice(); S.phase = "idle"; $("#settingsPanel").hidden = true; updateResume(); show("home"); };
$("#againBtn").onclick = () => startPractice();
$("#notesOpenBtn").onclick = () => { renderNotesHome(); show("notesScreen"); $("#notesFilter").focus(); };
$("#notesBackBtn").onclick = () => show("home");
$("#otherBtn").onclick = () => { audio.pause(); $("#setup").hidden = true; show("home"); $("#searchInput").select(); };

document.addEventListener("keydown", (e) => {
  if ($("#practice").hidden) return;
  if (e.target.closest && e.target.closest("form, .note-edit, .drawer")) return; // digitando pergunta/anotação
  if (e.key === "Escape" && e.shiftKey) { e.preventDefault(); prevLine(); }
  else if (e.key === "Escape") { e.preventDefault(); replay(); }
  else if (e.key === " " && e.ctrlKey) { e.preventDefault(); hint(); }
  else if (e.key === "Enter") {
    e.preventDefault();
    if (e.target.tagName === "BUTTON" && e.target !== $("#checkBtn")) return e.target.click();
    check();
  }
});

/* ---------------- teclado virtual ---------------- */
const VK_ROWS = [
  ["1","2","3","4","5","6","7","8","9","0"],
  ["q","w","e","r","t","y","u","i","o","p"],
  ["a","s","d","f","g","h","j","k","l","'"],
  ["shift","z","x","c","v","b","n","m","-","back"],
  ["hide","space","enter"],
];
const VK_LABEL = { shift: ICON("arrow-big-up"), back: ICON("backspace"), hide: ICON("keyboard-hide"),
  space: "espaço", enter: `${ICON("corner-down-left")} Enter` };
let vkShift = false, vkLast = null;

function buildVk() {
  const vk = $("#vk");
  vk.innerHTML = VK_ROWS.map((row) => `<div class="vk-row">${row.map((k) =>
    `<button type="button" class="vk-key${VK_LABEL[k] ? " vk-" + k : ""}" data-k="${k}">${VK_LABEL[k] || k}</button>`).join("")}</div>`).join("")
  vk.insertAdjacentHTML("beforeend", `<button type="button" class="vk-close" data-k="hide" title="Fechar teclado">${ICON("x")}</button>`);
}
function vkRefreshCase() {
  document.querySelectorAll("#vk .vk-key").forEach((b) => {
    const k = b.dataset.k;
    if (k.length === 1) b.textContent = vkShift ? k.toUpperCase() : k;
  });
  $("#vk .vk-shift").classList.toggle("on", vkShift);
}
const isTextField = (el) => el && !el.disabled && el.isConnected && el.offsetParent !== null && el.matches("input[type=text], input:not([type]), textarea");

// Para onde vai o que for digitado: campo em foco, senão o último usado, senão o campo da tela atual.
function vkTarget() {
  if (isTextField(document.activeElement)) return document.activeElement;
  if (isTextField(vkLast)) return vkLast;
  if (!$("#practice").hidden && S.lines[S.idx] && S.lines[S.idx].inputs) return openInputs()[0] || null;
  if (!$("#home").hidden) return $("#searchInput");
  return null;
}
function vkInput(el) { el.dispatchEvent(new Event("input", { bubbles: true })); }

function vkPress(k) {
  if (k === "hide") return setVk(false);
  if (k === "shift") { vkShift = !vkShift; return vkRefreshCase(); }
  const el = vkTarget();
  if (!el) return;
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
  const isWord = el.closest("#line");
  if (k === "enter") {
    if (el.form) el.form.requestSubmit();
    else if (!$("#practice").hidden) check();
    return;
  }
  if (k === "space" && isWord) { // igual à barra de espaço: confere a palavra e vai para a próxima
    el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    return;
  }
  if (k === "back") {
    if (s !== e) el.setRangeText("", s, e, "end");
    else if (s > 0) el.setRangeText("", s - 1, s, "end");
    return vkInput(el);
  }
  let ch = k === "space" ? " " : k;
  if (vkShift && ch.length === 1) { ch = ch.toUpperCase(); vkShift = false; vkRefreshCase(); }
  if (el.maxLength > 0 && el.value.length - (e - s) + ch.length > el.maxLength) { if (isWord) shake(el); return; }
  el.setRangeText(ch, s, e, "end");
  vkInput(el);
}

function setVk(open) {
  $("#vk").hidden = !open;
  document.body.classList.toggle("vk-open", open);
  document.querySelectorAll(".vk-toggle").forEach((b) => b.classList.toggle("active", open));
  save("vkOpen", open);
  // com o teclado virtual aberto, o celular não abre o teclado dele por cima
  document.querySelectorAll("input[type=text], textarea").forEach((el) => (el.inputMode = open ? "none" : ""));
  const t = vkTarget();
  if (open && t) t.focus({ preventScroll: true });
}

buildVk();
const vkEl = $("#vk");
vkEl.addEventListener("mousedown", (e) => e.preventDefault()); // não tira o foco do campo
vkEl.addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) vkPress(b.dataset.k); });
document.addEventListener("focusin", (e) => {
  if (e.target.closest && !e.target.closest("#vk") && isTextField(e.target)) {
    vkLast = e.target;
    if (!vkEl.hidden) e.target.inputMode = "none";
  }
});
document.querySelectorAll(".vk-toggle").forEach((b) => {
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.onclick = () => setVk(vkEl.hidden);
});
if (load("vkOpen", false)) setVk(true);

/* ---------------- início ---------------- */
fetch("/api/notes").then((r) => r.json()).then((d) => { NOTES = Array.isArray(d) ? d : []; renderNotesHome(); }).catch(() => {});
fetch("/api/status").then((r) => r.json()).then((d) => (S.ytdlp = d.ytdlp)).catch(() => {});
renderRecent();
renderFinished();
