'use strict';

/* ========== 設定與資料 ========== */
const DAY = 86400000;
// 記憶階段 → 下次複習間隔（天）。階段 0 = 剛忘記／學習中
const INTERVALS = [0, 1, 3, 7, 14, 30, 90, 180];
const LONG_TERM = 4; // 階段 >= 4（間隔 >= 14 天）算「長期記憶」
const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const TARGETS = [10, 20, 30, 50, 100];

const store = {
  get(k, d) { try { const v = localStorage.getItem('jlpt.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('jlpt.' + k, JSON.stringify(v)); } catch (e) { toast('無法儲存進度'); } },
};

let settings = Object.assign({ level: 'N5', target: 20, front: 'jp', autoSpeak: false, showEx: true }, store.get('settings', {}));
let progress = store.get('progress', {}); // id → { s 階段, due 到期時間, n 作答次數, lapses 忘記次數, first, last }
let stars = store.get('stars', {});       // id → true
let custom = store.get('custom', []);     // 使用者匯入的單字
let session = store.get('session', null);
let daily = store.get('daily', { date: '', count: 0 });
let undoStack = [];
let finished = null;
let card = {};
let timer = null;
let listQuery = '';

const saveSettings = () => store.set('settings', settings);
const saveProgress = () => store.set('progress', progress);
const saveSession = () => store.set('session', session);

let WORDS = [], byId = new Map();
function rebuild() {
  const map = new Map();
  for (const [lv, arr] of Object.entries(window.WORD_SETS || {})) {
    arr.forEach(([w, r, m, p, ex, exm]) => map.set(lv + ':' + w + ':' + r, { w, r, m, p: p || '', ex: ex || '', exm: exm || '', lv }));
  }
  // 匯入的單字覆蓋內建內容，但空白欄位（例如沒有例句）沿用內建資料
  custom.forEach(o => {
    const id = o.lv + ':' + o.w + ':' + o.r, base = map.get(id) || {};
    const filled = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
    map.set(id, Object.assign({}, base, filled, { custom: true }));
  });
  WORDS = [...map].map(([id, w]) => Object.assign(w, { id }));
  byId = new Map(WORDS.map(w => [w.id, w]));
  if (!availableLevels().includes(settings.level)) settings.level = availableLevels()[0] || 'N5';
}

/* ========== 小工具 ========== */
const app = document.getElementById('app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const today = () => new Date().toLocaleDateString('sv');
const fmtTime = sec => String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
const fmtDate = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
const daysAgo = t => { const n = Math.round((startOfDay() - startOfDay(t)) / DAY); return n <= 0 ? '今天' : n + ' 天前'; };
const intervalLabel = d => d === 1 ? '明天' : d < 7 ? d + ' 天後' : d < 30 ? d / 7 + ' 週後' : d < 180 ? d / 30 + ' 個月後' : '半年後';
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return toast('這個瀏覽器不支援語音朗讀');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP'; u.rate = 0.9;
  const v = speechSynthesis.getVoices().find(v => /^ja[-_]/i.test(v.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

const I = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 12H4m7-7-7 7 7 7"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>',
  speak: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.8-4.4 4.3 1.1 6.1L12 16.9l-5.5 2.9 1.1-6.1-4.4-4.3 6.1-.8z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="m4 4 16 16"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h4M8 13h8"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
};

/* ========== 學習邏輯 ========== */
function availableLevels() { return LEVELS.filter(lv => WORDS.some(w => w.lv === lv)); }
function levelWords(lv = settings.level) { return WORDS.filter(w => w.lv === lv); }
function status(id) {
  const p = progress[id];
  if (!p) return 'new';
  return p.s >= LONG_TERM ? 'long' : 'learning';
}
const isDue = (id, now = Date.now()) => progress[id] && progress[id].due <= now;

function stats(lv = settings.level) {
  const ws = levelWords(lv), now = Date.now();
  const s = { total: ws.length, learned: 0, long: 0, due: 0, star: 0 };
  ws.forEach(w => {
    const p = progress[w.id];
    if (stars[w.id]) s.star++;
    if (!p) return;
    s.learned++;
    if (p.s >= LONG_TERM) s.long++;
    if (p.due <= now) s.due++;
  });
  return s;
}

// 答對時的下一個階段：新單字直接會 → 3 天後；剛忘記 → 明天；其餘往上一階
function nextStage(id) {
  const p = progress[id];
  if (!p) return 2;
  return Math.min(p.s + 1, INTERVALS.length - 1);
}

function planSession(lv = settings.level) {
  const now = Date.now(), ws = levelWords(lv);
  const due = ws.filter(w => isDue(w.id, now)).sort((a, b) => progress[a.id].due - progress[b.id].due);
  const reviewIds = due.slice(0, settings.target).map(w => w.id);
  const newIds = ws.filter(w => !progress[w.id]).slice(0, settings.target - reviewIds.length).map(w => w.id);
  return { reviewIds, newIds };
}

function activeSession() {
  if (session && (session.date !== today() || !session.queue.length)) { session = null; saveSession(); }
  return session && session.lv === settings.level ? session : null;
}
const dailyCount = () => daily.date === today() ? daily.count : 0;

function startSession() {
  if (activeSession()) { location.hash = '#/study'; return; }
  const { reviewIds, newIds } = planSession();
  const queue = shuffle([...reviewIds, ...newIds]);
  if (!queue.length) return toast('目前沒有需要學習的單字');
  session = { lv: settings.level, date: today(), queue, total: queue.length, done: 0, elapsed: 0 };
  undoStack = []; finished = null;
  saveSession();
  location.hash = '#/study';
}

function answer(known) {
  const id = session.queue[0];
  undoStack.push({ id, prev: progress[id] ? Object.assign({}, progress[id]) : null, sess: JSON.parse(JSON.stringify(session)) });
  if (undoStack.length > 50) undoStack.shift();

  const p = progress[id] || { s: 0, due: 0, n: 0, lapses: 0, first: Date.now() };
  session.queue.shift();
  if (known) {
    p.s = nextStage(id);
    p.due = startOfDay() + INTERVALS[p.s] * DAY;
    session.done++;
  } else {
    if (p.s > 0) p.lapses++;
    p.s = 0; p.due = Date.now();
    session.queue.splice(Math.min(4, session.queue.length), 0, id); // 幾張卡後再出現
  }
  p.n++; p.last = Date.now();
  progress[id] = p;
  saveProgress();

  if (!session.queue.length) {
    const n = dailyCount() + 1;
    daily = { date: today(), count: n };
    store.set('daily', daily);
    finished = { n, total: session.total, elapsed: session.elapsed };
    session = null; undoStack = [];
  }
  saveSession();
  renderStudy();
}

function undo() {
  const u = undoStack.pop();
  if (!u) return;
  if (u.prev) progress[u.id] = u.prev; else delete progress[u.id];
  session = u.sess;
  card = { id: u.id };
  saveProgress(); saveSession();
  renderStudy();
}

function toggleStar(id) {
  if (stars[id]) delete stars[id]; else stars[id] = true;
  store.set('stars', stars);
}

/* ========== 畫面：首頁 ========== */
function gauge(done, total) {
  const L = 219.9, r = total ? done / total : 0;
  return `<div class="gauge"><svg viewBox="0 0 160 90"><path class="g-bg" d="M10 80A70 70 0 0 1 150 80"/>
    <path class="g-fg" d="M10 80A70 70 0 0 1 150 80" style="stroke-dasharray:${L};stroke-dashoffset:${L * (1 - r)}"/></svg>
    <div class="g-text"><b>${pct(done, total)}%</b><span>${done}/${total}</span></div></div>`;
}

function statRow(label, n, total, href) {
  return `<a class="row" href="${href}"><span>${label}</span><b>${n}${total != null ? `<small>/${total}</small>` : ''}</b>
    ${total != null ? `<span class="mini"><i style="width:${pct(n, total)}%"></i></span>` : I.chev}</a>`;
}

function renderHome() {
  const lv = settings.level, st = stats(lv), s = activeSession();
  let newN, revN, done = 0, total;
  if (s) {
    newN = s.queue.filter(id => !progress[id]).length;
    revN = s.queue.length - newN;
    done = s.done; total = s.total;
  } else {
    const p = planSession(lv);
    newN = p.newIds.length; revN = p.reviewIds.length; total = newN + revN;
  }
  const btn = s ? '繼續學習' : total ? '開始學習' : '今天的單字都學完了';

  app.innerHTML = `
  <header class="bar">
    <span class="ic"></span>
    <label class="level-pick"><b>${lv} 單字</b><span class="caret">▾</span>
      <select id="lv" aria-label="選擇級數">${availableLevels().map(l => `<option ${l === lv ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <a class="ic" href="#/settings" aria-label="設定">${I.gear}</a>
  </header>
  <section class="panel">
    <div class="panel-head"><h2>自動學習</h2><span class="pill orange">第 ${dailyCount() + 1} 次</span>
      <a class="link" href="#/list/learned">記錄 ${I.chev}</a></div>
    <div class="goal">
      <div><div class="label">目標學習量</div>
        <div class="select-box"><select id="target">${TARGETS.map(t => `<option value="${t}" ${t === settings.target ? 'selected' : ''}>${t} 個</option>`).join('')}</select><span class="caret">▾</span></div></div>
      ${gauge(done, total)}
    </div>
    <div class="rows">
      <a class="row" href="#/list/new"><span>新單字</span><b>${newN}</b>${I.chev}</a>
      <a class="row" href="#/list/due"><span>複習單字</span><b>${revN}</b>${I.chev}</a>
    </div>
    <button class="primary" id="start" ${s || total ? '' : 'disabled'}>${btn}</button>
  </section>
  <section class="info">
    <div class="info-head"><h2>${lv} 學習資訊</h2><a class="link" href="#/list/all">所有單字 ${I.chev}</a></div>
    <div class="rows card-rows">
      ${statRow('長期記憶單字', st.long, st.total, '#/list/long')}
      ${statRow('已學習單字', st.learned, st.total, '#/list/learned')}
      ${statRow('收藏單字', st.star, null, '#/list/star')}
    </div>
    <p class="hint center">「長期記憶」＝複習間隔已達 14 天以上的單字</p>
  </section>`;

  document.getElementById('lv').onchange = e => { settings.level = e.target.value; saveSettings(); renderHome(); };
  document.getElementById('target').onchange = e => {
    settings.target = +e.target.value; saveSettings();
    if (session && session.done === 0) { session = null; saveSession(); }
    renderHome();
  };
  document.getElementById('start').onclick = startSession;
}

/* ========== 畫面：單字卡 ========== */
function renderStudy() {
  const s = activeSession();
  if (!s) return finished ? renderDone() : location.replace('#/');
  const id = s.queue[0], w = byId.get(id);
  if (!w) { s.queue.shift(); s.total--; saveSession(); return renderStudy(); }

  const isNewCard = card.id !== id;
  if (isNewCard) card = { id, a: false, b: false };
  const p = progress[id], kanaOnly = w.w === w.r, jp = settings.front === 'jp';

  // 正面顯示的內容，以及兩顆翻面按鈕
  const front = jp ? w.w : w.m;
  const btnA = jp ? '意思' : (kanaOnly ? '日文' : '單字');
  const btnB = '平假名';
  const showB = !kanaOnly;
  const showWord = jp || card.a;
  const showRead = card.b || (!jp && kanaOnly && card.a);
  const showMean = !jp || card.a;
  const showExJp = settings.showEx && w.ex && showWord;
  const showExZh = settings.showEx && w.exm && (jp ? card.a : true);

  app.innerHTML = `
  <div class="study">
    <header class="bar">
      <button class="ic" data-back aria-label="返回">${I.back}</button>
      <b class="bar-title">${s.lv} 單字學習</b>
      <a class="ic" href="#/settings" aria-label="設定">${I.gear}</a>
    </header>
    <div class="progress-row">
      <span>${s.done}/${s.total}</span>
      <div class="pbar"><i style="width:${pct(s.done, s.total)}%"></i></div>
      <span class="timer"><span id="clock">${fmtTime(s.elapsed)}</span>${I.clock}</span>
    </div>
    <div class="flash">
      <div class="flash-top">
        <span class="pill ${p ? 'blue' : 'green'}">${p ? daysAgo(p.first) : '新單字'}</span>
        <button class="ic star ${stars[id] ? 'on' : ''}" id="star" aria-label="收藏">${I.star}</button>
        <span class="grow"></span>
        <button class="round" id="speak" aria-label="發音">${I.speak}</button>
        <button class="round" id="toggleEx" aria-label="顯示或隱藏例句">${settings.showEx ? I.eye : I.eyeOff}</button>
        <a class="round wide" href="#/word/${encodeURIComponent(id)}">${I.doc}詳細</a>
      </div>
      <div class="flash-main">
        <div class="big ${jp ? '' : 'zh'} ${front.length > 4 ? 'long' : ''}" ${jp ? 'lang="ja"' : ''}>${esc(front)}</div>
        <div class="reveal">
          ${!jp ? `<div class="rv-word ${card.a ? '' : 'hide'}" lang="ja">${esc(w.w)}</div>` : ''}
          <div class="rv-read ${showRead && !kanaOnly ? '' : 'hide'}" lang="ja">${esc(w.r)}</div>
          ${jp ? `<div class="rv-mean ${showMean ? '' : 'hide'}">${esc(w.m)}${w.p ? `<span class="pos">${esc(w.p)}</span>` : ''}</div>` : ''}
        </div>
      </div>
      <div class="flash-ex">
        <div class="${showExJp ? '' : 'hide'}" lang="ja">${esc(w.ex)}</div>
        <div class="zh ${showExZh ? '' : 'hide'}">${esc(w.exm)}</div>
      </div>
      <div class="flash-btns">
        <button class="round" id="undo" aria-label="上一步" ${undoStack.length ? '' : 'disabled'}>${I.undo}</button>
        <button class="outline ${card.a ? 'on' : ''}" id="btnA">${btnA}</button>
        ${showB ? `<button class="outline ${card.b ? 'on' : ''}" id="btnB">${btnB}</button>` : ''}
      </div>
    </div>
    <div class="answer">
      <button class="again" id="again">再學習</button>
      <button class="know" id="know">已掌握<small>${intervalLabel(INTERVALS[nextStage(id)])}複習</small></button>
    </div>
  </div>`;

  const $ = s => document.getElementById(s);
  $('btnA').onclick = () => { card.a = !card.a; if (card.a && settings.autoSpeak && !jp) speak(w.r); renderStudy(); };
  if (showB) $('btnB').onclick = () => { card.b = !card.b; if (card.b && settings.autoSpeak) speak(w.r); renderStudy(); };
  $('again').onclick = () => answer(false);
  $('know').onclick = () => answer(true);
  $('undo').onclick = undo;
  $('speak').onclick = () => speak(w.r);
  $('star').onclick = () => { toggleStar(id); renderStudy(); };
  $('toggleEx').onclick = () => { settings.showEx = !settings.showEx; saveSettings(); renderStudy(); };

  if (isNewCard && settings.autoSpeak && jp) speak(w.r);
  startTimer();
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    if (!session || document.hidden) return;
    session.elapsed++;
    const c = document.getElementById('clock');
    if (c) c.textContent = fmtTime(session.elapsed);
    if (session.elapsed % 10 === 0) saveSession();
  }, 1000);
}
function stopTimer() { clearInterval(timer); timer = null; if (session) saveSession(); }

function renderDone() {
  stopTimer();
  const f = finished;
  app.innerHTML = `
  <header class="bar"><a class="ic" href="#/" aria-label="回首頁">${I.back}</a><b class="bar-title">${settings.level} 單字學習</b><span class="ic"></span></header>
  <section class="panel done-box">
    <div class="done-mark">✓</div>
    <h2>完成第 ${f.n} 次學習</h2>
    <p class="sub">${f.total} 個單字 · 用時 ${fmtTime(f.elapsed)}</p>
    <button class="primary" id="more">再學一輪</button>
    <a class="secondary" href="#/">回首頁</a>
  </section>`;
  document.getElementById('more').onclick = () => { finished = null; startSession(); if (!session) location.replace('#/'); else renderStudy(); };
}

/* ========== 畫面：單字詳細 ========== */
function renderDetail(id) {
  const w = byId.get(id);
  if (!w) { app.innerHTML = `<header class="bar"><button class="ic" data-back>${I.back}</button></header><p class="hint center">找不到這個單字</p>`; return; }
  const p = progress[id], st = status(id);
  const stChip = { new: '<span class="pill gray">未學習</span>', learning: '<span class="pill blue">學習中</span>', long: '<span class="pill blue">• 長期記憶</span>' }[st];
  const dueChip = p ? (isDue(id) ? '<span class="pill purple">待複習</span>' : `<span class="pill purple">${fmtDate(p.due)} 複習</span>`) : '';

  app.innerHTML = `
  <header class="bar solid">
    <button class="ic" data-back aria-label="返回">${I.back}</button>
    <b class="bar-title left" lang="ja">${esc(w.w)}</b>
    <button class="ic" id="speak" aria-label="發音">${I.speak}</button>
  </header>
  <section class="d-main">
    <div class="badges"><span class="pill orange">${w.lv}</span>${p ? `<span class="pill blue">${daysAgo(p.first)}</span>` : ''}
      <button class="ic star ${stars[id] ? 'on' : ''}" id="star" aria-label="收藏">${I.star}</button></div>
    <h1 class="d-word"><span lang="ja">${esc(w.w)}</span>${w.r !== w.w ? `<span class="d-read" lang="ja">${esc(w.r)}</span>` : ''}</h1>
    <p class="d-mean">${esc(w.m)}</p>
    ${w.p ? `<div class="kv"><span class="tag">詞性</span>${esc(w.p)}</div>` : ''}
    <div class="chips">${stChip}${dueChip}</div>
  </section>
  ${w.ex ? `<section class="d-sec"><h3>例句</h3>
    <div class="ex-line"><p class="ex-jp" lang="ja">${esc(w.ex)}</p><button class="round" id="speakEx" aria-label="朗讀例句">${I.speak}</button></div>
    <p class="ex-zh">${esc(w.exm)}</p></section>` : ''}
  <section class="d-sec"><h3>學習紀錄</h3>
    ${p ? `<div class="kv-list">
      <div><span>第一次學習</span><b>${fmtDate(p.first)}</b></div>
      <div><span>作答次數</span><b>${p.n}</b></div>
      <div><span>忘記次數</span><b>${p.lapses}</b></div>
      <div><span>下次複習</span><b>${isDue(id) ? '現在' : fmtDate(p.due)}</b></div></div>` : '<p class="hint">還沒學過這個單字</p>'}
    <div class="btns">
      <button class="btn-sm" id="markKnown">我已經會了（1 個月後複習）</button>
      ${p ? '<button class="btn-sm" id="resetWord">重新學習這個字</button>' : ''}
    </div>
  </section>`;

  const $ = s => document.getElementById(s);
  $('speak').onclick = () => speak(w.r);
  if ($('speakEx')) $('speakEx').onclick = () => speak(w.ex);
  $('star').onclick = () => { toggleStar(id); renderDetail(id); };
  $('markKnown').onclick = () => {
    const old = progress[id] || { n: 0, lapses: 0, first: Date.now() };
    progress[id] = Object.assign(old, { s: 5, due: startOfDay() + INTERVALS[5] * DAY, last: Date.now() });
    saveProgress(); toast('已標記為長期記憶'); renderDetail(id);
  };
  if ($('resetWord')) $('resetWord').onclick = () => { delete progress[id]; saveProgress(); toast('已重設'); renderDetail(id); };
}

/* ========== 畫面：單字清單 ========== */
const FILTERS = [['all', '全部'], ['new', '未學'], ['due', '待複習'], ['learning', '學習中'], ['long', '長期記憶'], ['learned', '已學習'], ['star', '收藏']];
function matchFilter(w, f, now) {
  switch (f) {
    case 'new': return !progress[w.id];
    case 'due': return isDue(w.id, now);
    case 'learning': return status(w.id) === 'learning';
    case 'long': return status(w.id) === 'long';
    case 'learned': return !!progress[w.id];
    case 'star': return !!stars[w.id];
    default: return true;
  }
}

function renderList(filter) {
  if (!FILTERS.some(f => f[0] === filter)) filter = 'all';
  app.innerHTML = `
  <header class="bar solid">
    <button class="ic" data-back aria-label="返回">${I.back}</button>
    <b class="bar-title left">${settings.level} 單字清單</b><span class="ic"></span>
  </header>
  <div class="sticky-tools">
    <label class="search">${I.search}<input id="q" type="search" placeholder="搜尋單字、讀音或中文" value="${esc(listQuery)}"></label>
    <div class="chip-row">${FILTERS.map(([k, t]) => `<button class="chip ${k === filter ? 'on' : ''}" data-f="${k}">${t}</button>`).join('')}</div>
  </div>
  <p class="count" id="count"></p>
  <div class="items" id="items"></div>`;

  const draw = () => {
    const q = listQuery.trim().toLowerCase(), now = Date.now();
    const list = levelWords().filter(w => matchFilter(w, filter, now) &&
      (!q || w.w.toLowerCase().includes(q) || w.r.includes(q) || w.m.toLowerCase().includes(q)));
    document.getElementById('count').textContent = `共 ${list.length} 個`;
    document.getElementById('items').innerHTML = list.map(w => `
      <a class="item" href="#/word/${encodeURIComponent(w.id)}">
        <span class="dot st-${status(w.id)}"></span>
        <span class="item-w"><b lang="ja">${esc(w.w)}</b>${w.r !== w.w ? `<small lang="ja">${esc(w.r)}</small>` : ''}</span>
        <span class="item-m">${esc(w.m)}</span>
        ${stars[w.id] ? `<span class="star on mini-star">${I.star}</span>` : ''}
      </a>`).join('') || '<p class="hint center">沒有符合的單字</p>';
  };
  draw();
  document.getElementById('q').oninput = e => { listQuery = e.target.value; draw(); };
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => location.replace('#/list/' + b.dataset.f));
}

/* ========== 畫面：設定 ========== */
function parseTable(text) {
  text = text.replace(/^﻿/, '');
  const rows = [], delim = text.includes('\t') ? '\t' : ',';
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(s => s.trim())).filter(r => r.some(Boolean));
}

function importRows(rows, defLv) {
  if (rows.length && /^(單字|单词|word|単語)$/i.test(rows[0][0])) rows.shift();
  let n = 0;
  rows.forEach(([w, r, m, p, ex, exm, lv]) => {
    if (!w || !m) return;
    lv = (lv || '').toUpperCase();
    if (!LEVELS.includes(lv)) lv = defLv;
    const item = { w, r: r || w, m, p: p || '', ex: ex || '', exm: exm || '', lv };
    const i = custom.findIndex(c => c.lv === lv && c.w === item.w && c.r === item.r);
    if (i >= 0) custom[i] = item; else custom.push(item);
    n++;
  });
  store.set('custom', custom);
  rebuild();
  return n;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderSettings() {
  const lv = settings.level;
  app.innerHTML = `
  <header class="bar solid">
    <button class="ic" data-back aria-label="返回">${I.back}</button>
    <b class="bar-title left">設定</b><span class="ic"></span>
  </header>
  <section class="panel">
    <h3>學習方式</h3>
    <div class="set-row"><span>卡片正面</span>
      <div class="seg"><button data-front="jp" class="${settings.front === 'jp' ? 'on' : ''}">日文</button><button data-front="zh" class="${settings.front === 'zh' ? 'on' : ''}">中文</button></div></div>
    <label class="set-row"><span>自動朗讀發音</span><input type="checkbox" class="switch" id="autoSpeak" ${settings.autoSpeak ? 'checked' : ''}></label>
    <div class="set-row"><span>測試日文語音</span><button class="btn-sm" id="testSpeak">播放「こんにちは」</button></div>
    <p class="hint">沒有聲音的話，請到手機「設定 → 系統 → 語言 → 文字轉語音」安裝 Google 語音服務的日文語音。</p>
  </section>

  <section class="panel">
    <h3>匯入自己的單字</h3>
    <p class="hint">一行一個單字，欄位用逗號或 Tab 分隔（可直接從 Excel／Google 試算表複製貼上）：<br>
      <code>單字,讀音,中文,詞性,例句,例句翻譯,級數</code><br>只有前三欄必填；同一個單字再匯入一次會更新內容。</p>
    <textarea id="csv" rows="5" lang="ja" placeholder="例如：&#10;勉強,べんきょう,讀書；學習,名詞,毎日勉強します。,每天讀書。,N5"></textarea>
    <div class="set-row"><span>沒填級數時歸類到</span>
      <div class="select-box small"><select id="impLv">${LEVELS.map(l => `<option ${l === lv ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="caret">▾</span></div></div>
    <div class="btns">
      <label class="btn-sm">選擇 CSV 檔<input type="file" id="csvFile" accept=".csv,.tsv,.txt,text/csv" hidden></label>
      <button class="btn-sm dark" id="doImport">匯入</button>
    </div>
    <p class="hint">Excel 存檔時請選「CSV UTF-8」，否則中文日文會變亂碼。目前有 ${custom.length} 個自訂單字。
      ${custom.length ? '<button class="text-btn" id="clearCustom">全部刪除</button>' : ''}</p>
  </section>

  <section class="panel">
    <h3>備份與還原</h3>
    <p class="hint">學習進度只存在這支手機的瀏覽器裡。清除 Chrome 資料或換手機前，記得先下載備份。</p>
    <div class="btns">
      <button class="btn-sm" id="backup">下載備份</button>
      <label class="btn-sm">還原備份<input type="file" id="restore" accept=".json,application/json" hidden></label>
    </div>
  </section>

  <section class="panel">
    <h3>重設</h3>
    <button class="btn-sm danger" id="resetLv">清除 ${lv} 的所有學習進度</button>
  </section>`;

  const $ = s => document.getElementById(s);
  app.querySelectorAll('[data-front]').forEach(b => b.onclick = () => { settings.front = b.dataset.front; saveSettings(); renderSettings(); });
  $('autoSpeak').onchange = e => { settings.autoSpeak = e.target.checked; saveSettings(); };
  $('testSpeak').onclick = () => speak('こんにちは');
  $('csvFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { $('csv').value = r.result; toast('已讀取檔案，按「匯入」完成'); };
    r.readAsText(f, 'utf-8');
  };
  $('doImport').onclick = () => {
    const n = importRows(parseTable($('csv').value), $('impLv').value);
    if (!n) return toast('沒有可匯入的資料，請確認格式');
    toast(`已匯入 ${n} 個單字`); renderSettings();
  };
  if ($('clearCustom')) $('clearCustom').onclick = () => {
    if (!confirm('確定刪除所有自訂單字？（學習進度不會刪除）')) return;
    custom = []; store.set('custom', custom); rebuild(); renderSettings();
  };
  $('backup').onclick = () => download(`日檢單字備份-${today()}.json`,
    JSON.stringify({ app: 'jlpt-vocab', version: 1, settings, progress, stars, custom, daily }));
  $('restore').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (d.app !== 'jlpt-vocab') throw new Error();
        if (!confirm('還原會覆蓋目前的學習進度，確定嗎？')) return;
        settings = Object.assign(settings, d.settings); progress = d.progress || {}; stars = d.stars || {};
        custom = d.custom || []; daily = d.daily || daily; session = null;
        saveSettings(); saveProgress(); store.set('stars', stars); store.set('custom', custom); store.set('daily', daily); saveSession();
        rebuild(); toast('已還原備份'); renderSettings();
      } catch (err) { toast('這不是正確的備份檔'); }
    };
    r.readAsText(f, 'utf-8');
  };
  $('resetLv').onclick = () => {
    if (!confirm(`確定清除 ${lv} 的所有學習進度？這個動作無法復原。`)) return;
    levelWords(lv).forEach(w => delete progress[w.id]);
    if (session && session.lv === lv) session = null;
    saveProgress(); saveSession(); toast('已清除'); renderSettings();
  };
}

/* ========== 路由 ========== */
function route() {
  const [, view, arg] = (location.hash.slice(1) || '/').split('/');
  if (view !== 'study') stopTimer();
  document.body.dataset.view = view || 'home';
  if (view === 'study') renderStudy();
  else if (view === 'word') renderDetail(decodeURIComponent(arg || ''));
  else if (view === 'list') renderList(arg);
  else if (view === 'settings') renderSettings();
  else renderHome();
  window.scrollTo(0, 0);
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-back]')) {
    if (history.length > 1) history.back(); else location.hash = '#/';
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && session) saveSession(); });
window.addEventListener('hashchange', route);

rebuild();
route();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js');
}
