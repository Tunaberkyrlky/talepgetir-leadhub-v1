const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

$('connect').addEventListener('click', () => {
  const token = $('token').value.trim();
  if (token.length < 32 || token.length > 128) {
    setStatus('That does not look like a valid pairing token.', 'err');
    return;
  }

  $('connect').disabled = true;
  setStatus('Connecting…');

  chrome.runtime.sendMessage({ type: 'CONNECT_LINKEDIN_FROM_POPUP', token }, (resp) => {
    $('connect').disabled = false;
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message, 'err');
      return;
    }
    if (resp && resp.ok) {
      setStatus('Connected! Return to TG Core to see your account.', 'ok');
      return;
    }
    const e = resp && resp.error;
    const msg = e === 'NOT_LOGGED_IN' ? 'You are not logged into LinkedIn in this browser.'
      : e === 'NO_JSESSIONID' ? 'Could not read the CSRF cookie — reload LinkedIn and retry.'
      : e === 'INVALID_TOKEN' ? 'Invalid pairing token — copy a fresh one from TG Core.'
      : ('Failed: ' + (e || 'unknown'));
    setStatus(msg, 'err');
  });
});
