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
    --codebase https://example.org/uBlock0.chromium-mv3.crx   # only for a manual build
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

Host the `.crx` and an `update.xml` on servers reachable over HTTPS — or let the release
automation do it for you, which is the supported path here:

- **`update.xml`** is published to GitHub Pages at a **stable URL** that never changes between
  releases: `https://<owner>.github.io/<repo>/update.xml`. This matters because
  `ExtensionInstallForcelist` takes one fixed `EXTENSION_ID;UPDATE_URL` string and Chrome polls it
  forever. A per-release asset URL would give a client exactly one version and then never update it
  again.
- **The `.crx`** is a release asset, and each `update.xml` points at the versioned CRX of the
  release that produced it.

> [!NOTE]
> Do not use `https://github.com/<owner>/<repo>/releases/latest/download/update.xml`. GitHub
> resolves `/releases/latest` to the newest **non-prerelease** release, and this fork marks every
> non-`X.Y.Z` build as a prerelease — which is most of them, since upstream ships roughly six betas
> per stable release. Policy clients would silently stop at the last stable build.

Then, replacing `EXTENSION_ID` with the value `make-crx.mjs` printed:

**Windows** (registry):

```
[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="EXTENSION_ID;https://sketchystan1.github.io/uBlock/update.xml"

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome]
"ExtensionInstallSources"=...            ; optional, see below
```

**Linux** (`/etc/opt/chrome/policies/managed/ublock-mv3.json`):

```json
{
  "ExtensionInstallForcelist": [
    "EXTENSION_ID;https://sketchystan1.github.io/uBlock/update.xml"
  ],
  "ExtensionSettings": {
    "EXTENSION_ID": {
      "installation_mode": "force_installed",
      "update_url": "https://sketchystan1.github.io/uBlock/update.xml"
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

## 5. Recommended: close the cold-start filtering gap

uBO keeps its compiled filter lists in memory, so a service worker eviction costs a full reload of
every list. The port already mitigates this: an offscreen document pings the service worker every
20 seconds, which resets its 30-second idle timer, and a `chrome.alarms` tick re-creates that
document if it ever disappears. (Offscreen documents are not subject to background-tab timer
throttling — Chromium creates them as nominally visible — so the 20-second interval holds.)

**A cold start is nevertheless an unfiltered window, and by default uBO does not close it.**
`vAPI.Net.canSuspend()` returns `false` on Chromium (`platform/common/vapi-background.js:1378`), and
`src/js/background.js:123` defaults the `suspendUntilListsAreLoaded` user setting to that same
`false`. With it off, `onBeforeSuspendableRequest()` falls through to `onUnprocessedRequest()` and
returns `undefined` — i.e. requests are **allowed** until the engines finish loading.

Under MV2 that mattered once per browser launch, because the background page was persistent. Under
MV3 it recurs on **every** service worker respawn. So turn the setting on:

> `chrome://extensions` → uBlock Origin → Details → Extension options → _Advanced settings_ →
> set **`suspendUntilListsAreLoaded`** to `true`

With it on, `src/js/start.js:225` calls `vAPI.net.suspend()`, and requests are queued and
re-evaluated once the lists are ready (`vAPI.Net.setSuspendableListener`) rather than let through.
The cost is a short stall on the first requests after a worker start.

`ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls` (Chrome 112+) can reduce how often
that happens at all — extensions connecting to a listed origin are kept running for as long as the
port is connected:

```json
{
  "ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls": [
    "chrome-extension://EXTENSION_ID/"
  ]
}
```

This is belt-and-braces rather than a requirement.


## Behavioural differences from the MV2 build

Everything below is a consequence of MV3's platform, not a shortcut in the port — but several are
genuine regressions rather than neutral differences, and they are marked as such.

1. **`:xpath(...)` filters are not syntax-checked at compile time.** A service worker has no XPath
   engine, so `src/js/static-filtering-parser.js`'s validation probe is stubbed out. The filters
   still compile and still work — they are evaluated in the content script, as before. A malformed
   one now fails silently at match time instead of being rejected when the list loads.

