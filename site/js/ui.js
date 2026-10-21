// Shared helpers: settings, units, icons, toasts, animations, command palette.

// ---------- settings (saved per device in localStorage) ----------
const DEFAULTS = { theme: 'forest', light: false, units: 'tha', crop: 'Palay', reduceMotion: false };

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode: ignore */ }
}

let current = { ...DEFAULTS, ...readJson('agricast.settings', {}) };

export const settings = {
  get: () => current,
  set(patch) {
    current = { ...current, ...patch };
    writeJson('agricast.settings', current);
    applySettings();
    window.dispatchEvent(new CustomEvent('settings-change'));
  },
};

export function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = current.theme;
  if (current.light) r.dataset.mode = 'light'; else delete r.dataset.mode;
  if (current.reduceMotion) r.dataset.motion = 'reduced'; else delete r.dataset.motion;
}

export const store = { read: readJson, write: writeJson };

export const reduced = () =>
  current.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- units and formatting ----------
export const unitLabel = () => (current.units === 'kg' ? 'kg/ha' : 't/ha');
export const toUnit = (v) => (v == null ? null : current.units === 'kg' ? v * 1000 : v);
export const unitDec = () => (current.units === 'kg' ? 0 : 2);
export const fmtYield = (v) => (v == null ? '--' : toUnit(v).toLocaleString('en-US', { minimumFractionDigits: unitDec(), maximumFractionDigits: unitDec() }));
export const fmtNum = (v, d = 0) => (v == null ? '--' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const qLabel = (year, q) => `Q${q} ${year}`;
export const pct = (now, before) => (before ? ((now - before) / before) * 100 : null);

export function deltaHtml(change, text) {
  if (change == null) return `<span class="delta">${text}</span>`;
  const cls = change >= 0 ? 'up' : 'down';
  const arrow = change >= 0 ? '&#9650;' : '&#9660;';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(change).toFixed(1)}% ${text}</span>`;
}

// ---------- icons ----------
const P = {
  hub: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  metrics: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  task: '<path d="M12 21v-9M12 12c-4.5 0-6.5-2-6.5-6.5 4.5 0 6.5 2 6.5 6.5zM12 16c4.5 0 6.5-2 6.5-6.5-4.5 0-6.5 2-6.5 6.5z"/>',
  tune: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};
export function icon(name, size = 22) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;
}
export const riceIcon = (size = 84) => `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
  <path d="M32 58V22"/><path d="M32 22c-5-2-6-7-5-12 5 1 7 6 5 12zM32 22c5-2 6-7 5-12-5 1-7 6-5 12zM32 36c-7-1-11-5-11-11 6 1 10 5 11 11zM32 36c7-1 11-5 11-11-6 1-10 5-11 11zM32 49c-6 0-10-3-11-8 6 0 10 3 11 8zM32 49c6 0 10-3 11-8-6 0-10 3-11 8z"/></svg>`;

// ---------- toasts ----------
export function toast(message, type = 'ok') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- animations ----------
export function countUp(el, to, decimals = 0, ms = 900) {
  const fmt = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (reduced() || to == null) { el.textContent = fmt(to ?? 0); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = fmt(to * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// Elements written as <span data-count="4.18" data-dec="2"> count up when drawn.
export function runCountUps(root) {
  root.querySelectorAll('[data-count]').forEach((el) => countUp(el, Number(el.dataset.count), Number(el.dataset.dec || 0)));
}

let revealObserver = null;
export function setupReveal(root) {
  const items = root.querySelectorAll('.reveal');
  if (reduced() || !('IntersectionObserver' in window)) { items.forEach((i) => i.classList.add('in')); return; }
  revealObserver ??= new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); revealObserver.unobserve(e.target); } });
  }, { threshold: 0.08 });
  items.forEach((el, i) => { el.style.transitionDelay = `${Math.min(i, 6) * 60}ms`; revealObserver.observe(el); });
}

// Slight 3D tilt on cards (mouse only)
export function setupTilt(root) {
  if (reduced() || !window.matchMedia('(pointer: fine)').matches) return;
  root.querySelectorAll('[data-tilt]').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 3).toFixed(2)}deg)`;
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  });
}

// Ripple on every .btn click (installed once on the document)
export function installRipple() {
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn || reduced()) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    btn.appendChild(dot);
    setTimeout(() => dot.remove(), 650);
  });
}

// After a view is drawn: reveal, count-ups, tilt
export function enhance(root) {
  setupReveal(root);
  runCountUps(root);
  setupTilt(root);
}

// ---------- skeletons and states ----------
export function skeletonView() {
  const card = (h) => `<div class="card skel" style="height:${h}px"></div>`;
  return `<div class="view" aria-busy="true" aria-label="Loading the database">
    <div class="skel" style="height:300px;border-radius:40px"></div>
    <div class="grid g4">${card(168)}${card(168)}${card(168)}${card(168)}</div>
    <div class="grid g-main">${card(420)}${card(420)}</div></div>`;
}
export function errorView(message) {
  return `<div class="view"><div class="card errorbox" role="alert">
    ${riceIcon(72)}<h2>Could not load the database</h2>
    <p class="note">${message}</p>
    <button class="btn" id="retryBtn">Retry</button></div></div>`;
}

// ---------- download a file from the browser ----------
export function download(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- command palette (Ctrl+K) ----------
export function setupPalette(getItems) {
  const dlg = document.getElementById('palette');
  const input = document.getElementById('paletteInput');
  const list = document.getElementById('paletteList');
  let shown = [];
  let active = 0;

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = getItems().filter((i) => !q || i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 40);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((i, n) => `<li role="option" data-n="${n}" aria-selected="${n === active}"><span>${i.label}</span><span>${i.hint}</span></li>`).join('')
      : '<li role="option" aria-selected="false"><span>No match</span><span></span></li>';
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const open = () => { if (!dlg.open) dlg.showModal(); input.value = ''; active = 0; draw(); input.focus(); };
  const go = (n) => { const item = shown[n]; if (!item) return; dlg.close(); location.hash = item.href; };

  document.getElementById('searchBtn').addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dlg.open ? dlg.close() : open(); }
  });
  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(active); }
  });
  list.addEventListener('click', (e) => { const li = e.target.closest('li[data-n]'); if (li) go(Number(li.dataset.n)); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
