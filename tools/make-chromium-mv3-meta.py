#!/usr/bin/env python3
#
# Generate the MV3 manifest for the Chromium build.
#
# The MV3 manifest is *derived* from platform/chromium/manifest.json rather than
# maintained as a copy, so that upstream changes to permissions, content
# scripts, commands and so on are picked up automatically. Everything which
# differs between MV2 and MV3 is either a mechanical transform below, or a value
# in platform/chromium-mv3/manifest.overlay.json.
#
# Usage: make-chromium-mv3-meta.py <build-dir>

import json
import os
import re
import sys

if len(sys.argv) == 1 or not sys.argv[1]:
    raise SystemExit('Build dir missing.')

proj_dir = os.path.join(os.path.split(os.path.abspath(__file__))[0], '..')
build_dir = os.path.abspath(sys.argv[1])

# A host permission is anything with a scheme/host shape; everything else is an
# API permission. MV3 requires the two to live under separate keys.
re_host_permission = re.compile(r'^(<all_urls>|[a-z*]+://)')


def split_permissions(permissions):
    api, hosts = [], []
    for permission in permissions:
        (hosts if re_host_permission.match(permission) else api).append(permission)
    return api, hosts


with open(os.path.join(proj_dir, 'platform', 'chromium', 'manifest.json'), encoding='utf-8') as f:
    manifest = json.load(f)

with open(os.path.join(proj_dir, 'platform', 'chromium-mv3', 'manifest.overlay.json'), encoding='utf-8') as f:
    overlay = json.load(f)

with open(os.path.join(proj_dir, 'dist', 'version'), encoding='utf-8') as f:
    version = f.read().strip()

# Fork identity and version scheme.
#
# This fork ships its own version line on top of upstream, without modifying
# upstream's dist/version (which the release tree keeps for the tag): the fork
# build number lives in the fork-added file dist/mv3-build, and the shipped
# version is derived from upstream's dist/version plus that number.
#
#   upstream stable  X.Y.Z      -> fork STABLE  X.Y.Z.<build>   (build >= 500)
#   upstream beta    X.Y.Z.<n>  -> passthrough  X.Y.Z.<n>       (n < 500, dev)
#
# A 4th component >= FORK_BUILD_FLOOR marks a fork stable build: it is strictly
# greater than the upstream stable X.Y.Z (== X.Y.Z.0 to Chrome), and never
# collides with upstream betas (.1..~99) or rcs (.10<n>). See
# docs/mv3-deployment.md.
FORK_NAME = 'uBlock Origin (Sketchy MV3 fork)'
FORK_SHORT_NAME = 'uBO Sketchy'
FORK_BUILD_FLOOR = 500

try:
    with open(os.path.join(proj_dir, 'dist', 'mv3-build'), encoding='utf-8') as f:
        fork_build = int(f.read().strip())
except FileNotFoundError:
    fork_build = FORK_BUILD_FLOOR
except ValueError:
    raise SystemExit('dist/mv3-build must contain a single integer')
if fork_build < FORK_BUILD_FLOOR or fork_build > 65535:
    raise SystemExit(
        'dist/mv3-build ({}) must be an integer in [{}, 65535]'.format(
            fork_build, FORK_BUILD_FLOOR
        )
    )

manifest['manifest_version'] = 3

# browser_action -> action
if 'browser_action' in manifest:
    manifest['action'] = manifest.pop('browser_action')

# The MV2 background page is replaced by the service worker in the overlay.
manifest.pop('background', None)

# permissions -> permissions + host_permissions
for src_key, dst_key in (
    ('permissions', 'host_permissions'),
    ('optional_permissions', 'optional_host_permissions'),
):
    if src_key not in manifest:
        continue
    api, hosts = split_permissions(manifest[src_key])
    manifest[src_key] = sorted(api)
    if hosts:
        manifest[dst_key] = sorted(hosts)

# content_security_policy is supplied entirely by the overlay
# (platform/chromium-mv3/manifest.overlay.json) and applied verbatim by the
# overlay loop below, so no base-manifest transform is needed here. The overlay
# policy is the MV2 string plus 'wasm-unsafe-eval', which lets the service worker
# run the WASM LZ4 codec (see tools/patch-mv3-modules.mjs and
# docs/mv3-deployment.md); MV3 therefore enables WebAssembly where the MV2
# Chromium build does not. uBO detects this by looking for 'wasm-unsafe-eval' in
# the effective policy (see platform/common/vapi-background.js).

# web_accessible_resources: [str] -> [{ resources, matches }].
#
# No "use_dynamic_url": uBO guards these URLs itself with a per-request secret
# (the blocking webRequest listener in platform/common/vapi-background.js), and a
# rotating URL would break the warOrigin it hands to scriptlets.
war = manifest.get('web_accessible_resources')
if isinstance(war, list) and war and isinstance(war[0], str):
    manifest['web_accessible_resources'] = [{
        'resources': war,
        'matches': ['<all_urls>'],
    }]

# Apply the overlay. Keys replace the transformed value, except where a plain
# replacement could silently weaken a value the OTHER side owns:
# - "permissions" is unioned, so upstream additions survive.
# - "minimum_chrome_version" becomes the MAXIMUM of the base and overlay
#   values. The overlay carries the oldest Chrome the MV3 port itself
#   supports, but upstream owns the other bound and can raise the MV2
#   minimum past ours at any time; a plain replacement would mask the raise
#   and ship an MV3 build that claims to run on a Chrome upstream's own code
#   no longer supports. Chrome version values are dotted numerics, compared
#   component by component ("139.0" > "138.0.7"; a missing component counts
#   as 0, which is tuple comparison).
def chrome_version_key(value):
    return tuple(int(part) for part in str(value).split('.'))

