import {
  BYPASS_PROVIDERS as PROVIDERS,
  BYPASS_STAGES as STAGES,
  BYPASS_SETTINGS as CFG,
  BYPASS_MESSAGES as MSG
} from './data/bypass.js';

/* ============================================================
   Util
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const wait = ms => new Promise(r => setTimeout(r, ms));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

const svg = (n, c = '') =>
  `<svg class="i ${c}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#i-${n}"/></svg>`;

/* "idle:clip ok:check" -> deretan ikon yang di-morph lewat [data-s] */
const miInner = spec => spec.trim().split(/\s+/).map(p => {
  const [st, ic] = p.split(':');
  return `<span data-st="${st}"${st === 'busy' ? ' class="sp"' : ''}>${svg(ic, st === 'ok' ? 'dr' : '')}</span>`;
}).join('');
const hydrate = root => root.querySelectorAll('.mi[data-ic]').forEach(n => {
  n.innerHTML = miInner(n.dataset.ic);
  n.removeAttribute('data-ic');
});

const syncLbs = btn => {
  const s = btn.dataset.s;
  btn.querySelectorAll('.lbs>[data-st]').forEach(n => {
    const shown = n.dataset.st === s || (s === 'err' && n.dataset.st === 'idle');
    n.setAttribute('aria-hidden', String(!shown));
  });
};
const setState = (btn, s) => { btn.dataset.s = s; syncLbs(btn); };
const flash = (btn, s, ms = 1600) => {
  setState(btn, s);
  clearTimeout(btn._t);
  btn._t = setTimeout(() => setState(btn, 'idle'), ms);
};

const live = $('#live');
const announce = t => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = t; }); };

function toast(msg, type = 'ok') {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = 't' + (type === 'e' ? ' e' : '');
  t.innerHTML = '<i></i><span></span>';
  t.lastChild.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, CFG.toastMs);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* diabaikan */ }
    ta.remove();
    return ok;
  }
}

/* ============================================================
   Provider & URL (hanya untuk UX; validasi sebenarnya di server)
   ============================================================ */
const normHost = h => h.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

function findProvider(host) {
  const h = normHost(host);
  return PROVIDERS.find(p => p.domains.some(d => h === d || h.endsWith('.' + d))) || null;
}

function parseUrl(raw) {
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u;
  } catch { return null; }
}

function safeHttpUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}

class BypassError extends Error {
  constructor(code, stage, message, vars) {
    super(message || fmt(MSG[code] || MSG.UNKNOWN, vars));
    this.code = code;
    this.stage = stage;
  }
}

/* ============================================================
   Progress indicator (lima tahapan)
   ============================================================ */
const stagesEl = $('#stages');
const statusEl = $('#status');
const IDLE_TEXT = 'Siap memproses. Tempel link di bawah lalu tekan Bypass.';
const pstate = $('#pstate');
const WORD = { idle: 'menunggu', busy: 'sedang berjalan', ok: 'selesai', err: 'gagal' };
const PWORD = { idle: 'Siap', busy: 'Memproses', ok: 'Selesai', err: 'Gagal' };
const st = STAGES.items.map(() => 'idle');
const nodes = [];
let current = null; // provider yang terdeteksi

function stageLabel(i) {
  const it = STAGES.items[i];
  if (st[i] === 'err' && it.failLabel) return it.failLabel;
  return it.label.replace('{provider}', current ? current.processingLabel : STAGES.providerFallback);
}

function buildStages() {
  STAGES.items.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'stage';
    li.dataset.s = 'idle';
    li.innerHTML =
      `<span class="sq"><span class="mi">${miInner(`idle:${it.icon} busy:spin ok:check err:x`)}</span></span>` +
      '<span class="sl"><span class="lt"></span><span class="sr"></span></span>';
    stagesEl.appendChild(li);
    nodes.push({ li, lt: li.querySelector('.lt'), sr: li.querySelector('.sr') });
  });
  paintAll();
}

