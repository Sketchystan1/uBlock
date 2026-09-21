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

manifest['version'] = version

# A dev/beta build carries a four-component version (1.74.1.5); a stable
# release carries three (1.74.1). This selects both the update channel and the
# name suffix below.
is_dev_build = bool(re.search(r'^\d+\.\d+\.\d+\.\d+$', version))

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

# Development build? If so, modify name accordingly. Mirrors
# tools/make-chromium-meta.py, and sets version_name so that
# vapi-common.js's devbuild check (/^\d+\.\d+\.\d+\D/) recognizes it.
if is_dev_build:
    manifest['name'] += ' development build'
    manifest['short_name'] += ' dev build'
    manifest['action']['default_title'] += ' dev build'
    manifest['version_name'] = re.sub(r'\.(\d+)$', r'b\1', version)

with open(os.path.join(build_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, separators=(',', ': '), sort_keys=True)
    f.write('\n')

print('*** uBlock0.chromium-mv3: manifest v{} generated, version {}'.format(
    manifest['manifest_version'], version
))
