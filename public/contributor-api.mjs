export async function contributorRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-CommonLab-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(result.error || `Request failed (HTTP ${response.status}).`); error.status = response.status; throw error; }
  return result;
}
export async function currentContributor() {
  try { return await contributorRequest('/api/auth/me'); }
  catch (error) { if (error.status === 401 || error.status === 404) return null; throw error; }
}