2. **Scriptlets run in a third world, and this costs four things.** ⚠️ *Regression.*
   `chrome.userScripts` is the only MV3 API that can inject a code string, and its only non-`MAIN`
   world is `USER_SCRIPT` — there is no `ISOLATED` option. Under MV2, `tabs.executeScript({code})`
   landed in the *same* isolated world as `contentscript.js`; it no longer does, and the two worlds
   provably share no globals (Chromium keys world lookup on host + execution world + world id). So:

   - `self.uBO_scriptletsInjected` is written in `USER_SCRIPT` but read from `ISOLATED` by
     `src/js/contentscript.js:1323`, so `needScriptlets` is permanently true and the background
     recomputes and re-ships the whole scriptlet payload for every frame on every navigation.
   - `src/js/scriptlets/cosmetic-report.js:128` reads the same marker, so the popup panel's
     "extended" section silently loses the scriptlet filters that fired.
   - The scriptlet→logger bridge (`src/js/scriptlet-filtering.js:160`) tests
     `self.vAPI && self.vAPI.messaging`, which is absent in `USER_SCRIPT`, so scriptlet log lines go
     to the page console instead of uBO's logger. `configureWorld({messaging:true})` would *not*
     fix this: user-script messages arrive on `runtime.onUserScriptMessage`, not the `onMessage`
     uBO listens on.
   - **Closed shadow DOM piercing stops working.** `src/js/resources/utils.js:375` needs
     `self.chrome.dom.openOrClosedShadowRoot`, and `chrome.dom` is declared for `content_script` but
     not `user_script`. It falls through to `elem.shadowRoot`, which is `null` for a closed root.
     This worked on MV2 Chromium, so it is a loss, not a constant.

3. **`matchAboutBlank` is silently dropped.** ⚠️ *Regression.* uBO passes it at eight
   `executeScript` call sites, but MV3's `scripting`/`userScripts` have no equivalent — the nearest
   relation, `matchOriginAsFallback`, exists only on `registerContentScripts`. Declarative content
   scripts still use `match_about_blank`, so the loss is limited to programmatic injection into
   `about:blank` / `srcdoc` frames.

4. **A cold start is an unfiltered window unless you opt in.** ⚠️ See step 5 — this is the most
   consequential item on this list, and it is one setting away from being fixed.

5. **WebAssembly stays disabled, and the documented opt-in does not currently work.** uBO enables
   its WASM fast paths only when the manifest CSP contains `'wasm-unsafe-eval'`, and the generated
   MV3 CSP reproduces the MV2 policy verbatim, so `vAPI.canWASM` is false and none of this runs.
   Note for anyone tempted to add it in `tools/make-chromium-mv3-meta.py`: both loaders fetch with a
   *relative* path (`src/js/start.js:313` with `'./js/wasm/'`, `src/js/storage.js:1252` with
   `'./lib/publicsuffixlist/wasm/'`), which in a service worker resolves against `/js/` — giving
   `/js/js/wasm/…` and `/js/lib/…`. Both 404, and both errors are swallowed by `ubolog`. Enabling
   the CSP alone would therefore silently disable both engines rather than enable them; the paths
   need absolutising first.

6. **The MV2 `chromium` target still exists** and still builds via `tools/make-chromium.sh`. Its
   output no longer installs in Chrome 139+, but it is left untouched on purpose — see below.
   Releases from this fork contain the MV3 package only.


## How the port is structured

The design constraint was that a bot must be able to keep this fork merged with upstream without
supervision. So **no existing file is modified**; git can only report a conflict on a file both
sides changed, and this port changes none.

Everything MV3-specific is additive:

| Path | Role |
|---|---|
| `platform/chromium-mv3/sw.js` | Service worker entry, replacing `src/background.html` |
| `platform/chromium-mv3/mv3-shims.js` | Re-creates the MV2 `chrome.*` surface and the DOM globals uBO's background expects, before any uBO module evaluates |
| `platform/chromium-mv3/mv3-post.js` | The other half: fix-ups that can only be applied *after* uBO's modules have evaluated. Imported by `sw.js` last |
| `platform/chromium-mv3/offscreen.{html,js}` | Hosts web workers (a service worker cannot construct one) and keeps the worker resident |
| `platform/chromium-mv3/manifest.overlay.json` | MV3-only manifest values |
| `tools/make-chromium-mv3.sh` | Build, mirroring `tools/make-chromium.sh` |
| `tools/make-chromium-mv3-meta.py` | Derives the MV3 manifest from the MV2 one |
| `tools/patch-mv3-modules.mjs` | Rewrites uBO's dynamic `import()` calls in the build output (forbidden in a service worker) |
| `tools/verify-mv3-package.mjs` | Asserts the package shape and every upstream assumption the port hard-codes |
| `tools/make-crx.mjs` | CRX3 packer and update-manifest generator |

`platform/chromium/webext.js` and `platform/chromium/vapi-background-ext.js` are reused **as-is** —
the shims patch `chrome.*` underneath them — so upstream fixes to those files apply automatically.

