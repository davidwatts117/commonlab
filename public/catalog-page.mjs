import { loadCatalog } from './simulation-schema.mjs';

// Static thumbnail figures for the built-in labs. Trusted constants only:
// submitted simulations never supply markup and get a plain graph-paper thumb.
const FIGURES = {
  pendulum: '<line x1="80" y1="14" x2="160" y2="14" stroke="#2d2d2a" stroke-width="2"/><line x1="120" y1="14" x2="120" y2="118" stroke="#848fa5" stroke-dasharray="4 4"/><path d="M78 98 A92 92 0 0 0 162 98" fill="none" stroke="#848fa5" stroke-dasharray="2 5"/><line x1="120" y1="14" x2="154" y2="99" stroke="#2d2d2a" stroke-width="2"/><circle cx="154" cy="99" r="11" fill="#c14953" stroke="#2d2d2a" stroke-width="2"/><circle cx="120" cy="14" r="4" fill="#e5dcc5" stroke="#2d2d2a" stroke-width="2"/>',
  circuits: '<g fill="none" stroke="#2d2d2a" stroke-width="2" stroke-linejoin="round"><polyline points="60,30 100,30 104,22 112,38 120,22 128,38 136,22 140,30 180,30 180,100 132,100"/><polyline points="108,100 60,100 60,72"/><polyline points="60,58 60,30"/></g><line x1="48" y1="72" x2="72" y2="72" stroke="#2d2d2a" stroke-width="2"/><line x1="53" y1="58" x2="67" y2="58" stroke="#2d2d2a" stroke-width="4"/><circle cx="120" cy="100" r="12" fill="#e5dcc5" stroke="#c14953" stroke-width="2"/><text x="120" y="105" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="13" fill="#892f35">A</text>',
  projectile: '<line x1="20" y1="112" x2="224" y2="112" stroke="#2d2d2a" stroke-width="2"/><path d="M44 104 Q120 -20 200 112" fill="none" stroke="#c14953" stroke-width="2" stroke-dasharray="3 6"/><g transform="rotate(-48 40 106)"><rect x="34" y="99" width="30" height="13" fill="#4c4c47" stroke="#2d2d2a" stroke-width="2"/></g><circle cx="38" cy="110" r="8" fill="#e5dcc5" stroke="#2d2d2a" stroke-width="2"/><circle cx="158" cy="48" r="6" fill="#2d2d2a"/>',
  titration: '<polyline points="30,14 30,116 220,116" fill="none" stroke="#2d2d2a" stroke-width="2"/><path d="M32 104 C90 100 112 98 120 88 C124 80 124 40 130 34 C140 26 170 24 216 22" fill="none" stroke="#c14953" stroke-width="2.5"/><line x1="124" y1="60" x2="124" y2="116" stroke="#848fa5" stroke-dasharray="3 4"/><circle cx="124" cy="60" r="5" fill="#e5dcc5" stroke="#2d2d2a" stroke-width="2"/><text x="36" y="26" font-family="IBM Plex Mono, monospace" font-size="12" fill="#4c4c47">pH</text>',
  'gas-laws': '<polyline points="70,20 70,118 170,118 170,20" fill="none" stroke="#2d2d2a" stroke-width="2"/><rect x="71" y="40" width="98" height="10" fill="#4c4c47"/><line x1="120" y1="40" x2="120" y2="8" stroke="#2d2d2a" stroke-width="4"/><g fill="#c14953"><circle cx="86" cy="70" r="4"/><circle cx="112" cy="62" r="4"/><circle cx="148" cy="74" r="4"/><circle cx="98" cy="100" r="4"/><circle cx="130" cy="92" r="4"/><circle cx="156" cy="104" r="4"/><circle cx="120" cy="80" r="4"/><circle cx="82" cy="108" r="4"/></g>',
  'states-of-matter': '<g fill="#2d2d2a"><circle cx="30" cy="54" r="5"/><circle cx="44" cy="54" r="5"/><circle cx="58" cy="54" r="5"/><circle cx="30" cy="68" r="5"/><circle cx="44" cy="68" r="5"/><circle cx="58" cy="68" r="5"/><circle cx="30" cy="82" r="5"/><circle cx="44" cy="82" r="5"/><circle cx="58" cy="82" r="5"/></g><g fill="#892f35"><circle cx="104" cy="70" r="5"/><circle cx="117" cy="76" r="5"/><circle cx="110" cy="88" r="5"/><circle cx="126" cy="89" r="5"/><circle cx="132" cy="74" r="5"/><circle cx="99" cy="84" r="5"/><circle cx="120" cy="62" r="5"/></g><g fill="#c14953"><circle cx="176" cy="32" r="5"/><circle cx="212" cy="48" r="5"/><circle cx="188" cy="76" r="5"/><circle cx="218" cy="98" r="5"/><circle cx="172" cy="104" r="5"/><circle cx="200" cy="18" r="5"/></g><g font-family="IBM Plex Mono, monospace" font-size="11" fill="#4c4c47" text-anchor="middle"><text x="44" y="122">solid</text><text x="116" y="122">liquid</text><text x="196" y="122">gas</text></g>',
  'build-a-nucleus': '<ellipse cx="120" cy="65" rx="88" ry="30" fill="none" stroke="#848fa5" stroke-dasharray="3 5"/><ellipse cx="120" cy="65" rx="88" ry="30" fill="none" stroke="#848fa5" stroke-dasharray="3 5" transform="rotate(60 120 65)"/><g stroke="#2d2d2a" stroke-width="2"><circle cx="112" cy="58" r="9" fill="#c14953"/><circle cx="128" cy="58" r="9" fill="#e5dcc5"/><circle cx="104" cy="72" r="9" fill="#e5dcc5"/><circle cx="120" cy="72" r="9" fill="#c14953"/><circle cx="136" cy="72" r="9" fill="#c14953"/><circle cx="120" cy="44" r="9" fill="#e5dcc5"/></g><circle cx="208" cy="65" r="4" fill="#2d2d2a"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const grid = document.getElementById('simulation-catalog');

function span(cls, text) {
  const el = document.createElement('span'); el.className = cls; el.textContent = text; return el;
}

try {
  const catalog = await loadCatalog();
  const communityIds = new Set(catalog.communitySimulationIds || []);
  catalog.simulations.forEach((simulation, index) => {
    const card = document.createElement('a'); card.className = 'sim-card';
    // Query-form links retain compatibility with static hosting as well as Axum.
    card.href = `/simulation.html?id=${simulation.id}`;

    const thumb = document.createElement('span'); thumb.className = 'sim-thumb';
    thumb.append(span('sim-fig', `FIG. 4.${index + 1}`));
    if (FIGURES[simulation.id]) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 240 130'); svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = FIGURES[simulation.id];
      thumb.append(svg);
    }

    const body = document.createElement('span'); body.className = 'sim-body';
    const meta = document.createElement('span'); meta.className = 'sim-meta';
    meta.append(span(`sim-tag ${simulation.subject}`, simulation.subject === 'physics' ? 'Physics' : 'Chemistry'));
    const lessons = simulation.lessons.length;
    if (lessons) meta.append(span('sim-lessons', `${lessons} guided lesson${lessons === 1 ? '' : 's'}`));
    body.append(meta, span('sim-name', simulation.title), span('sim-desc', simulation.summary));

    const launch = document.createElement('span'); launch.className = 'sim-launch';
    launch.append(span('', 'Launch'), span('', '→'));
    launch.lastChild.setAttribute('aria-hidden', 'true');

    card.append(thumb, body, launch);
    const group = communityIds.has(simulation.id) ? 'community' : 'original';
    document.getElementById(`${group}-simulations`).append(card);
  });
  for (const group of ['original', 'community']) {
    document.getElementById(`${group}-simulations-empty`).hidden = document.getElementById(`${group}-simulations`).children.length > 0;
  }
  grid.hidden = false;
  document.getElementById('catalog-status').hidden = true;
} catch (error) {
  const status = document.getElementById('catalog-status'); status.textContent = `Unable to load simulations: ${error.message}`; status.setAttribute('role', 'alert');
}
