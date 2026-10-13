import { loadCatalog } from './simulation-schema.mjs';

const grid = document.getElementById('simulation-catalog');
try {
  const catalog = await loadCatalog();
  for (const simulation of catalog.simulations) {
    const card = document.createElement('a'); card.className = 'sim-card';
    // Query-form links retain compatibility with static hosting as well as Axum.
    card.href = `/simulation.html?id=${simulation.id}`;
    for (const [cls, text] of [
      ['sim-name', simulation.title], ['sim-desc', simulation.summary],
      [`sim-tag ${simulation.subject}`, simulation.subject === 'physics' ? 'Physics' : 'Chemistry'],
    ]) {
      const el = document.createElement('span'); el.className = cls; el.textContent = text; card.append(el);
    }
    if (simulation.lessons.length) {
      const badge = document.createElement('span'); badge.className = 'sim-tag'; badge.textContent = `${simulation.lessons.length} guided lesson`; card.append(badge);
    }
    grid.append(card);
  }
  document.getElementById('catalog-status').hidden = true;
} catch (error) {
  const status = document.getElementById('catalog-status'); status.textContent = `Unable to load simulations: ${error.message}`; status.setAttribute('role', 'alert');
}
