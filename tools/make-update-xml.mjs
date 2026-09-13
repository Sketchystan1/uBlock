#!/usr/bin/env node
/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/*******************************************************************************

    Emit a gupdate (Omaha) update manifest for one release, given only its tag
    and the constant extension id.

    Why this exists: the policy `update_url` is served from GitHub Pages, and a
    Pages deploy replaces the whole site -- so every release must publish BOTH
    channel manifests (update.xml = latest stable, update-dev.xml = latest of
    any kind) or the one it does not own gets wiped. The values for either
    channel are fully recoverable from a release TAG plus the extension id, so
    tools/release.yml derives both at deploy time from `gh release list` and
    calls this twice. Nothing here reads prior Pages content, so a re-dispatched
    old tag cannot regress the published manifest.

    The output is byte-identical to the block tools/make-crx.mjs emits, so
    tools/verify-crx.mjs stays valid against it.

    Node builtins only -- no dependency to install in CI.

    Usage:
      node tools/make-update-xml.mjs --appid <id> --tag <X.Y.Z[b|rc<n>]-mv3> \
                                     --asset-base <url> --out <out.xml>

    --asset-base is the release-download prefix, e.g.
      https://github.com/<owner>/<repo>/releases/download

**/

import fs from 'node:fs';
import path from 'node:path';

/******************************************************************************/

const args = new Map();
for ( let i = 2; i < process.argv.length; i += 2 ) {
    args.set(process.argv[i].replace(/^--/, ''), process.argv[i+1]);
}

const appid = args.get('appid');
const rawTag = args.get('tag');
const assetBase = args.get('asset-base');
const outPath = args.get('out');

if ( !appid || !rawTag || !assetBase || !outPath ) {
    console.error('Usage: make-update-xml.mjs --appid <id> --tag <tag-mv3> --asset-base <url> --out <out.xml>');
    process.exit(1);
}

/******************************************************************************/

// The tag as `gh` reports it carries the `-mv3` suffix and is used verbatim as
// the release's URL path segment; the CRX filename and the advertised version
// use the tag with that suffix stripped -- exactly as tools/release.yml names
// the asset (`uBlock0_${version}.chromium-mv3.crx`, version = tag without -mv3).
const tag = rawTag;
const tagVersion = rawTag.replace(/-mv3$/, '');

// Map the upstream tag to the Chrome-comparable version. This is the SAME
// mapping tools/release.yml applies in its "Check the advertised version" step,
// kept here as the single source of truth:
//   X.Y.Z      -> X.Y.Z
//   X.Y.Zb<n>  -> X.Y.Z.<n>
//   X.Y.Zrc<n> -> X.Y.Z.10<n>
function chromeVersionFromTag(v) {
    let m = /^(\d+\.\d+\.\d+)$/.exec(v);
    if ( m ) { return m[1]; }
    m = /^(\d+\.\d+\.\d+)b(\d+)$/.exec(v);
    if ( m ) { return `${m[1]}.${m[2]}`; }
    m = /^(\d+\.\d+\.\d+)rc(\d+)$/.exec(v);
    if ( m ) { return `${m[1]}.10${m[2]}`; }
    return null;
}

const version = chromeVersionFromTag(tagVersion);
if ( version === null ) {
    console.error(`make-update-xml: tag "${rawTag}" is not a shape this understands (expected X.Y.Z, X.Y.Zb<n> or X.Y.Zrc<n>, optionally suffixed -mv3)`);
    process.exit(1);
}

const codebase = `${assetBase.replace(/\/+$/, '')}/${tag}/uBlock0_${tagVersion}.chromium-mv3.crx`;

/******************************************************************************/

// Byte-identical to tools/make-crx.mjs's update-xml block.
const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
    `  <app appid="${appid}">`,
    `    <updatecheck codebase="${codebase}" version="${version}" />`,
    '  </app>',
    '</gupdate>',
    '',
].join('\n');

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, xml);

console.log(`*** make-update-xml: ${outPath}`);
console.log(`    appid       ${appid}`);
console.log(`    tag         ${tag}`);
console.log(`    version     ${version}`);
console.log(`    codebase    ${codebase}`);
