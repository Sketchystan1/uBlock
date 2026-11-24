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

    Pack an unpacked extension directory into a signed CRX3, and optionally emit
    the matching update manifest.

    Why this exists: under MV3, `webRequestBlocking` is granted only to
    policy-installed extensions, and policy installation requires a self-hosted
    signed CRX served through an update manifest. See docs/mv3-deployment.md.

    Node builtins only -- no dependency to install in CI, and the extension ID
    it prints is stable for a given key.

    Usage:
      node tools/make-crx.mjs --dir <unpacked-dir> --key <private-key.pem> \
                              --out <output.crx> \
                              [--update-xml <out.xml> --codebase <url>]

    The key is an RSA private key in PEM form (PKCS#1 or PKCS#8):
      openssl genrsa -out key.pem 4096

**/

import { createHash, createPrivateKey, createPublicKey, createSign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

/******************************************************************************/

const args = new Map();
for ( let i = 2; i < process.argv.length; i += 2 ) {
    args.set(process.argv[i].replace(/^--/, ''), process.argv[i+1]);
}

const dir = args.get('dir');
const keyPath = args.get('key');
const outPath = args.get('out');

if ( !dir || !keyPath || !outPath ) {
    console.error('Usage: make-crx.mjs --dir <dir> --key <key.pem> --out <out.crx> [--update-xml <out.xml> --codebase <url>]');
    process.exit(1);
}

/******************************************************************************/

// Minimal ZIP writer. A CRX's payload must have manifest.json at the archive
// root, so entry names are relative to `dir` with no wrapping directory.
// Timestamps are fixed so that the same input yields the same output.

const crcTable = (( ) => {
    const table = new Int32Array(256);
    for ( let i = 0; i < 256; i++ ) {
        let c = i;
        for ( let k = 0; k < 8; k++ ) {
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for ( let i = 0; i < buf.length; i++ ) {
        c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xFF];
    }
    return (c ^ -1) >>> 0;
}

function listFiles(root) {
    const out = [];
    const walk = current => {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        entries.sort((a, b) => a.name < b.name ? -1 : 1);
        for ( const entry of entries ) {
            const full = path.join(current, entry.name);
            if ( entry.isDirectory() ) {
                walk(full);
                continue;
            }
            if ( entry.isFile() === false ) { continue; }
            out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    walk(root);
    return out;
}

function makeZip(root) {
    // MS-DOS date/time: 1980-01-01 00:00:00
    const DOS_TIME = 0;
    const DOS_DATE = 0x21;
    const locals = [];
    const centrals = [];
    let offset = 0;

    for ( const name of listFiles(root) ) {
        const raw = fs.readFileSync(path.join(root, name));
        const deflated = deflateRawSync(raw, { level: 9 });
        // Fall back to stored when compression does not pay off.
        const useDeflate = deflated.length < raw.length;
        const data = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(raw);
        const nameBuf = Buffer.from(name, 'utf8');

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(20, 4);             // version needed
        local.writeUInt16LE(0, 6);              // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);             // extra length
        locals.push(local, nameBuf, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE(20, 4);           // version made by
        central.writeUInt16LE(20, 6);           // version needed
        central.writeUInt16LE(0, 8);            // flags
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);           // extra length
        central.writeUInt16LE(0, 32);           // comment length
        central.writeUInt16LE(0, 34);           // disk number
        central.writeUInt16LE(0, 36);           // internal attributes
        central.writeUInt32LE(0, 38);           // external attributes
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }

    const localBytes = Buffer.concat(locals);
    const centralBytes = Buffer.concat(centrals);
    const count = centrals.length / 2;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(0, 4);                   // this disk
    eocd.writeUInt16LE(0, 6);                   // disk with central dir
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(centralBytes.length, 12);
    eocd.writeUInt32LE(localBytes.length, 16);
    eocd.writeUInt16LE(0, 20);                  // comment length

    return { zip: Buffer.concat([ localBytes, centralBytes, eocd ]), count };
}

/******************************************************************************/

// Just enough protobuf to build a CrxFileHeader:
//
//   message AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
//   message CrxFileHeader {
//       repeated AsymmetricKeyProof sha256_with_rsa = 2;
//       bytes signed_header_data = 10000;
//   }
//   message SignedData { bytes crx_id = 1; }

function varint(value) {
    const bytes = [];
    let n = value;
    while ( n > 0x7F ) {
        bytes.push((n & 0x7F) | 0x80);
        n >>>= 7;
    }
    bytes.push(n);
    return Buffer.from(bytes);
}

function lengthDelimited(fieldNumber, payload) {
    return Buffer.concat([
        varint((fieldNumber << 3) | 2),
        varint(payload.length),
        payload,
    ]);
}

/******************************************************************************/

const privateKey = createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
const publicKeyDer = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
});

// The CRX id is the first 16 bytes of the SHA-256 of the SPKI public key; the
// extension id Chrome displays is that value with each hex digit mapped onto
// a-p.
const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
const extensionId = crxId.toString('hex').replace(
    /[0-9a-f]/g,
    c => String.fromCharCode(0x61 + parseInt(c, 16))
);

const { zip, count } = makeZip(path.resolve(dir));

const signedHeaderData = lengthDelimited(1, crxId);

// Signature covers a magic prefix, the length-prefixed signed header, then the
// archive itself.
const signature = createSign('sha256')
    .update(Buffer.from('CRX3 SignedData\x00', 'binary'))
    .update((( ) => {
        const len = Buffer.alloc(4);
        len.writeUInt32LE(signedHeaderData.length, 0);
        return len;
    })())
    .update(signedHeaderData)
    .update(zip)
    .sign(privateKey);

const keyProof = Buffer.concat([
    lengthDelimited(1, publicKeyDer),
    lengthDelimited(2, signature),
]);

const header = Buffer.concat([
    lengthDelimited(2, keyProof),
    lengthDelimited(10000, signedHeaderData),
]);

const prologue = Buffer.alloc(12);
prologue.write('Cr24', 0, 'binary');
prologue.writeUInt32LE(3, 4);
prologue.writeUInt32LE(header.length, 8);

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, Buffer.concat([ prologue, header, zip ]));

/******************************************************************************/

const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
);

const updateXml = args.get('update-xml');
if ( updateXml ) {
    const codebase = args.get('codebase');
    if ( !codebase ) {
        console.error('--update-xml requires --codebase');
        process.exit(1);
    }
    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
        `  <app appid="${extensionId}">`,
        `    <updatecheck codebase="${codebase}" version="${manifest.version}" />`,
        '  </app>',
        '</gupdate>',
        '',
    ].join('\n');
    fs.mkdirSync(path.dirname(path.resolve(updateXml)), { recursive: true });
    fs.writeFileSync(updateXml, xml);
}

/******************************************************************************/

console.log(`*** make-crx: ${outPath}`);
console.log(`    files       ${count}`);
console.log(`    version     ${manifest.version}`);
console.log(`    extension id ${extensionId}`);
if ( updateXml ) {
    console.log(`    update.xml  ${updateXml}`);
}

// Consumed by the release workflow.
if ( process.env.GITHUB_OUTPUT ) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
        `extension_id=${extensionId}`,
        `version=${manifest.version}`,
        '',
    ].join('\n'));
}
