import { contributorRequest, currentContributor } from './contributor-api.mjs';
const $ = id => document.getElementById(id);
function message(text, error = false) { $('account-status').textContent = text; $('account-status').setAttribute('role', error ? 'alert' : 'status'); }
function display(account) {
  $('account-form').hidden = !!account; $('account-signed-in').hidden = !account;
  $('account-name').textContent = account ? `Signed in as ${account.username}` : '';
  $('account-password').value = ''; $('account-confirm').value = '';
  message(account ? 'Your contributor session is active.' : 'Sign in to submit simulations, or create an account.');
  const link = document.querySelector('a[href="/generate.html"]');
  link.hidden = true;
  if (account) contributorRequest('/api/generation/config').then(config => {
    if (!$('account-signed-in').hidden && $('account-name').textContent === `Signed in as ${account.username}`) {
      link.hidden = !config.allowed; link.textContent = 'Generate a simulation with AI →';
    }
  }).catch(() => {});
}
$('account-action').addEventListener('change', () => {
  const registration = $('account-action').value === 'register';
  $('confirm-label').hidden = !registration; $('account-confirm').required = registration;
  $('account-password').autocomplete = registration ? 'new-password' : 'current-password';
  $('account-submit').textContent = registration ? 'Create account' : 'Sign in';
});
$('account-form').addEventListener('submit', async event => {
  event.preventDefault(); $('account-submit').disabled = true;
  try {
    const password = $('account-password').value;
    if ($('account-action').value === 'register' && password !== $('account-confirm').value) throw new Error('Passwords do not match.');
    display(await contributorRequest(`/api/auth/${$('account-action').value}`, { method: 'POST', body: { username: $('account-username').value, password } }));
  } catch (error) { $('account-password').value = ''; $('account-confirm').value = ''; message(error.message, true); }
  finally { $('account-submit').disabled = false; }
});
$('account-logout').addEventListener('click', async () => {
  $('account-logout').disabled = true;
  try { await contributorRequest('/api/auth/logout', { method: 'POST' }); display(null); }
  catch (error) { message(error.message, true); }
  finally { $('account-logout').disabled = false; }
});
try { display(await currentContributor()); } catch (error) { message(error.message, true); }
window.addEventListener('pagehide', () => { $('account-password').value = ''; $('account-confirm').value = ''; });
