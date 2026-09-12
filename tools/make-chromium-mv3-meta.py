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

# content_security_policy: string -> object.
#
# Deliberately the same policy string as MV2. uBO decides whether it may use
# WebAssembly by looking for 'wasm-unsafe-eval' in this value (see
# platform/common/vapi-background.js), so keeping it verbatim keeps behaviour
# identical to the MV2 Chromium build. Adding 'wasm-unsafe-eval' here is a
# supported opt-in -- see docs/mv3-deployment.md.
csp = manifest.get('content_security_policy')
if isinstance(csp, str):
    manifest['content_security_policy'] = {'extension_pages': csp}

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

# Apply the overlay. Keys replace the transformed value, except "permissions",
# which is unioned so that upstream additions survive.
for key, value in overlay.items():
    if key == 'permissions':
        existing = manifest.get(key, [])
        manifest[key] = sorted(set(existing) | set(value))
    else:
        manifest[key] = value

manifest['version'] = version

# Development build? If so, modify name accordingly. Mirrors
# tools/make-chromium-meta.py, and sets version_name so that
# vapi-common.js's devbuild check (/^\d+\.\d+\.\d+\D/) recognizes it.
if re.search(r'^\d+\.\d+\.\d+\.\d+$', version):
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
