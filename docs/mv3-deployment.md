# Deploying the MV3 build

This fork adds a Chromium **Manifest V3** build of the full uBlock Origin — the real
filtering engine, not the declarativeNetRequest-based uBO Lite that lives in `platform/mv3/`.

Two of the capabilities uBO depends on are gated under MV3. Both are reachable, but neither is
automatic, and **network filtering does nothing until you complete step 3**.

| Capability | Gate | Consequence if not set up |
|---|---|---|
| Blocking `webRequest` (all network filtering) | Extension must be **policy-installed** | No network requests are blocked at all |
| `chrome.userScripts` (scriptlet / `+js(...)` filters) | Per-extension **Allow user scripts** toggle | Scriptlet filters do not inject |

Cosmetic filtering, the element picker and zapper, the logger, and the dashboard all work without
either gate.

## Why MV2 is not an option

`ExtensionManifestV2Availability` — the enterprise policy that used to re-enable MV2 — is marked
deprecated in Chromium's policy definitions, with `supported_on: chrome.*:110-138`. On Chrome 139
and later there is no supported way to run an MV2 extension, which is what this port exists to
address.

## 1. Build

```sh
bash tools/pull-assets.sh            # clone uAssets (once)
bash tools/make-chromium-mv3.sh      # -> dist/build/uBlock0.chromium-mv3/
```

Pass a version to also produce a zip: `bash tools/make-chromium-mv3.sh 1.74.2`.

The MV3 manifest is **generated** from `platform/chromium/manifest.json` by
`tools/make-chromium-mv3-meta.py`, with MV3-specific values coming from
`platform/chromium-mv3/manifest.overlay.json`. It is not checked in, so upstream changes to
permissions or content scripts are picked up automatically rather than drifting.

## 2. Create a signing key and pack a CRX

A policy install needs a CRX with a stable extension ID, which means you sign it yourself.

```sh
openssl genrsa -out crx-key.pem 4096       # keep this safe: it defines your extension ID
node tools/make-crx.mjs \
    --dir dist/build/uBlock0.chromium-mv3 \
    --key crx-key.pem \
    --out dist/build/uBlock0.chromium-mv3.crx \
    --update-xml dist/build/update.xml \
    --codebase https://example.org/uBlock0.chromium-mv3.crx
```

`make-crx.mjs` prints the extension ID derived from your key — you need it for the policy below.
`*.pem` is already in `.gitignore`; never commit the key.

To have releases signed automatically, add the PEM contents as a repository secret named
`CRX_PRIVATE_KEY`. Without it, `release.yml` publishes only the zip and logs a warning.

## 3. Force-install by policy

`webRequestBlocking` is granted only when Chrome considers the extension policy-installed, i.e.
installed through `ExtensionInstallForcelist` or an `ExtensionSettings` entry with
`installation_mode` of `force_installed` or `normal_installed`. Loading the unpacked directory, or
dragging the CRX in, does **not** qualify — Chrome will show a manifest warning that
`webRequestBlocking` requires a policy install, and blocking listeners silently do nothing.

Host `update.xml` and the `.crx` on a server both reachable over HTTPS. Then, replacing
`EXTENSION_ID` with the value `make-crx.mjs` printed:

**Windows** (registry):

```
[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="EXTENSION_ID;https://example.org/update.xml"

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome]
"ExtensionInstallSources"=...            ; optional, see below
```

**Linux** (`/etc/opt/chrome/policies/managed/ublock-mv3.json`):

```json
{
  "ExtensionInstallForcelist": [
    "EXTENSION_ID;https://example.org/update.xml"
  ],
  "ExtensionSettings": {
    "EXTENSION_ID": {
      "installation_mode": "force_installed",
      "update_url": "https://example.org/update.xml"
    }
  }
}
```

**macOS** — the same keys in a configuration profile for `com.google.Chrome`.

Then restart Chrome and check `chrome://policy` (the policy should be listed and applied) and
`chrome://extensions` (the extension should show as installed by enterprise policy, with no
`webRequestBlocking` warning).

`ExtensionInstallSources` is only needed if you also want users to be able to install the CRX
manually from that origin; force-installation does not require it.

## 4. Enable user scripts (for scriptlet filters)

`chrome.userScripts` is the only MV3 API that can inject arbitrary code strings, which is what
uBO's scriptlet filters are. There is currently **no enterprise policy** that pre-grants it, so it
takes one manual step per profile:

- **Chrome 138+**: `chrome://extensions` → uBlock Origin → **Details** → enable **Allow user
  scripts**.
- **Chrome 135–137**: enable **Developer mode** at the top right of `chrome://extensions`.

Until this is done, the service worker logs a single explanatory error and scriptlet filters are
skipped. Everything else keeps working. Revoking the toggle later takes effect on the next service
worker restart.

## 5. Optional: harden the background lifetime

