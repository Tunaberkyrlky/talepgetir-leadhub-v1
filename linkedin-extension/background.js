// MV3 service worker — TG Core LinkedIn connector.
// The ONLY place cookies are read: chrome.cookies can see the HttpOnly `li_at`
// cookie that content scripts / document.cookie cannot. Cookies are read and POSTed
// straight to the token-gated capture endpoint — never stored, logged, or returned.

// ── CONFIG — set per deployment (keep in 1:1 sync with manifest.json) ───────────
//   APP_ORIGINS: origins allowed to message this extension. MUST equal the manifest
//                externally_connectable.matches origins (exact prod host, no wildcards).
//   CAPTURE_URL: the app's PUBLIC capture endpoint. MUST be https:// in production
//                AND the host MUST be in manifest host_permissions (so the fetch
//                bypasses CORS). Cookies are the crown jewels — no plaintext.
const CONFIG = {
  APP_ORIGINS: [
    'http://localhost:5173',
    'http://localhost:3001',
    'https://tg-core-staging-production.up.railway.app',
  ],
  CAPTURE_URL: 'https://tg-core-staging-production.up.railway.app/api/linkedin/capture',
};

// Refuse to POST the session over plaintext to a non-local host (defense against a
// deployer updating APP_ORIGINS for prod but forgetting to switch CAPTURE_URL to https).
function assertSecureCaptureUrl(url) {
  const u = new URL(url);
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !isLocal) {
    throw new Error('CAPTURE_URL must use https — session cookies must not travel over plaintext.');
  }
}

// Build an Accept-Language header value from the browser's language preferences, mirroring
// the q-weighted form a real request sends (first language q=1.0, then decreasing). Caps at
// the server's 256-char limit and falls back to navigator.language / 'en-US'.
function buildAcceptLanguage() {
  const langs = (Array.isArray(navigator.languages) && navigator.languages.length)
    ? navigator.languages
    : [navigator.language || 'en-US'];
  const parts = [];
  for (let i = 0; i < langs.length && i < 10; i++) {
    const q = i === 0 ? '' : ';q=' + (Math.max(0.1, 1 - i * 0.1)).toFixed(1);
    parts.push(langs[i] + q);
  }
  return parts.join(',').slice(0, 256);
}

// Read li_at + JSESSIONID for linkedin.com from the privileged extension context.
async function readLinkedInCookies() {
  const [liAt, jsession] = await Promise.all([
    chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' }),
    chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' }),
  ]);
  if (!liAt || !liAt.value) return { ok: false, error: 'NOT_LOGGED_IN' };
  if (!jsession || !jsession.value) return { ok: false, error: 'NO_JSESSIONID' };
  return { ok: true, li_at: liAt.value, jsessionid: jsession.value };
}

// POST the captured session + pairing token to the app. The server hashes+claims the
// single-use token, encrypts the cookies, and stores them. user_agent MUST be this
// browser's real UA (§3 anti-detection) — the app replays it verbatim on every call.
async function sendToBackend(token, cookies) {
  assertSecureCaptureUrl(CONFIG.CAPTURE_URL);
  const res = await fetch(CONFIG.CAPTURE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: token,
      li_at: cookies.li_at,
      jsessionid: cookies.jsessionid,
      user_agent: navigator.userAgent,
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || null,
      // Real browser Accept-Language (§3 anti-detection) — the app replays it verbatim on
      // every voyager call. navigator.languages preserves the q-order the browser sends.
      accept_language: buildAcceptLanguage(),
      // NOTE(Faz 3): geo (country/city) stays a MANUAL connect-form field — it can't be
      // reliably derived in an extension, and the strategy has the user pick it at connect.
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { const b = await res.json(); detail = b && b.error ? b.error : ''; } catch (_) {}
    throw new Error(detail || ('Capture ' + res.status));
  }
  return res.json();
}

// The pairing token is 64 hex chars; the server schema requires 32–128. Pre-validate
// so a garbage paste fails fast instead of burning a capture-limiter request.
function isValidTokenShape(token) {
  return typeof token === 'string' && token.length >= 32 && token.length <= 128;
}

async function handleConnect(token) {
  if (!isValidTokenShape(token)) return { ok: false, error: 'INVALID_TOKEN' };
  const cookies = await readLinkedInCookies();
  if (!cookies.ok) return cookies; // {ok:false, error:'NOT_LOGGED_IN'|'NO_JSESSIONID'}
  await sendToBackend(token, cookies);
  return { ok: true };
}

// ── Pattern A: message from the TG Core app page (externally_connectable) ──────
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // Trust boundary: Chrome sets sender.origin; verify it against the exact allow-list.
  const origin = sender && sender.origin;
  if (!CONFIG.APP_ORIGINS.includes(origin)) {
    sendResponse({ ok: false, error: 'FORBIDDEN_ORIGIN' });
    return false;
  }
  if (msg && msg.type === 'PING') { sendResponse({ ok: true }); return false; }
  if (msg && msg.type === 'CONNECT_LINKEDIN') {
    handleConnect(msg.token)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true; // keep the channel open for the async response
  }
  sendResponse({ ok: false, error: 'BAD_REQUEST' });
  return false;
});

// ── Pattern B: message from our own popup (manual token — testing fallback) ────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'CONNECT_LINKEDIN_FROM_POPUP') {
    handleConnect(msg.token)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }
  // NOTE: no READ_COOKIES_ONLY handler — cookies are never handed back to any caller.
  return false;
});
