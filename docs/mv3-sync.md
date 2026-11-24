# Cross-device sync via Google Drive (planned — not yet implemented)

**Status:** design only. On this build the "Cloud storage support" feature is **greyed out and
unchecked** (`platform/chromium-mv3/mv3-post.js` sets `µb.cloudStorageSupported = false`), rendered
the same way as "Uncloak canonical names". This document records the only viable way to bring
cross-device sync back, so it can be implemented when wanted.

## Why native Google-account sync is impossible here
uBO's Cloud storage IS `chrome.storage.sync` — "your browser does this through its sync feature"
(Google Account on Chrome). Chromium's `chrome/common/extensions/sync_helper.cc` `IsSyncable()`
excludes this extension on **two** independent counts:
- **Install location** — syncable requires `location() == kInternal && !was_installed_by_default()`
  (a Web Store install) or a hard-coded component id. A force-install via
  `ExtensionInstallForcelist` has a policy/external location → "non-standard location… return false".
- **Update URL** — `if (GetUpdateURL not empty && !UpdatesFromGallery) return false;`. Our
  `external_update_url` is self-hosted (non-gallery) → rejected here too.

So the native feature's API runs but its data never leaves the device to the account. This is a
browser-level exclusion; nothing the extension does flips it on stock Chrome. (Patching Chromium's
`IsSyncable` would work only on a custom browser build, not stock Chrome — out of scope here.)

## Current state on this build
`mv3-post.js` forces `µb.cloudStorageSupported = false`, so the feature is genuinely off:
`src/js/cloud-ui.js` leaves each per-pane cloud widget hidden. The Settings checkbox is greyed out
and unchecked **exactly like "Uncloak canonical names"**: `mv3-post.js` wraps
`vAPI.messaging.defaultHandler` (after `messaging.js` registers it via `vAPI.messaging.setup()`)
to send `cloudStorageEnabled = undefined` for `userSettings` replies — mirroring the
`cnameUncloakEnabled = undefined` path for cname-uncloaking — so `settings.js` takes its generic
disabled+unchecked path: it disables the `.checkbox` wrapper, which `common.css` greys via
`.checkbox[disabled]` (greying the whole label, not just the input). The wrapper lives in
`mv3-post.js` rather than in a patch to `src/js/messaging.js`, so upstream's file remains
unmodified and the "port adds files, modifies none" zero-conflict invariant holds. Pinned by
`tools/verify-mv3-package.mjs` ("cloud storage greyed out"). Local settings persistence is
separate and unaffected (the IndexedDB `storage.local` mirror in `mv3-post.js`).

## Chosen approach: keep uBO's Cloud UI, swap the transport to Google Drive
Most-similar-to-upstream: keep uBO's Cloud storage feature **unchanged** — the per-pane widget
(export / import / import-and-merge / device-name + timestamp), the manual "global clipboard" model,
the per-category entries (`myFiltersPane`, `tpFiltersPane`, `myRulesPane`, `whitelistPane`), and
uBO's own encode/decode envelope `{ source, tstamp, data }` — and swap **only** the transport under
`vAPI.cloud` from `chrome.storage.sync` to **Google Drive appDataFolder**. Drive REST is not gated by
`IsSyncable`, so it works on stock Chrome for a force-installed off-store build. Manual, per pane —
upstream is explicit that it is a manual clipboard and has repeatedly declined background auto-sync.

`vAPI.cloud` is a plain object on `vAPI`; reassign it in `mv3-post.js` (fork-only) to a Drive-backed
implementation with the SAME five methods and signatures the messaging layer calls:
- `push({datakey, data, encode})` → build `{source,tstamp,data}`, `encode(item)`, write the string to
  a Drive appDataFolder file named per datakey (e.g. `cloud-<datakey>.txt`). One file per pane; no
  chunking (Drive has no ~8 KB item cap that `storage.sync` chunking works around).
- `pull({datakey, decode})` → read that file, `decode()`, return `{source,tstamp,data}`.
- `used(datakey)` → file size + a nominal quota so the capacity strip renders.
- `getOptions`/`setOptions` → device name, persisted via the durable store.
And undo the grey-out: remove the `µb.cloudStorageSupported = false` line **and** the
`vAPI.messaging.defaultHandler` wrapper that zeroes `cloudStorageEnabled`, both in `mv3-post.js`
(plus their verify pins).

## Auth: `chrome.identity.launchWebAuthFlow` + PKCE (NOT `getAuthToken`)
`chrome.identity.getAuthToken` effectively requires the extension to be published to the Chrome Web
Store (Google verifies the item id), which defeats the off-store design. Use `launchWebAuthFlow`
instead — it works for any extension:
- OAuth client type in Google Cloud Console = **Web application**, authorized redirect URI
  `https://<extension-id>.chromiumapp.org/` (the value `chrome.identity.getRedirectURL()` returns).
  Public client, **PKCE (S256)** — no client secret ships in the extension.
