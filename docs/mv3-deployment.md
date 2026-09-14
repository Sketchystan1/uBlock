# Deploying the MV3 build

This fork adds a Chromium **Manifest V3** build of the full uBlock Origin — the real
filtering engine, not the declarativeNetRequest-based uBO Lite that lives in `platform/mv3/`.

One of the capabilities uBO depends on is gated under MV3. It is reachable, but not
automatic, and **network filtering does nothing until you complete step 3**.

| Capability | Gate | Consequence if not set up |
|---|---|---|
| Blocking `webRequest` (all network filtering) | Extension must be **policy-installed** | No network requests are blocked at all |

Scriptlet filters (`+js(...)`) need no setup: they are injected through
`chrome.scripting` like every other injection, with no toggle to find. Both payloads run as
**CSP-exempt extension-injected function calls** — no inline `<script>` element is ever
created, so the page's CSP is never consulted — which is the same observable behaviour MV2
had (MV2 reached it through a page-CSP exemption for elements created by
`tabs.executeScript`'s isolated world, an exemption no MV3 world enjoys). On strict-CSP
pages the filters deliver exactly as under MV2, while the page's own inline scripts stay
blocked.

A policy install additionally lets the port hold requests during a cold start rather
than cancelling them — see [step 4](#4-optional-reduce-how-often-a-cold-start-happens).

Cosmetic filtering, the element picker and zapper, the logger, and the dashboard all work without
the gate.

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

- **Two update manifests** are published to GitHub Pages, each at a **stable URL** that never
  changes between releases. They are signed with **one key**, so both advertise the **same
  extension id** — choose the channel you want and put its URL in the policy:
  - **Stable** — `https://<owner>.github.io/<repo>/update.xml` — only ever advances to a stable
    `X.Y.Z` release.
  - **Dev** — `https://<owner>.github.io/<repo>/update-dev.xml` — tracks the newest build of any
    kind, betas and rcs included (upstream ships roughly six betas per stable release).

  A fixed URL matters because `ExtensionInstallForcelist` takes one `EXTENSION_ID;UPDATE_URL`
  string and Chrome polls it forever; a per-release asset URL would pin a client to a single
  version and never update it again. Because the two channels share an extension id, a device
  follows whichever one URL its policy names — it cannot run both side by side.
- **The `.crx`** is a release asset, and each manifest points at the versioned CRX of the release
  it advertises.

> [!NOTE]
> Do not use `https://github.com/<owner>/<repo>/releases/latest/download/update.xml`. GitHub
> resolves `/releases/latest` to the newest **non-prerelease** release, and this fork marks every
> non-`X.Y.Z` build as a prerelease — which is most of them, since upstream ships roughly six betas
> per stable release. Policy clients would silently stop at the last stable build. The **stable
> channel** URL above already gives you "newest stable", through a URL that is genuinely fixed —
> use it instead.

Then, replacing `EXTENSION_ID` with the value `make-crx.mjs` printed (the examples below use the
stable channel; substitute `update-dev.xml` to follow the dev channel):

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

## 4. Optional: reduce how often a cold start happens

uBO keeps its compiled filter lists in memory, so a service worker eviction costs a full reload of
every list. The port already mitigates this: an offscreen document pings the service worker every
20 seconds, which resets its 30-second idle timer, and a `chrome.alarms` tick re-creates that
document if it ever disappears. (Offscreen documents are not subject to background-tab timer
throttling — Chromium creates them as nominally visible — so the 20-second interval holds.)

**A cold start is still an unfiltered window in principle, and on a policy install this port closes
it completely.** uBO handles the window by suspending network activity until the engines are ready,
but what "suspend" means has always been per-platform: Firefox returns a promise from a blocking
listener and resolves it once the lists are loaded, while Chromium MV2 cannot defer a blocking
decision at all and so *cancels* non-main-frame requests instead, reloading the affected tabs
afterwards. That is why `vAPI.Net.canSuspend()` returns `false` on Chromium
(`platform/common/vapi-background.js`), and why `src/js/background.js` in turn defaults the
`suspendUntilListsAreLoaded` user setting to `false` — requests are simply **allowed** through.
Under MV2 that mattered once per browser launch; under MV3 it would recur on every service worker
respawn.

The port also **pre-warms at browser start**: `mv3-shims.js` registers a
`chrome.runtime.onStartup` listener at module scope, which is what makes Chrome start the
service worker at launch instead of on the first request or keepalive-alarm tick (up to 30 s
later). Merely evaluating the worker's module graph boots uBO — `src/js/start.js` kicks off its
boot sequence at module scope — so the engine load (selfie hydration or a full compile) overlaps
the user's think-time on the start page rather than landing on their first navigation, exactly
as MV2's always-booted background page did. The keepalive offscreen document keeps the worker
resident afterwards; its existence is cached from the document's own 20-second pings, so the
keepalive alarm no longer issues a `chrome.runtime.getContexts` IPC on every 30-second tick —
a re-check happens only once the pings go stale (~45 s), which is also the signal that the
document died and must be recreated.

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

2. **Scriptlet injection is rebuilt from generated function libraries, not code strings.**
   MV3 has no API that injects a code string without a gate: `chrome.userScripts` requires
   the per-extension **Allow user scripts** toggle, which no policy can pre-grant.
   `chrome.scripting` injects a `func` and JSON `args` only, and `eval()` inside anything it
   injects is blocked by the isolated world's CSP. Live testing mapped what is left: the
   injected code itself — func **or file**, in **any** world — always runs CSP-exempt; it is
   only element creation and eval that consult a CSP. A `<script>` element created from a
   static content-script world is governed by the page's CSP, and one created from a
   `chrome.scripting` ISOLATED world is governed by that world's own CSP (the extension's) —
   so no element is created at all. MV2's scriptlets worked on strict-CSP pages because
   `tabs.executeScript`'s isolated world enjoyed an element-creation exemption; that API and
   its exemption are gone, and the observable behaviour — delivery on strict-CSP pages — is
   reproduced instead by never touching the CSP.

   So the program `src/js/scriptlet-filtering.js` assembles is never executed; it is carried
   as data (`mv3-post.js` prefixes it with a marker holding the scriptlet *calls* for both
   worlds parsed back out of their payloads, the per-document scriptlet globals, the filters
   that fired and the logger channel name — see `mv3-scriptlet-marker.js`), and the scriptlet
   functions — which are static, all registered in `js/resources/scriptlets.js` — ship as
   generated classic-script *libraries*, sharded at build time by `tools/patch-mv3-modules.mjs`
   (each function's source emitted verbatim, the transitive closure of that world's scriptlets
   over their declared dependencies **and** their bare-name references to one another).
   `mv3-shims.js` computes, from the marker's function names, the handful of files a
   navigation actually needs and injects them in **one** `chrome.scripting` call per world —
   so a typical 1-2-scriptlet navigation injects ~24 KB instead of the whole ~330 KB
   library. Per world the files are:

   - the **core shared** file (`js/mv3-mainworld-shared-core.js` /
     `js/mv3-scriptlet-shared.js`) — the near-universal dependencies (`safeSelf` and its
     closure, ~8 KB), always injected when any of that world's scriptlets fire. It parses
     the launch record onto a transient `self.uBO_mv3Lib` registry and declares the
     per-document `scriptletGlobals` closure variable.
   - the **heavy shared** file (`js/mv3-mainworld-shared-heavy.js`, main world only,
     ~44 KB) — dependencies that must exist exactly once (they keep state on themselves:
     `JSONPath`, `proxyApplyFn`, `trapPropertyFn`, …) but are needed only by some scriptlet
     families. Injected **only** when a called scriptlet's dependency tree reaches for it;
     the shard manifest carries that root set as `heavy.neededBy`.
   - the **shards** (`js/mv3-*-library-NN.js`) — clusters of same-family scriptlets plus
     their cluster-local dependencies (mid-frequency stateless dependencies are duplicated
     into each shard that needs them, which is what keeps the core file small), injected
     only when one of their functions is called.
   - the **launcher** (`js/mv3-mainworld-launch.js` / `js/mv3-scriptlet-launch.js`) —
     consumes the launch record and dispatches every call in payload order inside the same
     silent try/catch the assembled payload used, then deletes the registry.

   Every file is an IIFE and all cross-file references are captured as closure constants at
   evaluation time, so nothing leaks into the page and nothing can be redefined by it; the
   launcher runs last, so calls execute in payload order within a single script evaluation,
   exactly as MV2's one payload IIFE did. The two worlds' injections run in parallel — they
   share no state (the launch record is written by the guard func before both and read only
   by the MAIN-world files; the isolated stash only by the ISOLATED-world ones).
   `tools/verify-mv3-package.mjs` re-derives the shard manifest, checks every cross-file
   reference resolves, and enforces byte budgets. What MV2's single injection performed, the
   port performs in MV2's own order — relay, wrapper, isolated injector:

   - `world: 'ISOLATED'`, beside `contentscript.js` — one func which does everything MV2's
     program did, in its order: installs the scriptlet→logger relay (MV2's `uBO_bcSecret`
     BroadcastChannel, which carries log lines from the scriptlets to `vAPI.messaging`),
     applies MV2's once-per-document + hostname guards, records
     `self.uBO_scriptletsInjected` where `contentscript.js` and `cosmetic-report.js` read
     it, and hands each world's launch record to its library. The popup panel's "extended"
     section lists scriptlet filters, log lines reach the logger, and the guards mean
     exactly what they meant under MV2 — all with no `userScripts` and no toggle.
   - `world: 'MAIN'` — the MAIN-world core shared file, heavy shared file (only when
     needed), shards and launcher, each an
     IIFE (the page's global object is left untouched, as MV2's payload IIFE
     left it). The launch record is the one DOM write in the whole design: the
     ISOLATED func writes `{ globals, args, calls }` to
     `document.documentElement.dataset.uBOmv3Main` — a data attribute, the only state
     that crosses from the isolated world into the page (each world has its own JS
     wrappers, so expando properties do not cross; the DOM does) — the core shared file
     reads it and the launcher deletes it after dispatching every call in payload order
     inside the same silent try/catch the assembled payload used. This is the same shape
     uBOL uses for its pre-generated scriptlet files, adapted to runtime-assembled
     payloads and sharded for delivery cost.
   - `world: 'ISOLATED'` again — the isolated-world shared file, shards and launcher,
     same pattern, launched from a stash at `self.uBO_mv3IsolatedLaunch` (same world, so no
     DOM record is needed). Documents with only isolated-world scriptlets write no DOM
     record and inject no MAIN-world file at all.

   Running in the isolated world also restores `chrome.dom.openOrClosedShadowRoot`
   for `trusted-click-element`'s `>>>` combinator against closed shadow roots
   (`chrome.dom` is declared for content-script worlds, which the old `USER_SCRIPT` routing
   was denied) — confirmed live 2026-09-14: a `+js(trusted-click-element, #host >>> button)`
   user filter clicks a button inside a `mode:'closed'` shadow root on Chrome 154 Beta,
   identical to the MV2 build.

   What it costs, precisely:

   - Two `chrome.scripting` calls when both worlds fired (the func, then the two worlds'
     file injections in parallel) versus MV2's single injection: each call is a
     service-worker round trip, so the payloads land a millisecond-scale delay later. The
     files of one call are injected in array order; only the launcher executes calls, after
     every file of its world has run, so payload order is preserved exactly.
   - The transient `data-uBO…` launch attribute is the one observable difference from MV2:
     it exists in the DOM for roughly one round trip before the MAIN-world launcher
     consumes and deletes it, and a page watching `documentElement` attribute mutations
     could read the scriptlet arguments and globals during that window. MV2's payload lived
     only inside a synchronously-removed `<script>` element, which MutationObservers could
     not capture. The transient `uBO_mv3Lib` registry is a strictly smaller surface: it
     holds function references only, no data, and the launcher deletes it.
   - No scriptlet function is ever a global of either world: every generated file is an
     IIFE, and the only cross-file channel is the transient registry the launcher deletes.
     (The first iteration of this design did install the isolated-world functions as
     globals of that world; the sharded libraries retire all 38 of them.)
   - `hiddenSettings.debugScriptletInjector` and `debugScriptlets` no longer produce
     `debugger` statements or per-call `console.error` output; they were artifacts of the
     code-string path.

3. **`matchAboutBlank` is silently dropped.** ⚠️ *Regression.* uBO passes it at ten call sites —
   six `executeScript` (`src/js/messaging.js`, `src/js/scriptlet-filtering.js`) and four
   `insertCSS`/`removeCSS` (`src/js/cosmetic-filtering.js`, `platform/common/vapi-background.js`) —
   but MV3's `scripting` API has no equivalent. The nearest relation,
   `matchOriginAsFallback`, exists only on `registerContentScripts`.

   The declarative content script keeps `match_about_blank: true`, which the manifest generator
   preserves, so `contentscript.js` still runs in `about:blank` frames. What can fail there is the
   *programmatic* follow-up: the stylesheet it asks the background to insert, and scriptlet
   injection. Note this is a limit on what MV3 exposes, not something the port chose — the option
   simply does not exist on those APIs.

4. **WebAssembly is enabled — a deliberate divergence from the MV2 Chromium build.** uBO
   enables its WASM fast paths only when the manifest CSP contains `'wasm-unsafe-eval'`;
   `platform/chromium/manifest.json` does not, so `vAPI.canWASM` is false on MV2 Chromium.
   The MV3 build opts in (`platform/chromium-mv3/manifest.overlay.json` sets the
   `extension_pages` CSP with the token) because a service worker pays the cost of these
   engines on every cold boot: LZ4-block decompression of the ~31 MB filtering-engine
   selfie runs 5-20x faster under the WASM codec, and the hostname/URL tries
   (`hntrie.wasm`, `biditrie.wasm`) and the public-suffix list produce the same match
   results as their JS implementations while being faster to start (the JS tries
   JIT-compile tens of thousands of lines; the WASM modules stream-compile). This is the
   one place the MV3 build is faster than the shipped MV2 build rather than merely equal
   to it.

   What the opt-in rests on:

   - the shims' normalized `chrome.runtime.getManifest()` hands uBO the object-form CSP as
     a string, so its existing `'wasm-unsafe-eval'` probe flips `vAPI.canWASM` on its own;
   - `mv3-shims.js` imports both LZ4 flavors and instantiates WASM-first with a JS
     fallback, mirroring `src/lib/lz4/lz4-block-codec-any.js`. The WASM codec locates its
     module through `document.currentScript`, which does not exist in a service worker, so
     the build rewrites that lookup to a package-root-relative path
     (`tools/patch-mv3-modules.mjs`), which the shims' `fetch()` wrapper resolves;
   - all three `.wasm` modules are packaged by the normal copy steps and are fetched from
     the extension's own origin — no host permission and no `web_accessible_resources`
     entry needed (that key governs *web pages* fetching from the extension, not the
     extension fetching itself).

   **Selfie compatibility: none of the WASM paths invalidates existing selfies.** The trie
   selfie format is engine-agnostic — `toSelfie()` serializes the cell buffer and a
   checksum, nothing about which matcher will read it, and `fromSelfie()` loads the same
   bytes into plain arrays (JS mode) or WASM memory (WASM mode) interchangeably
   (`src/js/hntrie.js`, `src/js/biditrie.js`). Upstream's own `enableWASM()` is designed to
   swap the WASM matchers in *over already-populated JS tries* mid-session, and upstream
   runs exactly this mixed-mode reuse on Firefox — where `canWASM` is always true and the
   user-settable `disableWebAssembly` hidden setting flips a profile between modes across
   restarts with no selfie invalidation anywhere. The LZ4 layer is likewise codec-agnostic:
   the block format and the header `src/js/lz4.js` writes are identical for both flavors.
   So an update to this build loads the existing selfie as-is, under the faster engines —
   **no one-time recompile happens**. Should a selfie ever fail to load anyway, the
   existing defenses apply: a checksum mismatch triggers a full recompile from the compiled
   lists, and the one-shot boot recovery reloads the extension once if even that fails.

5. **The MV2 `chromium` target still exists** and still builds via `tools/make-chromium.sh`. Its
   output no longer installs in Chrome 139+, but it is left untouched on purpose — see below.
   Releases from this fork contain the MV3 package only.

6. **`replace=` filters: this build tracks upstream master, the MV2 original tracks 1.74.0.**
   Upstream commit `3ab731942` (in 1.74.1b6+) made the parser reject `replace=` rules unless the
   platform can filter response bodies (`canFilterResponseData`), which Chromium never can — so
   this build prunes them at compile time, while a 1.74.0-era build still compiles them into the
   engine as runtime-inert entries. Benchmarking the two builds against the same dataset
   therefore shows `replace=` matching 0 here and ~125 there, with every other counter
   identical; the counts converge once the MV2 original is updated past 1.74.1b6. Nothing to
   fix — noted so the divergence is not mistaken for a port defect in A/B comparisons.

7. **Service worker deaths no longer revert session-scope state.** MV2's background page lived for
   the whole browsing session; an MV3 service worker does not. Three classes of state used to
   silently reset on every worker death, and are now persisted to `chrome.storage.session` (which
   lives in the browser process, survives any number of worker deaths, and is cleared when the
   browsing session ends — the same lifetime they had under MV2) and restored before the boot
   sequence resolves `µb.isReadyPromise`, so popup reads never observe the un-restored state:

   - **Session dynamic rules** — the un-pinned popup/firewall/switch toggles. `start.js` re-seeds
     them from the permanent rules at every worker start; the port now serializes them through the
     same `toString()`/`fromString()` round trip backup-restore uses, writes on a short debounce
     after every mutation, and re-applies the snapshot after the seeding.
   - **Per-tab page stores** — toolbar badges and popup counts. Per-tab counters (blocked/allowed,
     by type), popup/large-media/remote-font counts, the large-media allow flag, and up to 100
     hostname rows for the popup's per-site breakdown are snapshotted on mutation (hooked onto
     `µb.updateToolbarIcon()`, which every count change calls) and written on a 1s debounce. A
     snapshot is restored only when the tab's URL is unchanged since it was taken; a navigation
     during the worker's death discards it, as those counts belong to the previous page. Closed
     tabs evict their snapshot; at most 500 tabs hold one.
   - **Strict-block bypasses** ("proceed anyway"). The deadline map inside `src/js/traffic.js` is
     exposed onto the exported `webRequest` object by a build-time transform
     (`tools/patch-mv3-modules.mjs`), persisted on the same kind of debounce, and re-applied with
     expired entries dropped.

   Windows that remain: whatever mutated in the last debounce interval before a death (0.5-2s for
the rule sets and bypasses, 1s for page stores) is lost; the large-media allow flag is only
piggy-backed onto the next toolbar-icon update rather than persisted at the moment of the
toggle; hostname rows beyond 100 per tab are not kept; per-frame stores are not kept at all
(they rebuild from navigation events); and the logger's in-memory buffer is deliberately not
persisted — it is a bounded ring that exists only while a logger tab is actively reading it,
and its janitor disables it after 30s without a reader, so a persisted copy would outlive its
own usefulness while costing unbounded writes for every logged request. The snapshots are also
**byte-budgeted** against `storage.session`'s hard 10 MB quota (writes past it fail silently):
the flush measures `getBytesInUse()`, and past a 4 MB budget it degrades — hostname rows
first, then whole entries oldest-dirtied first, then stored snapshots of tabs not being
rewritten — logging once per episode so the degradation stays observable.