function paint(i) {
  const l = stageLabel(i);
  nodes[i].li.dataset.s = st[i];
  nodes[i].lt.textContent = l;
  nodes[i].sr.textContent = ` (${WORD[st[i]]})`;
  nodes[i].li.title = l;
}
const paintAll = () => st.forEach((_, i) => paint(i));

function setStage(i, s) {
  st[i] = s;
  paint(i);
  const last = i === st.length - 1;
  if (s === 'busy') {
    announce(`Langkah ${i + 1} dari ${st.length}: ${stageLabel(i)}`);
    setStatus(`[${i + 1}] ${stageLabel(i)}`, 'cur');
  } else if (last && (s === 'ok' || s === 'err')) {
    setStatus(`[${i + 1}] ${stageLabel(i)}`, s === 'ok' ? 'done' : 'bad');
  }
}
const resetStages = () => { st.fill('idle'); paintAll(); setStatus(IDLE_TEXT, ''); };

/* Satu teks status dinamis (tinggi tetap, tidak menambah panjang panel) */
function setStatus(text, kind) {
  if (statusEl.textContent === text && statusEl.dataset.k === (kind || '')) return;
  statusEl.textContent = text;
  statusEl.dataset.k = kind || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  statusEl.classList.remove('sw');
  void statusEl.offsetWidth;
  statusEl.classList.add('sw');
}

function setPanel(s) {
  pstate.dataset.s = s;
  pstate.querySelector('b').textContent = PWORD[s];
}

/* ============================================================
   Elemen & state
   ============================================================ */
const form = $('#form');
const input = $('#url');
const field = $('#field');
const ferr = $('#ferr');
const goBtn = $('#go');
const pasteBtn = $('#paste');
const copyBtn = $('#copy');
const openLink = $('#open');
let busy = false;

function showError(msg, bad = false) {
  ferr.innerHTML = `${svg('alert', 's')}<span></span>`;
  ferr.lastChild.textContent = msg;
  ferr.hidden = false;
  field.classList.toggle('bad', bad);
  if (bad) {
    field.classList.remove('sh');
    void field.offsetWidth;
    field.classList.add('sh');
  }
}
function hideError() {
  ferr.hidden = true;
  field.classList.remove('bad', 'sh');
}

/* ============================================================
   Adapter API generik — tidak ada kondisi per provider
   Request : POST { url }
   Sukses  : { success:true, provider, targetUrl, message }
   Gagal   : { success:false, provider, error:{ code, message } }
   ============================================================ */
function post(provider, url, signal) {
  return fetch(provider.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url }),
    signal,
    cache: 'no-store',
    credentials: 'same-origin'
  });
}

