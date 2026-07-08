# TG Core — LinkedIn Connector (MV3 extension)

The "connect your LinkedIn from the app" trigger (Faz 1). It reads the team member's
own `li_at` + `JSESSIONID` cookies from their browser (only `chrome.cookies` can see the
HttpOnly `li_at`) and POSTs them, with the browser's real user-agent, to TG Core's
token-gated capture endpoint. The app encrypts them at rest (AES-256-GCM) and pins a
sticky proxy IP per account. This is the same mechanism commercial tools use — LinkedIn
has no official API for connection requests / member DMs.

## Configure (per deployment)

Edit `background.js` → `CONFIG`, and keep three lists in **1:1 sync**:

| What | Where | Rule |
|---|---|---|
| App origin(s) | `background.js` `APP_ORIGINS` **and** `manifest.json` `externally_connectable.matches` | Exact origin(s), **no wildcards** (e.g. `https://staging.example.com`). A shared-domain wildcard like `*.up.railway.app` lets any tenant's site message the extension — don't. |
| Capture host | `manifest.json` `host_permissions` | The app host must be here so the POST **bypasses CORS** (an MV3 service-worker fetch only skips CORS for `host_permissions` hosts). |
| Capture URL | `background.js` `CAPTURE_URL` | The `/api/linkedin/capture` endpoint. **Must be `https://` in production** — the code refuses to POST the session over plaintext to a non-local host. |

## Load (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. Copy the extension **ID** shown (needed if you wire the app's connect page to message it).

## Two connect flows

- **App-driven (production):** the app's `/linkedin/connect#token=…` page messages the
  extension via `externally_connectable` (`{ type: 'CONNECT_LINKEDIN', token }`). *(The
  React connect page is wired in the next Faz-1 slice.)*
- **Manual (testing now):** in TG Core, LinkedIn Accounts → **Connect account** issues a
  pairing token. Open LinkedIn (logged in) in a tab, click this extension, paste the
  token, **Connect**. The account appears in the panel and a `linkedin:validate` job
  probes `/voyager/api/me` through the sticky proxy.

## Security notes

- The pairing token is **single-use, hashed, and expires in 15 min** — it authenticates
  the capture without the extension needing app credentials.
- `onMessageExternal` verifies `sender.origin` against `APP_ORIGINS` (Chrome sets it).
- Cookies are **never logged, stored, or returned** to any caller — they go straight to
  the encrypted store via the single hardcoded `CAPTURE_URL`.
- Minimal permissions: `cookies` + `linkedin.com` host only.
