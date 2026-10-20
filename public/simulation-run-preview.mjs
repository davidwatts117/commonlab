// Explicit, opt-in execution of an unreviewed engine inside an isolated frame.
// The frame is sandboxed without allow-same-origin: it has an opaque origin, so it
// cannot read this page, the contributor session cookie, storage or any app API.
// Its own CSP sets connect-src 'none', so the engine cannot reach the network either.
const START_TIMEOUT_MS = 20_000;

export function runIsolatedPreview(container, { definition, moduleCode, engineId, status }) {
  const iframe = document.createElement('iframe');
  iframe.className = 'isolated-preview';
  iframe.title = 'Isolated simulation preview';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.src = '/sandbox.html';

  let finished = false;
  const settle = (text, error) => {
    if (finished) return;
    if (!error) return;
    finished = true;
    clearTimeout(timer);
    status(text, true);
  };
  const timer = setTimeout(() => settle('The isolated preview did not start. Remove it and check the engine source.', true), START_TIMEOUT_MS);

  function onMessage(event) {
    if (event.source !== iframe.contentWindow) return;
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'commonlab:ready':
        // Sent once the frame's runner is listening; the definition is validated by the caller.
        iframe.contentWindow.postMessage({ type: 'commonlab:run', definition, moduleCode, engineId }, '*');
        break;
      case 'commonlab:height':
        if (Number.isFinite(message.height)) iframe.style.height = `${message.height}px`;
        break;
      case 'commonlab:running':
        clearTimeout(timer); finished = true;
        status('Engine running in an isolated frame — it cannot reach your account, storage or the network.');
        break;
      case 'commonlab:error':
        settle(`Isolated run: ${String(message.message || 'engine error').slice(0, 600)}`, true);
        break;
    }
  }
  addEventListener('message', onMessage);
  container.replaceChildren(iframe);
  return {
    destroy() {
      removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
    },
  };
}