8. **The context menu and update notifications survive a cold wake.** Chrome dispatches the event
   which woke a terminated service worker only to listeners registered synchronously during the
   worker's initial evaluation. uBO registers its context-menu click handler and its
   `runtime.onUpdateAvailable` handler at the *end* of its async boot — after every filter list
   has loaded — so the very events that wake the worker were dropped. `mv3-shims.js` now buffers
   the first of each at module scope and `mv3-post.js` replays them once the real handlers exist.
   Residual: only the first event of each kind per worker lifetime is buffered (a second click
   while the lists are still loading is dropped), and the observation-only webRequest listeners
   (`onResponseStarted`, `onSendHeaders`, `onCompleted`, …) are still registered by
   `webRequest.start()` after boot — deliberately: they need the engines loaded to be useful, and
   the load-bearing paths (blocking `onBeforeRequest`, `webNavigation.onCommitted`, tabs events,
   `runtime.onConnect`, commands, alarms) are all registered at module scope already. A navigation
   completing during boot loses only the response-time scriptlet injection attempt, which
   `onCommitted` performs again.

9. **The offscreen worker relay is epoch-namespaced, with a watchdog.** The offscreen document
   outlives any number of service worker lifetimes, and each lifetime numbers its workers from 1
   again — so a worker that outlived its service worker silently ate the next lifetime's messages
   (both worker kinds ignore each other's), which stopped filter list updates with no error
   anywhere. Every relay message now carries a per-lifetime epoch: the offscreen document
   terminates all hosted workers when the epoch changes and ignores stragglers from an epoch it
   has already replaced. A watchdog in the shim additionally converts a stalled round trip (offscreen
   document vanished, worker crashed before `onerror` fired) into: one loud `console.error`, a
   fresh worker under a fresh id with the unanswered round trips replayed, and — if that also
   stalls — a second loud error plus the reply each consumer already handles as "give up"
   (undefined for the reverse lookup, `broken` for the diff updater, which then falls back to full
   downloads). Residual: a legitimately slow diff cycle (multiple hanging CDNs) can trip the 180s
   updater budget and be retried once; the retry starts the cycle over rather than resuming
   mid-patch, and a second trip falls back to full downloads.


## Boot recovery

uBO's boot is defensive — every phase catches its own exceptions — so a corrupt selfie or a
broken storage backend at launch produces an extension that runs half-initialized for the
whole browser session: nothing filtered, no recovery. The port borrows uBOL's `goodStart`
behavior: once the boot settles, it is audited (`readyToFilter` reached, storage reads
healthy, compiled filter data present when a filter-list selection exists), and a failed
audit reloads the extension **exactly once** per failure streak — the retry marker lives in
`chrome.storage.local` (session storage cannot gate it: Chrome clears session storage on
`runtime.reload()` itself), is written only after a failed audit and before the reload, and
is cleared only by a successful boot, so a reload loop is impossible. If the retried boot
also fails, the port stays half-up exactly as it did before this existed. The reload clears
`storage.session` wholesale, so the per-tab page-store snapshots do not survive a retry —
losing session bookkeeping once, to recover a working filter engine, is the right trade.
See the "One-shot recovery" block in `platform/chromium-mv3/mv3-post.js`.

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
| `platform/chromium-mv3/mv3-scriptlet-marker.js` | The wire format that carries a whole scriptlet injection (payloads, filters, logger channel) across the func/args boundary between the two patch modules. Pure, so `verify-mv3-package.mjs` can round-trip it |
| `platform/chromium-mv3/offscreen.{html,js}` | Hosts web workers (a service worker cannot construct one) and keeps the worker resident |
| `platform/chromium-mv3/manifest.overlay.json` | MV3-only manifest values |
| `tools/make-chromium-mv3.sh` | Build, mirroring `tools/make-chromium.sh` |
| `tools/make-chromium-mv3-meta.py` | Derives the MV3 manifest from the MV2 one |
| `tools/patch-mv3-modules.mjs` | Rewrites uBO's dynamic `import()` calls in the build output (forbidden in a service worker), aliases `chrome.browserAction` for extension pages, makes the WASM LZ4 codec service-worker-safe, generates the sharded scriptlet libraries (`js/mv3-scriptlet-shared.js`, `js/mv3-mainworld-shared-core.js` + `-shared-heavy.js`, `-library-NN.js` shards and `-launch.js` per world, plus the `js/mv3-scriptlet-shards.js` manifest `mv3-shims.js` computes per-navigation file sets from), and exposes the strict-block bypass deadline map so `mv3-post.js` can persist it |
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
| `.github/workflows/release.yml` | `*-mv3` tag push, or dispatch | Builds and verifies, signs the CRX, publishes the release with checksums and provenance, and deploys both update manifests (`update.xml` = stable channel, `update-dev.xml` = dev channel) to GitHub Pages |
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
intent for a beta tag, not a defect. To keep a deployment on stable releases only, point its
policy `update_url` at the **stable channel** (`update.xml`), which never advances past an `X.Y.Z`
release — this is the intended mechanism and needs no workflow change. (You *can* still narrow
`TAG_PATTERN` in `sync-upstream.yml` to `^[0-9]+\.[0-9]+\.[0-9]+$` if you would rather the fork not
build betas at all, but then the dev channel has nothing to advertise.)

