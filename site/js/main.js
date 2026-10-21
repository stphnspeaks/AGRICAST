// Starts the app: loads the database, builds the navigation, routes by URL hash.
import { openDb, Q } from './db.js';
import { applySettings, settings, icon, skeletonView, errorView, installRipple, setupPalette, toast } from './ui.js';
import { destroyCharts } from './charts.js';
import * as hub from './hub.js';
import * as metrics from './metrics.js';
import * as task from './task.js';
import * as tune from './tune.js';

const ROUTES = {
  hub: { label: 'AgriHub', icon: 'hub', view: hub },
  metrics: { label: 'AgriMetrics', icon: 'metrics', view: metrics },
  task: { label: 'AgriTask', icon: 'task', view: task },
  tune: { label: 'AgriTune', icon: 'tune', view: tune },
};

const main = document.getElementById('main');
let ready = false;

function buildNav() {
  const links = Object.entries(ROUTES).map(([id, r]) =>
    `<a href="#/${id}" data-route="${id}"><span class="orb">${icon(r.icon)}</span><span class="label">${r.label}</span></a>`).join('');
  document.getElementById('sideNav').innerHTML = links;
  document.getElementById('dock').innerHTML = links;
  document.getElementById('searchIcon').innerHTML = icon('search', 18);
  document.getElementById('menuBtn').innerHTML = icon('menu');
}

function parseHash() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const id = path.replace(/^\//, '');
  return { id: ROUTES[id] ? id : 'hub', query: new URLSearchParams(query) };
}

function draw() {
  const { id, query } = parseHash();
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${ROUTES[id].label} - AgriCast`;
  if (!ready) return;
  destroyCharts();
  main.innerHTML = '';
  try {
    ROUTES[id].view.render(main, { query });
  } catch (err) {
    console.error(err);
    main.innerHTML = errorView('Something went wrong while drawing this page.');
    document.getElementById('retryBtn').addEventListener('click', draw);
  }
  window.scrollTo(0, 0);
}

// Smooth tab transition (View Transitions API), plain redraw if unsupported
function route() {
  const reduceMotion = settings.get().reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduceMotion && ready) document.startViewTransition(draw);
  else draw();
}

function paletteItems() {
  const items = Object.entries(ROUTES).map(([id, r]) => ({ label: r.label, hint: 'Tab', href: `/${id}` }));
  const { first, last } = Q.years();
  for (let y = last; y >= first; y--) items.push({ label: `Year ${y}`, hint: 'AgriMetrics', href: `/metrics?from=${y}&to=${y}` });
  Q.forecasts('Palay').slice().reverse().forEach((f) =>
    items.push({ label: `Q${f.q} ${f.year}`, hint: f.kind === 'future' ? 'AgriTask · forecast' : 'AgriTask · past quarter', href: `/task?y=${f.year}&q=${f.q}` }));
  return items;
}

async function boot() {
  main.innerHTML = skeletonView();
  ready = false;
  try {
    await openDb();
  } catch (err) {
    console.error(err);
    main.innerHTML = errorView(`${err.message}. Serve the site over HTTP (for example: python -m http.server) and make sure data/agricast.db exists.`);
    document.getElementById('retryBtn').addEventListener('click', boot);
    return;
  }
  ready = true;
  setupPaletteOnce();
  draw();
}

let paletteReady = false;
function setupPaletteOnce() {
  if (paletteReady) return;
  paletteReady = true;
  setupPalette(paletteItems);
}

// sidebar collapse
document.getElementById('menuBtn').addEventListener('click', (e) => {
  const root = document.documentElement;
  const collapsed = root.dataset.sidebar !== 'collapsed';
  if (collapsed) root.dataset.sidebar = 'collapsed'; else delete root.dataset.sidebar;
  e.currentTarget.setAttribute('aria-pressed', String(collapsed));
  try { localStorage.setItem('agricast.sidebar', collapsed ? 'collapsed' : 'open'); } catch (err) { /* ignore */ }
});

applySettings();
installRipple();
buildNav();
window.addEventListener('hashchange', route);
boot();