- Flow (in the SW, triggered by a user click on a cloud button → message → SW): build the Google auth
  URL (`https://accounts.google.com/o/oauth2/v2/auth`, `response_type=code`, PKCE `code_challenge`,
  `scope=https://www.googleapis.com/auth/drive.appdata`, `redirect_uri=getRedirectURL()`),
  `launchWebAuthFlow({ url, interactive:true })`, then exchange the returned `code` at
  `https://oauth2.googleapis.com/token` (PKCE verifier, no secret) for an access token (~1 h) +
  refresh token. Cache both in the durable store; refresh silently when expired; re-prompt only if
  refresh fails. Manual per-pane use needs a token only at push/pull time, so this is sufficient.

## `UBO_OAUTH_CLIENT_ID` (build-time)
The OAuth **client id** — a public app identifier like `123456-abc.apps.googleusercontent.com`.
- **Not a secret.** Public clients use no client secret; a leaked id can't be abused because Google
  only returns tokens to the allowlisted `chromiumapp.org` redirect after the user's consent screen.
- **Why:** to call Drive the extension must identify itself to Google; the id names your Cloud
  project so Google shows the right consent screen and enforces the redirect allowlist.
- **How it's wired:** the build injects it (env `UBO_OAUTH_CLIENT_ID`, or gitignored
  `dist/oauth-client-id`) into a generated `js/mv3-oauth-config.js` the Drive module imports. Absent →
  empty config → the Drive backend stays dormant (build still succeeds). It's an env var, not
  committed, so public builds don't ship your project's id or burn its quota.

## One-time Google Cloud setup (builder does this; cannot be automated)
1. Create a Google Cloud project; enable the **Google Drive API**.
2. Configure the **OAuth consent screen**: add scope `.../auth/drive.appdata`; while unverified, add
   yourself (and any other device's account) as **test users**.
3. Create credentials → **OAuth client ID** → type **Web application** → add authorized redirect URI
   `https://<extension-id>.chromiumapp.org/` (`<extension-id>` is the stable id from the CRX signing
   key; add a manifest `"key"` to pin it for unpacked dev). Copy the client id.
4. Build with `UBO_OAUTH_CLIENT_ID=<id> bash tools/make-chromium-mv3.sh`.

## Implementation sketch (files, all fork-only / build transforms)
- **New `platform/chromium-mv3/mv3-cloud-drive.js`** — `launchWebAuthFlow`+PKCE token mgmt (cached in
  the durable store) + a tiny Drive appDataFolder client (locate/create/read/update one file per
  datakey). Exports `installDriveCloud()` → a `vAPI.cloud`-shaped object, or `undefined` when
  unconfigured.
- **`mv3-post.js`** — import `js/mv3-oauth-config.js`; if a client id is present, `vAPI.cloud =
  installDriveCloud()` and DROP the `µb.cloudStorageSupported = false` line (and the
  `defaultHandler` wrapper that zeroes `cloudStorageEnabled`) so the UI re-appears.
- **Manifest** (`manifest.overlay.json` + `make-chromium-mv3-meta.py`) — add `identity` and host
  permissions `https://www.googleapis.com/*`, `https://oauth2.googleapis.com/*`; teach the meta
  script to union `host_permissions`/`optional_permissions` from the overlay (today only
  `permissions` is unioned) and to write `js/mv3-oauth-config.js` from `UBO_OAUTH_CLIENT_ID`.
- **`tools/verify-mv3-package.mjs`** — replace the "cloud storage greyed out" pin with: module
  present + imported; generated config present; and CONDITIONAL manifest checks (client id set →
  `identity` + both googleapis host perms present; all absent together otherwise).

## Drive REST (v3), appDataFolder
- locate: `GET /drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)`
- create: `POST /upload/drive/v3/files?uploadType=multipart` with `parents:['appDataFolder']`
- read: `GET /drive/v3/files/{id}?alt=media`
- update: `PATCH /upload/drive/v3/files/{id}?uploadType=media`
All with `Authorization: Bearer <token>`. Files live in the hidden appDataFolder — private to this
app id and the user's account, invisible in the Drive UI.

## Security
- Config goes to the **user's own** Drive appDataFolder (not a third party), opt-in, HTTPS only.
- Access + refresh tokens are cached only in the local durable store (never synced, never logged);
  the refresh token is long-lived, so treat that store as sensitive.
- `drive.appdata` is a "sensitive" scope: an unverified app works for the owner / test users; wide
  distribution would need Google verification.
- Optional, to match upstream's E2E advice (we no longer have Chrome's sync passphrase): encrypt the
  payload with a user passphrase before upload.

