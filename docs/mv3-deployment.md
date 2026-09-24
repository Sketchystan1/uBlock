# Deploying the MV3 build

This fork adds a Chromium **Manifest V3** build of the full uBlock Origin — the real
filtering engine, not the declarativeNetRequest-based uBO Lite that lives in `platform/mv3/`.

One capability is gated under MV3: blocking `webRequest` needs the extension to come from an
**update URL** rather than the Web Store, plus an `ExtensionInstallAllowlist` entry so Chrome
does not disable it — and **network filtering does nothing until you complete step 3**.
Everything else — cosmetic filtering, the element picker and zapper, scriptlet filters
(`+js(...)`), the logger, and the dashboard — works without the gate. Scriptlets deliver
on strict-CSP pages exactly as under MV2, because they run as CSP-exempt
extension-injected function calls and never create a `<script>` element.

> [!NOTE]
> An install from an `external_update_url` is an *external* install, not a *policy force-install*.
> That distinction matters in one place: only a policy force-install gets the cold-start
> request-holding described in [step 4](#4-optional-reduce-how-often-a-cold-start-happens).
> Everything else — including `webRequestBlocking` — behaves identically.

## Why MV2 is not an option

`ExtensionManifestV2Availability` — the enterprise policy that used to re-enable MV2 — is
marked deprecated in Chromium's policy definitions, with `supported_on: chrome.*:110-138`.
On Chrome 139 and later there is no supported way to run an MV2 extension, which is what
this port exists to address.

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

An external install needs a CRX with a stable extension ID, which means you sign it yourself.

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

## 3. Install from your update URL

`webRequestBlocking` is granted only when the extension comes from an update URL Chrome is
told about — registered as an external extension via `external_update_url`. Loading the
unpacked directory, or dragging the CRX in, does **not** qualify — Chrome will show a manifest
warning that `webRequestBlocking` requires a policy install, and blocking listeners silently do
nothing (the warning text says "policy" because a policy install is one way to register the
update URL; the external-extensions registration below is the other, and grants the same
permission). On branded Google Chrome (not Chromium) the machine-level
`ExtensionInstallAllowlist` policy must also contain the extension ID, or Chrome disables the
extension shortly after installation.

> [!NOTE]
> The CRX also carries a manifest `update_url` (baked in by
> `tools/make-chromium-mv3-meta.py`: stable builds point at `update.xml`, dev/beta builds at
> `update-dev.xml`). In browsers that do **not** gate off-store installs — ungoogled-chromium,
> and Chromium or enterprise configurations that still permit MV2 + `webRequestBlocking` — this
> makes a hand-installed CRX **self-update** with no registry or policy entry, and blocking
> works without the registration too. On stable Google Chrome the manifest URL is not enough:
> Chrome hard-disables off-store extensions regardless, so the registration below is still
> required, both to keep the extension enabled and to grant `webRequestBlocking`.

Let the release automation host everything (the supported path), or host the `.crx` and an
`update.xml` yourself on servers reachable over HTTPS. The automation publishes **two update
manifests** to GitHub Pages, each at a **stable URL** that never changes between releases, both
signed with one key (so both advertise the same extension id — a device follows whichever one URL
it names; it cannot run both side by side):

- **Stable** — `https://<owner>.github.io/<repo>/update.xml` — only ever advances to a fork
  **stable** build, versioned `X.Y.Z.N` (the upstream stable `X.Y.Z` it was built from, plus this
  fork's build number `N` ≥ 500 — see *Fork version scheme and name* below).
- **Dev** — `https://<owner>.github.io/<repo>/update-dev.xml` — tracks the newest build of any
  kind, upstream betas and rcs included.

A fixed URL matters because the external-extensions registration takes one update URL and
Chrome polls it forever; a per-release asset URL would pin a client to a single version and
never update it again.

> [!NOTE]
> Do not use `https://github.com/<owner>/<repo>/releases/latest/download/update.xml`. GitHub
> resolves `/releases/latest` to the newest **non-prerelease** release, and this fork marks upstream
> betas/rcs as prereleases (its own `X.Y.Z.N` stable builds are full releases), so it can drift or
> skip depending on release timing. The stable channel URL above already gives you "newest stable"
> through a genuinely fixed URL.

Then, replacing `EXTENSION_ID` with the value `make-crx.mjs` printed (the examples use the
stable channel; substitute `update-dev.xml` to follow the dev channel):

**Windows** (registry):

```
[HKEY_CURRENT_USER\SOFTWARE\Google\Chrome\Extensions\EXTENSION_ID]
"update_url"="https://sketchystan1.github.io/uBlock/update.xml"

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist]
"1"="EXTENSION_ID"
```

**Linux** (`/opt/google/chrome/extensions/EXTENSION_ID.json` +
`/etc/opt/chrome/policies/managed/ublock.json`):

```json
// /opt/google/chrome/extensions/EXTENSION_ID.json
{ "external_update_url": "https://sketchystan1.github.io/uBlock/update.xml" }

// /etc/opt/chrome/policies/managed/ublock.json
{ "ExtensionInstallAllowlist": [ "EXTENSION_ID" ] }
```

**macOS** — `/Library/Application Support/Google/Chrome/External Extensions/EXTENSION_ID.json`
with the same `external_update_url` object, plus `ExtensionInstallAllowlist` in a
configuration profile for `com.google.Chrome`.

Then restart Chrome and check `chrome://policy` (the allowlist should be listed and applied) and
`chrome://extensions` (the extension should be installed from your update URL, with no
`webRequestBlocking` warning).

### Quick install for this fork's published build

The sections above are for someone signing and hosting their own build. If you are deploying
**this fork's published extension** (id `cbmpaamhmhdhnkofemgdlnbdadbpmjkn`, stable channel), the
[project README](https://github.com/Sketchystan1/uBlock/blob/master/.github/README.md) has the
one-command and double-click installers for every platform, kept current there so they do not
drift from this doc. On Windows that is [`fake-mdm.reg`](https://github.com/Sketchystan1/uBlock/blob/master/.github/fake-mdm.reg)
(marks the device managed) plus a per-browser force-install file
([`chrome.reg`](https://github.com/Sketchystan1/uBlock/blob/master/.github/chrome.reg),
`edge.reg`, `vivaldi.reg`, `chromium.reg`) — `ExtensionSettings` force-install, not
`ExtensionInstallAllowlist`, because on branded Chrome the allowlist route installs the
extension but does not grant `webRequestBlocking`.

## 4. Optional: reduce how often a cold start happens

uBO keeps its compiled filter lists in memory, so a service worker eviction costs a full reload of
every list. The port already mitigates this:

- An offscreen document pings the service worker every 20 seconds, which resets its 30-second
  idle timer, and a `chrome.alarms` tick re-creates that document if it ever disappears.
- `mv3-shims.js` registers a `chrome.runtime.onStartup` listener at module scope, so Chrome
  starts the service worker at browser launch instead of on the first request (up to 30 s later);
  the engine load then overlaps the user's think-time on the start page.

On a **policy force-install** (`ExtensionInstallForcelist` / `ExtensionSettings` with
`installation_mode: force_installed`) the cold-start window is closed completely: Chromium
honours a promise returned from a blocking `webRequest` listener, the port patches `vAPI.Net`
with upstream's own Firefox implementation of request suspension, and requests arriving during
a cold start are **held** until the lists are ready and then decided normally — nothing is let
through unfiltered, nothing is cancelled, no tab is reloaded. On the external-install path from
step 3 (`external_update_url` + `ExtensionInstallAllowlist`) the promise cannot be honoured,
so upstream's cancelling behaviour applies and a page loading during a cold start may reload
once.

If you prefer plain upstream Chromium behaviour, untick
_Settings → Filter lists → **Suspend network activity until all filter lists are loaded****.

`ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls` (Chrome 112+) can further reduce
cold starts:

```json
{
  "ExtensionExtendedBackgroundLifetimeForPortConnectionsToUrls": [
    "chrome-extension://EXTENSION_ID/"
  ]
}
```

This is belt-and-braces rather than a requirement.

## Behavioural differences from the MV2 build

The port aims at MV2 parity; where a difference could be closed it has been. What remains:

- **`matchAboutBlank` is silently dropped.** MV3's `scripting` API has no equivalent
  (`matchOriginAsFallback` exists only on `registerContentScripts`). The declarative content
  script keeps `match_about_blank: true`, so `contentscript.js` still runs in `about:blank`
  frames; what can fail there is the programmatic follow-up (stylesheet insertion, scriptlet
  injection).
- **WebAssembly is enabled — a deliberate divergence from the MV2 Chromium build.** The MV3
  manifest opts into `'wasm-unsafe-eval'` (MV2 Chromium does not), because a service worker pays
  the engine cost on every cold boot: WASM-flavoured LZ4 selfie decompression and trie matching
  are substantially faster to start. Existing selfies are mode-agnostic — no recompile happens on
  update. This is the one place the MV3 build is faster than the shipped MV2 build.
- **`replace=` filters are pruned at compile time.** Upstream `3ab731942` (1.74.1b6+) made the
  parser reject `replace=` rules unless the platform can filter response bodies, which Chromium
  never can. An older MV2 build compiles them as runtime-inert entries; benchmark counters
  therefore differ (`replace=` 0 vs ~125) with every other counter identical. Nothing to fix —
  noted so the divergence is not mistaken for a port defect in A/B comparisons.
- **`hiddenSettings.debugScriptletInjector` / `debugScriptlets`** no longer produce `debugger`
  statements or per-call `console.error` output; they were artifacts of the MV2 code-string
  injection path.
- **The MV2 `chromium` target still builds** (`tools/make-chromium.sh`) but no longer installs
  in Chrome 139+. It is left untouched on purpose; releases from this fork contain the MV3
  package only.

Robustness work that is invisible in normal operation, in brief: session-scope state (session
dynamic rules, per-tab page stores, strict-block bypasses) survives service worker deaths via
`chrome.storage.session` with byte-budgeted degradation; cold-wake events (context menu, update
notifications) are buffered and replayed; the offscreen worker relay is epoch-namespaced with a
watchdog; a failed boot is audited and triggers exactly one extension reload per failure streak;
and user-filter saves rebuild the engines immediately (deferred onto boot if the save lands
mid-boot) so added or removed `+js` filters take effect without a restart. The design rationale
for all of this lives in the comments of `platform/chromium-mv3/mv3-shims.js` and
`mv3-post.js`, and in `tools/verify-mv3-package.mjs`, which pins each mechanism.

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
| `platform/chromium-mv3/mv3-scriptlet-marker.js` | The wire format that carries a whole scriptlet injection (payloads, filters, logger channel) across the func/args boundary between the two patch modules |
| `platform/chromium-mv3/offscreen.{html,js}` | Hosts web workers (a service worker cannot construct one) and keeps the worker resident |
| `platform/chromium-mv3/manifest.overlay.json` | MV3-only manifest values |
| `tools/make-chromium-mv3.sh` | Build, mirroring `tools/make-chromium.sh` |
| `tools/make-chromium-mv3-meta.py` | Derives the MV3 manifest from the MV2 one |
| `tools/patch-mv3-modules.mjs` | Rewrites the build output for MV3 (dynamic imports, WASM codec path, sharded scriptlet libraries, runtime hardening). Transforms the **build output**, never the source tree, which is what keeps the zero-conflict property intact |
| `tools/verify-mv3-package.mjs` | Asserts the package shape, every upstream assumption the port hard-codes, and that the port's own modules parse |
| `tools/make-crx.mjs` | CRX3 packer and update-manifest generator |

Note the division of labour between the two patch modules: `mv3-shims.js` runs *before* uBO and
may therefore not import anything of uBO's; anything needing uBO's own modules goes in
`mv3-post.js`. Prefer `mv3-shims.js` where possible — a shim installed before uBO loads cannot be
defeated by load-order surprises.

## Automation

| Workflow | Trigger | Does |
|---|---|---|
| `.github/workflows/sync-upstream.yml` | daily + manual | Merges `gorhill/uBlock` `master`, **builds and verifies before pushing anything**, then constructs the release tree (upstream at the tag + this fork's files) and tags it `<upstream-tag>-mv3`. On a conflict, a merge that no longer builds, or a release tree that does not build, it opens an issue and pushes nothing. |
| `.github/workflows/release.yml` | `*-mv3` tag push, or dispatch | Builds and verifies, signs the CRX, publishes the release with checksums and provenance, and deploys both update manifests to GitHub Pages |
| `.github/workflows/build.yml` | push / PR | Builds and verifies |

Two details worth knowing, both learned the hard way:

- **The release tree is not master.** Tagging the merge commit would ship upstream master's *tip*
  under a tag name it does not correspond to, and take the package version from whatever
  `dist/version` master happened to hold. The release tree is therefore built as *upstream at the
  tag* plus this fork's added files — conflict-free by construction. The fork's
  add-nothing-modify-nothing property is what makes this work: the release tree is assembled from
  `git diff --diff-filter=A`, so a modification to an upstream file would be silently dropped
  from every release while master still looked correct. `sync-upstream.yml` asserts the property
  on every run.
- **`gh` needs `GH_REPO` pinned.** `gh` infers its target repository from git remotes and prefers
  a remote named `upstream` over `origin`. `sync-upstream.yml` adds exactly such a remote, so
  without the pin every `gh` call in that job silently targets `gorhill/uBlock`.

One-time repository setup:

1. **Disable upstream's release workflow**: `gh workflow disable main.yml`. It fires on any tag
   creation and would race with `release.yml`. This is done as a repository setting rather than by
   editing the file, to keep the merge-conflict surface at zero — and `sync-upstream.yml`
   re-asserts it on every run.
2. Add the `CRX_PRIVATE_KEY` secret (step 2 above). **Without it there is no CRX, no
   `update.xml`, and therefore no external install — which means no network filtering at all.**
   `release.yml` warns and publishes the zip alone.
3. **Enable GitHub Pages with Actions as the source**, so `update.xml` gets a stable URL:
   ```sh
   gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
   # release.yml deploys from a *-mv3 tag, but the github-pages environment
   # permits only the default branch by default -- allow the tags too:
   gh api -X POST repos/OWNER/REPO/environments/github-pages/deployment-branch-policies \
     -f name='*-mv3' -f type=tag
   ```
   Skipping the second command makes the deploy fail with an opaque environment-protection error.
4. **Strongly recommended: add a `SYNC_TOKEN` secret** — a PAT with the `workflow` scope
   (classic: `repo` + `workflow`; fine-grained PAT or App: Contents **write** + Workflows
   **write**). Two separate things need it: pushing a merge that touches a workflow file
   (`GITHUB_TOKEN` is an App token and GitHub refuses such pushes, and upstream edits
   `.github/workflows/main.yml` regularly), and firing `release.yml` from the tag push (pushes
   authenticated with `GITHUB_TOKEN` do not trigger other workflows; the sync's explicit
   dispatch fallback does work, the token just removes a moving part).

Releases are cut for every release-shaped upstream tag, betas and rcs included, plus this fork's
own stable builds.

### Fork version scheme and name

This fork ships under the name **uBlock Origin (Sketchy MV3 fork)** (set in
`tools/make-chromium-mv3-meta.py`, so upstream's `manifest.json` is never touched). Its version is
derived from upstream's `dist/version` plus a fork build number in the fork-owned file
`dist/mv3-build` (starts at `500`):

- **Upstream stable `X.Y.Z`** → fork **stable** build **`X.Y.Z.N`** (`N` = `dist/mv3-build`, ≥ 500),
  published to the **stable** channel (`update.xml`). `X.Y.Z.500` is strictly greater than the
  upstream `X.Y.Z` (`= X.Y.Z.0` to Chrome) and never collides with an upstream beta (`X.Y.Zb<n>` →
  `X.Y.Z.<n>`, the `.1..` range) or rc (`.10<n>`). `sync-upstream.yml` tags it `X.Y.Z.N-mv3` and then
  bumps `dist/mv3-build`, so the next stable build is `X.Y.Z.501`, and so on.
- **Upstream beta/rc `X.Y.Zb<n>` / `X.Y.Zrc<n>`** → built unchanged as a **dev** build
  (`update-dev.xml`, "development build" branding), exactly as before.

A four-component version would otherwise trip uBO's own `devbuild` heuristic (which turns on verbose
logging and selects the dev filter-list asset channel — the latter a no-op here, since both asset
manifests are byte-identical in this build). The shipped `manifest.json` deliberately carries **no**
`version_name`, so Chrome shows the clean `X.Y.Z.N` version; the devbuild heuristic is instead
neutralised for the service worker in `platform/chromium-mv3/mv3-shims.js`, whose `getManifest()`
hands uBO a synthetic, non-matching `version_name`. To cut another stable build of the same upstream
`X.Y.Z`, dispatch `sync-upstream.yml` with that upstream tag; it builds the next `dist/mv3-build`
number.

To keep a deployment on stable releases only, point its policy `update_url` at the **stable
channel** (`update.xml`), which only ever advances to a fork `X.Y.Z.N` stable build — this is the
intended mechanism and needs no workflow change.

### Visible "filtering not working" errors

Because MV3 grants `webRequestBlocking` only to policy installs, a build loaded any other way
filters nothing, and async request-holding needs a policy (`installType === 'admin'`) install on
top of that. The fork surfaces both failures instead of only logging them: the toolbar icon shows a
red `!` badge, and the popup panel prepends a warning banner naming which capability is inactive
(*webRequest blocking not working* and/or *async blocking not working*). Both clear once the
extension is force-installed by policy. The status is probed in
`platform/chromium-mv3/mv3-shims.js` (`mv3ForkStatus`) and rendered by
`platform/chromium-mv3/mv3-popup-banner.js`.

## Testing your install

The upstream test pages work for this build:

- Cosmetic/scriptlet coverage — <https://ublockorigin.github.io/uBOL-home/tests/test-filters.html>
  (enable the "uBO Lite Test Filters" list in the dashboard, or add the individual test filters
  as user filters, e.g. `ublockorigin.github.io###pcf14:xpath(.//b/../..)`).
- Additional community tools — <https://github.com/gorhill/uBlock/wiki/Tools>. Note that gorhill
  is no longer actively developing some of these; treat results accordingly.

### Check blocking from the service-worker console

To confirm `webRequestBlocking` is actually granted (not just requested) and to measure whether
async blocking — holding a request while a promise resolves — works on this install, open
`chrome://extensions` → uBlock Origin → **Inspect views: service worker**, and paste:

```js
(async () => {
  const T = 'https://example.com/';
  const { permissions } = await chrome.permissions.getAll();
  let install = 'unknown';
  try { ({ installType: install } = await chrome.management.getSelf()); } catch {}
  if (!permissions.includes('webRequestBlocking')) {
    return console.log(`❌ webRequestBlocking NOT granted (install: ${install}) — MV3 grants it only to a policy/external install.`);
  }
  let fired = false, blocked = false;
  const listener = () => { fired = true; return new Promise(r => setTimeout(() => r({ cancel: true }), 1500)); };
  chrome.webRequest.onBeforeRequest.addListener(listener, { urls: [T + '*'] }, ['blocking']);
  const t = performance.now();
  try { await fetch(T + '?t=' + Date.now(), { cache: 'no-store' }); } catch { blocked = true; }
  const ms = Math.round(performance.now() - t);
  chrome.webRequest.onBeforeRequest.removeListener(listener);
  console.log(
    !fired               ? `⚠️  webRequestBlocking present but blocking listeners never fire (install: ${install}).`
    : blocked && ms > 1400 ? `✅  Sync + async blocking work (install: ${install}) — request held ${ms} ms, then cancelled.`
    : blocked            ? `⚠️  Blocking works but the request wasn't held (${ms} ms) — something cancelled it early.`
    :                      `✅ sync cancel works · ❌ async off (install: ${install}) — request completed in ${ms} ms; Chromium didn't wait for the promise.`
  );
})();
```

It reports `installType` because async blocking is gated on it: the port only attempts to hold
requests when `chrome.management.getSelf()` returns `admin` (a policy/force-install), and cancels
outright otherwise (see `platform/chromium-mv3/mv3-shims.js`). So `❌ async off` on a non-`admin`
install is expected, not a fault — sync cancel still blocks. The probe installs its own temporary
listener on `example.com` (not on any filter list) and removes it before logging, so it does not
disturb uBO's own filtering.
