# Deploying the MV3 build

This fork adds a Chromium **Manifest V3** build of the full uBlock Origin — the real
filtering engine, not the declarativeNetRequest-based uBO Lite that lives in `platform/mv3/`.

Two of the capabilities uBO depends on are gated under MV3. Both are reachable, but neither is
automatic, and **network filtering does nothing until you complete step 3**.

| Capability | Gate | Consequence if not set up |
|---|---|---|
| Blocking `webRequest` (all network filtering) | Extension must be **policy-installed** | No network requests are blocked at all |
| `chrome.userScripts` (scriptlet / `+js(...)` filters) | Per-extension **Allow user scripts** toggle | Scriptlet filters do not inject; the toolbar button shows a `!` badge |

A policy install additionally lets the port hold requests during a cold start rather than cancelling
them — see [step 5](#5-optional-reduce-how-often-a-cold-start-happens).

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

### If `chrome://policy` shows the entry as `[BLOCKED]`

On **Windows and macOS**, writing the policy is not sufficient on its own. Chrome refuses to
force-install an extension from a non-Web-Store update URL unless it considers the device to be
under a management authority it trusts, and a locally-written registry key or plist does not
establish that by itself. Linux has no such requirement — the JSON file in
`/etc/opt/chrome/policies/managed/` is enough.

Either give the device a management authority Chrome recognises:

- **Windows Pro or higher** — join it to Microsoft Entra ID (*Settings → Accounts → Access work or
  school → Join this device to Microsoft Entra ID*), join an Active Directory domain, or enrol it
  in an MDM.
- **macOS** — enrol the Mac in an MDM, or bind it to a directory server (an Open Directory node
  under `/LDAPv3`, or `/Active Directory`).
- **Either** — enrol the browser in Chrome Enterprise Core and set the forcelist entry in the
  Google Admin console, in which case no local registry or plist entry is needed at all.

Once the device is recognised as managed, the local policy above applies and `[BLOCKED]`
disappears. If the device is managed through a domain or MDM, prefer deploying the policy through
that system rather than writing it locally.

### Fallback for an unmanaged machine

If none of that is available, the extension can be installed by hand and given the permission via
a launch flag instead:

1. Remove any `ExtensionInstallForcelist` entry for this extension.
2. On branded Google Chrome — not Chromium — add the extension ID to the machine-level
   `ExtensionInstallAllowlist` policy, or Chrome disables the extension shortly after installation.
   Quit Chrome completely, restart, and confirm the allowlist in `chrome://policy`.
3. Launch Chrome with `--allowlisted-extension-id=EXTENSION_ID`, on **every** launch. Chrome shows
   an unsupported-flag warning; do not silence it with `--test-type`, which changes unrelated
   browser behaviour.
4. In `chrome://extensions`, enable **Developer mode** and drag the CRX onto the page.

This grants `webRequestBlocking`, so network filtering works. It is **not** a policy install,
though, so the async suspension described under [Behavioural
differences](#behavioural-differences-from-the-mv2-build) is unavailable: during the seconds before
the filter lists finish loading, subresource requests are cancelled rather than held, and the
affected tabs are reloaded once uBO is ready.

## 4. Enable user scripts (for scriptlet filters)

`chrome.userScripts` is the only MV3 API that can inject arbitrary code strings, which is what
uBO's scriptlet filters are. There is currently **no enterprise policy** that pre-grants it, so it
takes one manual step per profile:

- **Chrome 138+**: `chrome://extensions` → uBlock Origin → **Details** → enable **Allow user
  scripts**.
- **Chrome 135–137**: enable **Developer mode** at the top right of `chrome://extensions`.

Until this is done, scriptlet filters are skipped and everything else keeps working. The service
worker logs one explanatory error, and the toolbar button shows a `!` badge — the same warning uBO
uses for requests it could not process — so the state is visible without opening the console. The
toggle is re-checked every 30 seconds, so enabling or revoking it takes effect without restarting
anything.

## 5. Optional: reduce how often a cold start happens

uBO keeps its compiled filter lists in memory, so a service worker eviction costs a full reload of
every list. The port already mitigates this: an offscreen document pings the service worker every
20 seconds, which resets its 30-second idle timer, and a `chrome.alarms` tick re-creates that
document if it ever disappears. (Offscreen documents are not subject to background-tab timer
throttling — Chromium creates them as nominally visible — so the 20-second interval holds.)

**A cold start is still an unfiltered window in principle, and on a policy install this port closes
it completely.** uBO handles the window by suspending network activity until the engines are ready,
but what "suspend" means has always been per-platform: Firefox returns a promise from its blocking
listener and resolves it once the lists are loaded, while Chromium MV2 cannot defer a blocking
decision at all and so *cancels* non-main-frame requests instead, reloading the affected tabs
afterwards. That is why `vAPI.Net.canSuspend()` returns `false` on Chromium
(`platform/common/vapi-background.js`), and why `src/js/background.js` in turn defaults the
`suspendUntilListsAreLoaded` user setting to `false` — requests are simply **allowed** through.
Under MV2 that mattered once per browser launch; under MV3 it would recur on every service worker
respawn.

MV3 supplies the missing capability. Chromium honours a promise returned from a blocking
`webRequest` listener when the extension is policy-installed — the same installs that are the only
ones granted `webRequestBlocking` in the first place. `platform/chromium-mv3/mv3-shims.js` detects
that (`chrome.management.getSelf()` reporting an `admin` install type) and patches `vAPI.Net` with
upstream's own Firefox implementation of `suspendOneRequest()` / `unsuspendAllRequests()`. So on a
policy install, requests arriving during a cold start are **held** until the lists are ready and
then decided normally: nothing is let through unfiltered, nothing is cancelled, and no tab is
reloaded.

Making `canSuspend()` true also means uBO suspends from the moment `src/js/traffic.js` evaluates —
the earliest point available — rather than only once user settings have been read from storage, and
that `suspendUntilListsAreLoaded` now defaults on, computed by upstream's own code.

Two qualifications:

- On a **non-policy install** — the launch-flag fallback described above — the promise cannot be
  honoured, so the port falls back to upstream's cancelling behaviour and a page loading during a
  cold start may reload once. `chrome.management.getSelf()` is asynchronous while `canSuspend()` is
  read synchronously, so the handful of requests that may arrive before the answer lands are parked
  optimistically; if the bet turns out wrong they are recorded as unprocessed, which is what
  produces uBO's `!` badge and the tab reload.
- Either way, you can restore the plain upstream Chromium behaviour by unticking:

  > _Settings_ → **Filter lists** → **Suspend network activity until all filter lists are loaded**

  With the setting off, uBO never suspends and requests are allowed through until the engines are
  ready.

`ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls` (Chrome 112+) can reduce how often a
cold start happens at all — extensions connecting to a listed origin are kept running for as long as
the port is connected:

```json
{
  "ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls": [
    "chrome-extension://EXTENSION_ID/"
  ]
}
```

This is belt-and-braces rather than a requirement.


## Behavioural differences from the MV2 build

Everything below is a consequence of MV3's platform, not a shortcut in the port. The list is
deliberately short: where a difference could be closed, it has been, and what remains is what
Chromium does not expose.

1. **`:xpath(...)` filters are not syntax-checked at compile time.** A service worker has no XPath
   engine, so `src/js/static-filtering-parser.js`'s validation probe is stubbed out. The filters
   still compile and still work — they are evaluated in the content script, as before. A malformed
   one now fails silently at match time instead of being rejected when the list loads.

2. **Scriptlets run in a third world.** `chrome.userScripts` is the only MV3 API that can inject a
   code string, and its only non-`MAIN` world is `USER_SCRIPT` — there is no `ISOLATED` option. So
   the wrapper uBO injects lands in `USER_SCRIPT` rather than in the same isolated world as
   `contentscript.js`. This is also how upstream's own MV3 build routes them
   (`platform/mv3/extension/js/compiled-filters.js` maps `ISOLATED` → `world: 'USER_SCRIPT'`), so it
   is the platform's answer, not a workaround.

   Note what this does **not** cost. Main-world scriptlets — the large majority — are unaffected:
   the wrapper inserts them as a `<script>` element, and any world with DOM access can do that.
   Three consequences that did bite have been closed:

   - `self.uBO_scriptletsInjected` is written in `USER_SCRIPT`, but `src/js/contentscript.js` and
     `src/js/scriptlets/cosmetic-report.js` read it from `ISOLATED`.
     `platform/chromium-mv3/mv3-post.js` prefixes the wrapper's output with the filters that fired
     and `mv3-shims.js` replays the marker into `ISOLATED` via
     `chrome.scripting.executeScript({ func, args })` — which needs no code string, and so no
     `userScripts`. So the popup panel's "extended" section lists scriptlet filters again, and the
     background no longer recomputes and re-ships the whole payload for every frame on every
     navigation.
   - The scriptlet→logger bridge tests `self.vAPI && self.vAPI.messaging`
     (`src/js/scriptlet-filtering.js`), which does not exist in `USER_SCRIPT`, so scriptlet log lines
     went to the page console. `mv3-shims.js` now calls
     `chrome.userScripts.configureWorld({ messaging: true })` and prepends a minimal
     `vAPI.messaging.send` to every injection; `mv3-post.js` forwards the resulting
     `chrome.runtime.onUserScriptMessage` into `vAPI.messaging` on the same unprivileged footing a
     content-script port would have had. Scriptlet log lines reach uBO's logger again.

   What remains is one genuine loss: ⚠️ **closed shadow DOM piercing stops working for
   `trusted-click-element`.** `src/js/resources/utils.js`'s `lookupElementsFn` needs
   `self.chrome.dom.openOrClosedShadowRoot` to follow the `>>>` combinator, and `chrome.dom` is
   declared for `content_script` but not `user_script`; it falls through to `elem.shadowRoot`, which
   is `null` for a closed root. There is no way for an extension to grant that API to a
   `USER_SCRIPT` world, so this cannot be shimmed.

   The blast radius is narrow, and worth stating precisely. `lookup-elements.fn` has exactly two
   consumers: `trusted-click-element` (declared `world: 'ISOLATED'`, so affected) and `json-edit`
   (main-world, where `chrome.dom` was never available under MV2 either, so unchanged). The other six
   built-in `world: 'ISOLATED'` scriptlets — `trusted-replace-node-text`, `remove-node-text`,
   `remove-class`, `prevent-refresh`, `close-window`, `multiup` — do not use it. Procedural cosmetic
   filters are also unaffected: `:shadow()` is evaluated by `src/js/contentscript-extra.js`, which is
   a declarative content script and still has `chrome.dom`. So the loss is `+js(trusted-click-element,
   … >>> …)` against a *closed* shadow root, and nothing else.

3. **`matchAboutBlank` is silently dropped.** ⚠️ *Regression.* uBO passes it at ten call sites —
   six `executeScript` (`src/js/messaging.js`, `src/js/scriptlet-filtering.js`) and four
   `insertCSS`/`removeCSS` (`src/js/cosmetic-filtering.js`, `platform/common/vapi-background.js`) —
   but MV3's `scripting`/`userScripts` have no equivalent. The nearest relation,
   `matchOriginAsFallback`, exists only on `registerContentScripts`.

   The declarative content script keeps `match_about_blank: true`, which the manifest generator
   preserves, so `contentscript.js` still runs in `about:blank` frames. What can fail there is the
   *programmatic* follow-up: the stylesheet it asks the background to insert, and scriptlet
   injection. Note this is a limit on what MV3 exposes, not something the port chose — the option
   simply does not exist on those APIs.

4. **WebAssembly stays disabled, matching the MV2 Chromium build.** uBO enables its WASM fast paths
   only when the manifest CSP contains `'wasm-unsafe-eval'`. `platform/chromium/manifest.json` does
   not, so `vAPI.canWASM` is false on MV2 Chromium too, and the generated MV3 CSP reproduces that
   policy verbatim — this is parity, not a gap.

   The opt-in now works, though, which it previously did not: both loaders fetch with a *relative*
   path (`src/js/start.js` with `'./js/wasm/'`, `src/js/storage.js` with
   `'./lib/publicsuffixlist/wasm/'`), which in a service worker used to resolve against `/js/` and
   404 with the error swallowed by `ubolog`. `mv3-shims.js` now resolves relative `fetch()` URLs
   against the package root, as `background.html` did. To enable it, add to
   `platform/chromium-mv3/manifest.overlay.json`:

   ```json
   "content_security_policy": {
     "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
   }
   ```

5. **The MV2 `chromium` target still exists** and still builds via `tools/make-chromium.sh`. Its
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
| `platform/chromium-mv3/mv3-scriptlet-marker.js` | The wire format the two above share to carry the scriptlet filters that fired across execution worlds. Pure, so `verify-mv3-package.mjs` can round-trip it |
| `platform/chromium-mv3/offscreen.{html,js}` | Hosts web workers (a service worker cannot construct one) and keeps the worker resident |
| `platform/chromium-mv3/manifest.overlay.json` | MV3-only manifest values |
| `tools/make-chromium-mv3.sh` | Build, mirroring `tools/make-chromium.sh` |
| `tools/make-chromium-mv3-meta.py` | Derives the MV3 manifest from the MV2 one |
| `tools/patch-mv3-modules.mjs` | Rewrites uBO's dynamic `import()` calls in the build output (forbidden in a service worker) |
| `tools/verify-mv3-package.mjs` | Asserts the package shape, every upstream assumption the port hard-codes, and that the port's own modules parse |
| `tools/make-crx.mjs` | CRX3 packer and update-manifest generator |

`platform/chromium/webext.js` and `platform/chromium/vapi-background-ext.js` are reused **as-is** —
the shims patch `chrome.*` underneath them, and patch the two `vAPI.Net` suspension methods on
assignment rather than forking the class — so upstream fixes to those files apply automatically.

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
| `.github/workflows/sync-upstream.yml` | daily + manual | Merges `gorhill/uBlock` `master`, **builds and verifies before pushing anything**, then constructs the release tree (upstream at the tag + this fork's files) and tags it `<upstream-tag>-mv3`. On a conflict, a merge that no longer builds, or a release tree that does not build, it opens an issue and pushes nothing. |
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

  That last clause is load-bearing rather than descriptive: the release tree is assembled from
  `git diff --diff-filter=A`, so a modification to an upstream file would be silently dropped from
  every release while master still looked correct. `sync-upstream.yml` therefore asserts that the
  fork modifies, deletes and renames nothing, and fails the run if it ever does.
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