for key, value in overlay.items():
    if key == 'permissions':
        existing = manifest.get(key, [])
        manifest[key] = sorted(set(existing) | set(value))
    elif key == 'minimum_chrome_version':
        base = manifest.get(key)
        if base is None:
            manifest[key] = value
        else:
            try:
                manifest[key] = max((base, value), key=chrome_version_key)
            except ValueError:
                # Refuse to guess which requirement is stronger rather than
                # silently dropping one of them.
                raise SystemExit(
                    'minimum_chrome_version must be dotted-numeric to compare '
                    f'(base {base!r}, overlay {value!r})'
                )
    else:
        manifest[key] = value

# Derive the fork version from upstream's dist/version (see the scheme note
# where FORK_BUILD_FLOOR is defined). An upstream stable X.Y.Z becomes the fork
# stable build X.Y.Z.<build>; an upstream beta remap (X.Y.Z.<n>, n < 500) and
# any other non-stable shape pass through unchanged as a dev build.
is_upstream_stable = re.fullmatch(r'\d+\.\d+\.\d+', version) is not None
if is_upstream_stable:
    version = '{}.{}'.format(version, fork_build)
    is_fork_stable = True
else:
    is_fork_stable = False

manifest['version'] = version

# A dev/beta build carries a four-component version whose 4th component is an
# upstream beta/rc remap (< 500); a fork stable build also has four components
# but its 4th is the fork build number (>= 500) and is NOT a dev build. This
# selects both the update channel and the name/version_name rules below.
is_dev_build = is_fork_stable is False and \
    bool(re.search(r'^\d+\.\d+\.\d+\.\d+$', version))

# Self-hosted auto-update. Chrome/Chromium polls this URL (an Omaha update
# manifest) roughly every five hours and installs a newer CRX when one is
# advertised -- the same mechanism the Web Store uses, pointed at the same
# update.xml the external-extensions / policy registration uses (see
# docs/mv3-deployment.md). Baking it in lets the CRX self-update with no
# registry or policy entry in browsers that do not gate off-store installs
# (ungoogled-chromium, and Chromium/enterprise configs that keep MV2 +
# webRequestBlocking). Stable Google Chrome still hard-disables off-store
# extensions, so the allowlist/force-install path in docs/mv3-deployment.md
# remains necessary there; a manifest update_url is inert for unpacked loads
# and ignored by the Web Store, so it is harmless in every other case.
#
# Channel mirrors the two fixed URLs the release automation publishes: a
# dev/beta build follows update-dev.xml, a stable X.Y.Z build update.xml --
# the channel a policy install would pick for the same build. The base URL
# defaults to this fork's GitHub Pages site (as in .github/ublock.reg and the
# docs) and is overridable via UBLOCK_UPDATE_BASE_URL, which release.yml sets
# to the deploying repository's Pages URL so forks and renames stay correct.
update_base = os.environ.get(
    'UBLOCK_UPDATE_BASE_URL', 'https://sketchystan1.github.io/uBlock',
).rstrip('/')
manifest['update_url'] = '{}/{}'.format(
    update_base, 'update-dev.xml' if is_dev_build else 'update.xml',
)

# Fork identity, applied to every build. Upstream's manifest.json and its
# localized description are left untouched (so the unattended merge cannot
# conflict and verify-mv3-package.mjs's KNOWN_MV2_KEYS check is unaffected);
# the rename happens here, on the generated MV3 manifest.
manifest['name'] = FORK_NAME
manifest['short_name'] = FORK_SHORT_NAME
if isinstance(manifest.get('action'), dict):
    manifest['action']['default_title'] = FORK_NAME

if is_fork_stable:
    # Deliberately NO version_name. Chrome DISPLAYS version_name in place of the
    # version whenever it is set, so any human-readable string there shows up as
    # the "version" and reads as noise beside the name. Leaving it unset makes
    # Chrome show the clean four-component version (e.g. "1.75.0.500").
    #
    # The catch a version_name would have solved: a bare four-component version
    # matches uBO's own devbuild probe (vapi-common.js:
    # /^\d+\.\d+\.\d+\D/ on version_name || version), which would flag the build
    # as a devbuild (verbose logging; the dev filter-list asset channel, though
    # that manifest is byte-identical to the stable one in this build). That is
    # neutralised in the service worker instead:
    # platform/chromium-mv3/mv3-shims.js hands uBO's getManifest() a synthetic,
    # non-matching version_name so the probe is false, while the shipped
    # manifest.json (and Chrome's UI) keeps none.
    pass
elif is_dev_build:
    # Upstream beta/rc: keep the dev branding and the devbuild-triggering
    # version_name (X.Y.Zb<n>), so uBO uses the dev asset channel as upstream
    # intends for a beta tag. Mirrors tools/make-chromium-meta.py.
    manifest['name'] += ' development build'
    manifest['short_name'] += ' dev build'
    if isinstance(manifest.get('action'), dict):
        manifest['action']['default_title'] += ' dev build'
    manifest['version_name'] = re.sub(r'\.(\d+)$', r'b\1', version)

with open(os.path.join(build_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, separators=(',', ': '), sort_keys=True)
    f.write('\n')

print('*** uBlock0.chromium-mv3: manifest v{} generated, version {}'.format(
    manifest['manifest_version'], version
))