async function run() {
  if (busy) return;
  busy = true;
  hideError();
  setState(goBtn, 'busy');
  goBtn.setAttribute('aria-disabled', 'true');
  setPanel('busy');
  resetStages();

  let cur = 0, timer = 0;
  const ctrl = new AbortController();

  try {
    /* [1] Membaca URL — tahap lokal, nyata */
    setStage(0, 'busy');
    const raw = input.value.trim();
    await wait(CFG.stepDelayMs);
    if (!raw) throw new BypassError('EMPTY_URL', 0);
    setStage(0, 'ok');

    /* [2] Memvalidasi URL — tahap lokal, nyata */
    cur = 1;
    setStage(1, 'busy');
    await wait(CFG.stepDelayMs);
    const url = parseUrl(raw);
    if (!url) throw new BypassError('INVALID_URL', 1);
    const provider = findProvider(url.hostname);
    if (!provider) throw new BypassError('UNSUPPORTED_DOMAIN', 1);
    if (!provider.enabled) throw new BypassError('PROVIDER_DISABLED', 1);
    current = provider;
    setStage(1, 'ok');
    paint(3);

    /* [3] Menghubungkan Server — selesai hanya saat server benar-benar membalas */
    cur = 2;
    setStage(2, 'busy');
    timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    const res = await post(provider, url.href, ctrl.signal);
    const isJson = /json/i.test(res.headers.get('content-type') || '');
    if (!isJson && [404, 405, 501].includes(res.status)) throw new BypassError('API_UNAVAILABLE', 2);
    setStage(2, 'ok');

    /* [4] Memproses {provider} — selesai hanya saat respons valid diterima */
    cur = 3;
    setStage(3, 'busy');
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ditangani di bawah */ }

    if (data === null) {
      throw res.ok
        ? new BypassError('INVALID_JSON', 3)
        : new BypassError('HTTP_ERROR', 3, null, { status: res.status });
    }
    if (typeof data !== 'object' || Array.isArray(data) || typeof data.success !== 'boolean') {
      throw new BypassError('INVALID_RESPONSE', 3);
    }
    markApi();
    if (!data.success) {
      const e = data.error || {};
      throw new BypassError(e.code || 'BYPASS_FAILED', 3, e.message || MSG.BYPASS_FAILED);
    }
    if (!res.ok) throw new BypassError('HTTP_ERROR', 3, null, { status: res.status });
    if (!data.targetUrl) throw new BypassError('NO_TARGET_URL', 3);
    const target = safeHttpUrl(data.targetUrl);
    if (!target) throw new BypassError('INVALID_TARGET', 3);

    /* [5] Bypass Berhasil */
    setStage(3, 'ok');
    setStage(4, 'ok');
    setPanel('ok');
    showResult(target, provider, url.hostname);
    setState(goBtn, 'ok');
    toast(data.message || 'Bypass berhasil');
    announce('Bypass berhasil. Link tujuan tersedia di panel Hasil Bypass.');
    setTimeout(() => { if (!busy && goBtn.dataset.s === 'ok') setState(goBtn, 'idle'); }, 1800);
  } catch (e) {
    let err = e;
    if (!(e instanceof BypassError)) {
      err = new BypassError(
        e && e.name === 'AbortError' ? 'TIMEOUT' : e instanceof TypeError ? 'NETWORK_ERROR' : 'UNKNOWN',
        cur
      );
    }
    setStage(err.stage, 'err');
    if (err.stage < st.length - 1) setStage(st.length - 1, 'err');
    setPanel('err');
    setState(goBtn, 'idle');
    const inputIssue = ['EMPTY_URL', 'INVALID_URL', 'UNSUPPORTED_DOMAIN', 'PROVIDER_DISABLED'].includes(err.code);
    showError(err.message, inputIssue);
    if (inputIssue) input.focus({ preventScroll: true });
    announce('Bypass gagal. ' + err.message);
  } finally {
    clearTimeout(timer);
    busy = false;
    goBtn.removeAttribute('aria-disabled');
  }
}

/* ============================================================
   Hasil
   ============================================================ */
function showResult(target, provider, host) {
  $('#res-empty').hidden = true;
  const ok = $('#res-ok');
  ok.hidden = false;
  ok.style.animation = 'none'; void ok.offsetWidth; ok.style.animation = '';
  $('#res-src').textContent = `${normHost(host)} (${provider.name})`;
  $('#res-url').textContent = target;
  openLink.href = target;
  setState(copyBtn, 'idle');
  $('#hasil').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
}

copyBtn.addEventListener('click', async () => {
  const t = $('#res-url').textContent;
  if (!t) return;
  if (await copyText(t)) { flash(copyBtn, 'ok'); toast('Link tujuan disalin'); }
  else toast('Gagal menyalin. Salin manual dari kotak link.', 'e');
});

function markApi() {
  const f = $('#api-state');
  f.dataset.s = 'ok';
  f.querySelector('b').textContent = 'Frontend siap | API terhubung';
}

/* ============================================================
   Input & paste
   ============================================================ */
let hintT = 0;
function onInput() {
  hideError();
  if (busy) return;
  if (st.some(s => s !== 'idle')) { resetStages(); setPanel('idle'); }
  clearTimeout(hintT);
  hintT = setTimeout(() => {
    const u = parseUrl(input.value.trim());
    const p = u ? findProvider(u.hostname) : null;
    if (p !== current) { current = p; paint(3); }
  }, 160);
}
input.addEventListener('input', onInput);
input.addEventListener('paste', () => setTimeout(() => { input.value = input.value.trim(); onInput(); }, 0));