uBO keeps its compiled filter lists in memory, so a service worker eviction costs a full reload of
every list. The port already mitigates this: an offscreen document pings the service worker every
20 seconds, which resets its 30-second idle timer, and a `chrome.alarms` tick re-creates that
document if it ever disappears.

`ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls` (Chrome 112+) can reinforce this —
extensions connecting to a listed origin are kept running for as long as the port is connected:

```json
{
  "ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls": [
    "chrome-extension://EXTENSION_ID/"
  ]
}
```

This is belt-and-braces, not a requirement. Correctness does not depend on it: uBO already
suspends and queues network requests until its engines are ready (see
`vAPI.Net.setSuspendableListener` in `platform/common/vapi-background.js`), so a cold start delays
filtering rather than letting requests through unfiltered.

## Behavioural differences from the MV2 build

Everything below is a consequence of MV3's platform, not a shortcut in the port.

1. **`:xpath(...)` filters are not syntax-checked at compile time.** A service worker has no XPath
   engine, so `src/js/static-filtering-parser.js`'s validation probe is stubbed out. The filters
   still compile and still work — they are evaluated in the content script, as before. A malformed
   one now fails silently at match time instead of being rejected when the list loads.
2. **Closed shadow DOM is out of reach for isolated-world scriptlets.** They run in the
   `USER_SCRIPT` world, which does not expose the content-script-only
   `chrome.dom.openOrClosedShadowRoot`. `src/js/resources/utils.js` already guards for this and
   falls back to `elem.shadowRoot`, so open shadow roots are unaffected.
3. **`matchAboutBlank` has no equivalent for programmatic injection.** Declarative content scripts
   still use `match_about_blank`, and frame-targeted injection into `about:blank` frames that
   inherit a permitted origin still resolves, so the practical impact is small.
4. **Cold start is slower than a persistent background page.** See step 5.
5. **WebAssembly stays disabled**, exactly as in the MV2 Chromium build. uBO enables its WASM
   fast paths only when the manifest CSP contains `'wasm-unsafe-eval'`, and the generated MV3 CSP
   reproduces the MV2 policy verbatim. To opt in, add it in
   `tools/make-chromium-mv3-meta.py`; the `.wasm` files are already packaged.
6. **The MV2 `chromium` target still exists** and still builds via `tools/make-chromium.sh`. Its
   output no longer installs in Chrome 139+, but it is left untouched on purpose — see below.

## How the port is structured

The design constraint was that a bot must be able to keep this fork merged with upstream without
supervision. So **no existing file is modified**; git can only report a conflict on a file both
sides changed, and this port changes none.

Everything MV3-specific is additive:

| Path | Role |
|---|---|
| `platform/chromium-mv3/sw.js` | Service worker entry, replacing `src/background.html` |
| `platform/chromium-mv3/mv3-shims.js` | Re-creates the MV2 `chrome.*` surface and the DOM globals uBO's background expects, before any uBO module evaluates |
| `platform/chromium-mv3/offscreen.{html,js}` | Hosts web workers (a service worker cannot construct one) and keeps the worker resident |
| `platform/chromium-mv3/manifest.overlay.json` | MV3-only manifest values |
| `tools/make-chromium-mv3.sh` | Build, mirroring `tools/make-chromium.sh` |
| `tools/make-chromium-mv3-meta.py` | Derives the MV3 manifest from the MV2 one |
| `tools/make-crx.mjs` | CRX3 packer and update-manifest generator |

`platform/chromium/webext.js` and `platform/chromium/vapi-background-ext.js` are reused **as-is** —
the shims patch `chrome.*` underneath them — so upstream fixes to those files apply automatically.

## Automation

| Workflow | Trigger | Does |
|---|---|---|
| `.github/workflows/sync-upstream.yml` | daily + manual | Merges `gorhill/uBlock` `master`; tags `<upstream-tag>-mv3` for the newest upstream tag not yet released. On conflict it aborts the merge and opens an issue rather than forcing anything. |
| `.github/workflows/release.yml` | `*-mv3` tag push, or dispatch | Builds, signs the CRX, generates `update.xml`, publishes the release |
| `.github/workflows/build.yml` | push / PR | Builds and asserts the package shape and service worker module graph |

One-time repository setup:

1. **Disable upstream's release workflow**: `gh workflow disable main.yml`. It fires on any tag
   creation and would race with `release.yml`. This is done as a repository setting rather than by
   editing the file, to keep the merge-conflict surface at zero.
2. Add the `CRX_PRIVATE_KEY` secret (step 2 above).
3. Optionally add a `SYNC_TOKEN` secret (a PAT with `contents: write`). Pushes authenticated with
   the default `GITHUB_TOKEN` do not trigger other workflows, so without a PAT `sync-upstream.yml`
   dispatches `release.yml` explicitly instead. Both paths work; the PAT just makes the tag push
   itself the trigger.
