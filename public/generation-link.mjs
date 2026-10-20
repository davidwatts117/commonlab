import { contributorRequest, currentContributor } from './contributor-api.mjs';
let revision = 0;
async function refresh() {
  const current = ++revision;
  const link = document.getElementById('generation-nav');
  link.hidden = true;
  try {
    if (!await currentContributor()) return;
    const config = await contributorRequest('/api/generation/config');
    if (current === revision) link.hidden = !config.allowed;
  } catch { /* Static hosting and signed-out browsing do not need generation. */ }
}
window.addEventListener('focus', refresh);
window.addEventListener('pageshow', refresh);
window.addEventListener('pagehide', () => { ++revision; document.getElementById('generation-nav').hidden = true; });
await refresh();