pasteBtn.addEventListener('click', async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) { flash(pasteBtn, 'err'); toast('Clipboard kosong', 'e'); return; }
    input.value = t;
    onInput();
    input.focus({ preventScroll: true });
    flash(pasteBtn, 'ok');
    toast('Link berhasil ditempel');
  } catch {
    flash(pasteBtn, 'err');
    toast('Izin clipboard ditolak. Tempel manual ke kolom.', 'e');
  }
});

form.addEventListener('submit', e => { e.preventDefault(); run(); });

/* ============================================================
   Marquee dua arah (domain diambil dari konfigurasi)
   ============================================================ */
function mkItem(d, p) {
  const li = document.createElement('li');
  li.className = 'pv';
  const logo = document.createElement('img');
  logo.src = p.icon; logo.alt = ''; logo.width = 30; logo.height = 30; logo.decoding = 'async';
  logo.dataset.mono = p.name.charAt(0).toUpperCase();
  const name = document.createElement('span');
  name.className = 'd'; name.textContent = d;
  li.append(logo, name);
  return li;
}

function ghost(node) {
  const c = node.cloneNode(true);
  c.setAttribute('aria-hidden', 'true');
  c.dataset.clone = '1';
  return c;
}

function fit(mq) {
  const [a, b] = mq.firstChild.children;
  a.querySelectorAll('[data-clone]').forEach(n => n.remove());
  const setW = a.scrollWidth || 1;
  const copies = Math.max(1, Math.ceil(mq.clientWidth / setW));
  const base = [...a.children];
  for (let i = 1; i < copies; i++) base.forEach(n => a.appendChild(ghost(n)));
  b.replaceChildren(...[...a.children].map(ghost));
  mq.firstChild.style.setProperty('--dur', (a.scrollWidth / CFG.marqueeSpeed).toFixed(1) + 's');
}

function buildMarquee() {
  const host = $('#mqs');
  const items = PROVIDERS.filter(p => p.enabled).flatMap(p => p.domains.map(d => ({ d, p })));
  $('#sup-count').textContent = `${items.length} domain kompatibel saat ini.`;
  const half = Math.ceil(items.length / 2);
  [items.slice(0, half), items.slice(half)].forEach((row, r) => {
    if (!row.length) return;
    const mq = document.createElement('div');
    mq.className = 'mq' + (r === 1 ? ' rev' : '');
    mq.tabIndex = 0;
    mq.setAttribute('role', 'group');
    mq.setAttribute('aria-label', `Domain yang didukung, baris ${r + 1}`);
    const track = document.createElement('div');
    track.className = 'track';
    const a = document.createElement('ul'); a.className = 'grp';
    const b = document.createElement('ul'); b.className = 'grp'; b.setAttribute('aria-hidden', 'true');
    row.forEach(({ d, p }) => a.appendChild(mkItem(d, p)));
    track.append(a, b);
    mq.appendChild(track);
    /* logo gagal dimuat -> monogram sederhana */
    mq.addEventListener('error', e => {
      const img = e.target;
      if (img.tagName !== 'IMG') return;
      const m = document.createElement('span');
      m.className = 'mono'; m.textContent = img.dataset.mono || '?';
      img.replaceWith(m);
    }, true);
    host.appendChild(mq);
  });
  const all = () => host.querySelectorAll('.mq').forEach(fit);
  all();
  let t = 0;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(all, 200); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(all);
}

/* ============================================================
   Background titik (canvas ringan)
   ============================================================ */