Note the division of labour between the two patch modules: `mv3-shims.js` runs *before* uBO and may
therefore not import anything of uBO's, since that would evaluate a uBO module before its shims
exist and invert the one ordering guarantee the port rests on. Anything needing uBO's own modules
goes in `mv3-post.js` instead. Prefer `mv3-shims.js` where possible — a shim installed before uBO
loads cannot be defeated by load-order surprises.

`tools/patch-mv3-modules.mjs` transforms the **build output**, never the source tree, which is what
keeps the zero-conflict property intact. `tools/verify-mv3-package.mjs` then asserts the transform
actually landed, so an upstream change that moves past it fails the build instead of regressing
silently.

## Automation

| Workflow | Trigger | Does |
|---|---|---|
| `.github/workflows/sync-upstream.yml` | daily + manual | Merges `gorhill/uBlock` `master`, **builds and verifies before pushing anything**, then constructs the release tree (upstream at the tag + this fork's files) and tags it `<upstream-tag>-mv3`. On a conflict, or a merge that no longer builds, it opens an issue and pushes nothing. |
| `.github/workflows/release.yml` | `*-mv3` tag push, or dispatch | Builds and verifies, signs the CRX, publishes the release with checksums and provenance, and deploys `update.xml` to GitHub Pages |
| `.github/workflows/build.yml` | push / PR | Builds and verifies |

Two details worth knowing, both learned the hard way:

- **The release tree is not master.** Tagging the merge commit would ship upstream master's *tip*
  under a tag name it does not correspond to, and take the package version from whatever
  `dist/version` master happened to hold. That one value decides three things at once: the version
  `update.xml` advertises (which is what Chrome compares), whether uBO appends
  `" development build"` to its name, and which filter-list channel `tools/make-assets.sh` selects.
  So the release tree is built as *upstream at the tag* plus this fork's added files — conflict-free
  by construction, because the port adds files and modifies none.
- **`gh` needs `GH_REPO` pinned.** `gh` infers its target repository from git remotes and prefers a
  remote named `upstream` over `origin`. `sync-upstream.yml` adds exactly such a remote, so without
  the pin every `gh` call in that job silently targets `gorhill/uBlock`.

One-time repository setup:

1. **Disable upstream's release workflow**: `gh workflow disable main.yml`. It fires on any tag
   creation and would race with `release.yml`; releases from this fork are MV3-only. This is done as
   a repository setting rather than by editing the file, to keep the merge-conflict surface at zero
   — and `sync-upstream.yml` re-asserts it on every run, since nothing else would.
2. Add the `CRX_PRIVATE_KEY` secret (step 2 above). **Without it there is no CRX, no `update.xml`,
   and therefore no policy install — which means no network filtering at all.** `release.yml` warns
   and publishes the zip alone.
3. **Enable GitHub Pages with Actions as the source**, so `update.xml` gets a stable URL:
   ```sh
   gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
   # release.yml deploys from a *-mv3 tag, but the github-pages environment
   # permits only the default branch by default -- allow the tags too:
   gh api -X POST repos/OWNER/REPO/environments/github-pages/deployment-branch-policies \
     -f name='*-mv3' -f type=tag
   ```
   Skipping the second command makes the deploy fail with an opaque environment-protection error.
4. **Strongly recommended: add a `SYNC_TOKEN` secret** — a PAT with the `workflow` scope (classic:
   `repo` + `workflow`; fine-grained PAT or App: Contents **write** + Workflows **write**).

   Two separate things need it:

   - **Pushing a merge that touches a workflow file.** GitHub refuses any push from a GitHub App
     that creates or updates a file under `.github/workflows/`, and `GITHUB_TOKEN` *is* an App
     installation token. `workflows` is not among the keys a workflow's `permissions:` block can
     request, so this cannot be granted from inside the workflow. Upstream edits
     `.github/workflows/main.yml` regularly — three times in August 2026 alone — so without the
     token the daily sync will eventually stop being able to push at all. `sync-upstream.yml`
     detects this case up front and fails with an explanatory error rather than wasting two builds
     on a push that cannot land.
   - **Firing `release.yml` from the tag push.** Pushes authenticated with `GITHUB_TOKEN` do not
     trigger other workflows, so without a PAT the sync dispatches `release.yml` explicitly. That
     fallback does work; the token just removes a moving part.


Releases are cut for every release-shaped upstream tag, betas and rcs included. Upstream ships
roughly six betas per stable release, and a beta's four-component `dist/version` makes it build as
"uBlock Origin development build" against the dev filter-list channel — which is upstream's own
intent for a beta tag, not a defect. Narrow `TAG_PATTERN` in `sync-upstream.yml` to
`^[0-9]+\.[0-9]+\.[0-9]+$` to track stable releases only.