function initDots() {
  const cv = $('#bg');
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  let w = 0, h = 0, dots = [], raf = 0, last = 0;
  const count = () => Math.max(18, Math.min(CFG.maxDots, Math.round(w * h / 16000)));
  const mk = () => ({
    x: Math.random() * w, y: Math.random() * h,
    r: .5 + Math.random() * 1.1, o: .12 + Math.random() * .33,
    a: Math.random() * Math.PI * 2, da: (Math.random() - .5) * .3,
    sp: CFG.dotSpeed * (.4 + Math.random() * .6)
  });
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      ctx.fillStyle = `rgba(214,222,235,${d.o})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.2832); ctx.fill();
    }
  };
  const size = () => {
    const nw = cv.clientWidth, nh = cv.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(nw * dpr); cv.height = Math.round(nh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots.forEach(d => { d.x = d.x / (w || nw) * nw; d.y = d.y / (h || nh) * nh; });
    w = nw; h = nh;
    const n = count();
    while (dots.length < n) dots.push(mk());
    dots.length = Math.min(dots.length, n);
    if (reduced()) draw();
  };
  const step = t => {
    const dt = Math.min(50, t - last) / 1000; last = t;
    for (const d of dots) {
      d.da = Math.max(-.4, Math.min(.4, d.da + (Math.random() - .5) * .02));
      d.a += d.da * dt;
      d.x += Math.cos(d.a) * d.sp * dt;
      d.y += Math.sin(d.a) * d.sp * dt;
      if (d.x < -4) d.x = w + 4; else if (d.x > w + 4) d.x = -4;
      if (d.y < -4) d.y = h + 4; else if (d.y > h + 4) d.y = -4;
    }
    draw();
    raf = requestAnimationFrame(step);
  };
  const start = () => { if (reduced() || raf || document.hidden) return; last = performance.now(); raf = requestAnimationFrame(step); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  size();
  if (reduced()) draw(); else start();
  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(size, 150); });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { stop(); size(); if (reduced()) draw(); else start(); });
}

/* ============================================================
   Header & logo
   ============================================================ */
function initLogo() {
  const mark = $('.logo-mark');
  const img = mark.querySelector('img');
  const fallback = () => {
    if (!img.dataset.t) { img.dataset.t = '1'; img.src = 'assets/logo.png'; }
    else mark.innerHTML = '<span class="logo-mono">X</span>';
  };
  img.addEventListener('error', fallback);
  if (img.complete && img.naturalWidth === 0) fallback();
}

/* ============================================================
   Motion controller: initial assembly + bidirectional scroll reveal
   Prinsip dari referensi (asm / fly / play / place / startRv):
   - assembly: elemen terbang dari satu titik asal ke posisinya, stagger ~65ms
   - reveal  : IntersectionObserver + arah scroll (listener pasif), tanpa baca posisi tiap event scroll
   - anti-flicker: histeresis (tampil >=15%, sembunyi <=5%) + jeda minimal sebelum boleh disembunyikan
   ============================================================ */
function initMotion() {
  const root = document.documentElement;
  const EASE = 'cubic-bezier(.16,1,.3,1)';
  const UNITS = 'header,.hero>*,#proses,#hasil,#didukung .sh,#mqs,#cara .sh,.step,.foot>.w';
  const KIDS = '.stage,.sq,.ct,.empty b,h3,.step p,.empty p,.sh>*,.status,.field,.go';
  const DWELL = 900;          // jeda minimal sebelum elemen boleh disembunyikan lagi (ms)
  const ASM_MS = 2000;        // masa assembly awal
  const units = [...document.querySelectorAll(UNITS)];
  const finish = () => root.classList.remove('hld');

  document.addEventListener('visibilitychange', () => root.classList.toggle('tab-hidden', document.hidden));
  if (reduced() || !('IntersectionObserver' in window) || !Element.prototype.animate) { finish(); return; }

  /* arah scroll: listener pasif, hanya membandingkan scrollY */
  let dY = 1, ly = scrollY;
  addEventListener('scroll', () => { const y = scrollY; if (y !== ly) { dY = y > ly ? 1 : -1; ly = y; } }, { passive: true });

  /* stagger anak: ikon -> heading -> deskripsi -> tombol/field */
  const tier = t => t.matches('.stage,.sq') ? 0 : t.matches('.ct,b,h3,.sh>h2') ? 1 : t.matches('.status,p,.sh>p') ? 2 : 3;
  const stagger = (u, base) => {
    if (!u.matches('#proses,#hasil,.step,.sh')) return;
    let si = 0;
    u.querySelectorAll(KIDS).forEach(t => {
      if (!t.offsetParent || (t.closest('.stage') && !t.matches('.stage'))) return;
      const k = tier(t);
      const delay = base + k * 80 + (t.matches('.stage') ? si++ * 50 : 0);
      t.animate([{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }],
        { duration: 600, delay, easing: EASE, fill: 'backwards' });
    });
  };

  const rowDelay = e => e.matches('.step') ? ([...e.parentNode.children].indexOf(e) % 2) * 70 : 0;

  const show = e => {
    const d = rowDelay(e);
    e._on = true; e._t = performance.now();
    e.classList.add('rv-nt');
    e.style.setProperty('--ry', `${dY * 40}px`);   // masuk dari arah scroll
    e.style.setProperty('--d', d + 'ms');
    void e.offsetWidth;                            // satu elemen, hanya saat masuk
    e.classList.remove('rv-nt', 'rv-off');
    stagger(e, d + 220);
  };
  const hide = e => {
    e._on = false;
    e.style.setProperty('--ry', `${-dY * 24}px`);  // keluar searah scroll
    e.style.setProperty('--d', '0ms');
    e.classList.add('rv-off');
  };
  const judge = e => {
    if (!e._on && e._r >= .15) show(e);
    else if (e._on && e._r <= .05) {
      const left = DWELL - (performance.now() - e._t);
      if (left > 0) { clearTimeout(e._w); e._w = setTimeout(() => judge(e), left + 30); }
      else hide(e);
    }
  };

  const start = () => {
    const vh = innerHeight, now = performance.now();
    const O = { x: innerWidth / 2, y: vh * .4 };   // titik fokus: logo X di tengah layar
    const rects = units.map(e => e.getBoundingClientRect());
    const mark = $('.logo-mark'), logoT = $('.logo-t'), mr = mark.getBoundingClientRect();
    let i = 0;

    units.forEach((e, k) => {
      const r = rects[k];
      e.classList.add('rv', 'rv-nt');
      e._r = 1;
      if (e.matches('header')) { e._on = true; e._t = now + ASM_MS; return; }
      if (r.top >= vh - 20 || !r.width) {          // di bawah fold: langsung siap, muncul saat di-scroll
        e._on = false; e._t = 0; e._r = 0;
        e.style.setProperty('--ry', '40px');
        e.classList.add('rv-off');
        return;
      }
      e._on = true; e._t = now + ASM_MS;
      const d = 520 + i++ * 65;
      const dx = O.x - (r.left + r.width / 2), dy = O.y - (r.top + r.height / 2);
      e.animate([
        { opacity: 0, transform: `translate(${dx}px,${dy}px) scale(.3)` },
        { opacity: 1, offset: .35 },
        { opacity: 1, transform: 'none' }
      ], { duration: 1000, delay: d, easing: EASE, fill: 'backwards' });
      stagger(e, d + 260);
    });

    /* logo X: muncul sendiri di titik fokus, lalu terbang ke posisi header */
    const mx = O.x - (mr.left + mr.width / 2), my = O.y - (mr.top + mr.height / 2);
    const at = `translate(${mx}px,${my}px) scale(2.6)`;
    mark.animate([
      { opacity: 0, transform: at, offset: 0 },
      { opacity: 1, transform: at, offset: .36 },
      { opacity: 1, transform: 'none', offset: 1 }
    ], { duration: 1400, easing: EASE, fill: 'backwards' });
    logoT.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 700, delay: 900, easing: EASE, fill: 'backwards' });

    finish();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      units.forEach(e => e.classList.remove('rv-nt'));
      const io = new IntersectionObserver(es => es.forEach(en => {
        en.target._r = en.isIntersecting ? en.intersectionRatio : 0;
        judge(en.target);
      }), { threshold: [0, .05, .15] });
      units.forEach(e => io.observe(e));
    }));
  };

  const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.race([fontsReady, new Promise(r => setTimeout(r, 900))]).then(start);
}

/* ============================================================
   Init
   ============================================================ */
hydrate(document);
buildStages();
setStatus(IDLE_TEXT, '');
[goBtn, pasteBtn, copyBtn].forEach(b => syncLbs(b));
buildMarquee();
initDots();
initLogo();
initMotion();
