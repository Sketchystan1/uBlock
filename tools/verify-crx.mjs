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

    Verify a CRX3 produced by tools/make-crx.mjs, and the update manifest that
    goes with it.

    Why bother: a policy install is the only way this build gets
    `webRequestBlocking`, and a malformed CRX fails there with an unhelpful
    error, long after the release has been published. Nothing else in the
    pipeline reads the CRX back, so this parses it the way Chrome does --
    independently of the code that wrote it -- and checks the signature, the
    extension id derivation, and that the payload matches the directory it was
    built from.

    Usage:
      node tools/verify-crx.mjs --crx <file.crx> [--dir <unpacked-dir>]
                               [--update-xml <update.xml>]

    Exits 0 when everything checks out, 1 otherwise.

**/

import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

/******************************************************************************/

const args = new Map();
for ( let i = 2; i < process.argv.length; i += 2 ) {
    args.set(process.argv[i].replace(/^--/, ''), process.argv[i+1]);
}

const crxPath = args.get('crx');
if ( !crxPath ) {
    console.error('Usage: verify-crx.mjs --crx <file.crx> [--dir <dir>] [--update-xml <file>]');
    process.exit(1);
}

const inActions = process.env.GITHUB_ACTIONS === 'true';
let failures = 0;

function fail(check, message) {
    failures += 1;
    if ( inActions ) {
        console.log(`::error title=${check}::${message.replace(/\n\s*/g, ' -- ')}`);
    }
    console.log(`  FAIL  ${check}`);
    console.log(`        ${message.split('\n').join('\n        ')}`);
}

function pass(check, detail) {
    console.log(`  ok    ${check}${detail ? `  ${detail}` : ''}`);
}

/******************************************************************************/

// Minimal protobuf wire-format reader: enough for CrxFileHeader and SignedData.

function readVarint(buf, pos) {
    let value = 0;
    let shift = 0;
    for (;;) {
        const byte = buf[pos++];
        value += (byte & 0x7F) * Math.pow(2, shift);
        if ( (byte & 0x80) === 0 ) { break; }
        shift += 7;
    }
    return { value, pos };
}

// Returns a Map of fieldNumber -> array of Buffers, for length-delimited fields.
function readMessage(buf) {
    const fields = new Map();
    let pos = 0;
    while ( pos < buf.length ) {
        const tag = readVarint(buf, pos);
        pos = tag.pos;
        const fieldNumber = Math.floor(tag.value / 8);
        const wireType = tag.value % 8;
        if ( wireType !== 2 ) {
            // Nothing we care about uses another wire type; skip conservatively.
            if ( wireType === 0 ) {
                pos = readVarint(buf, pos).pos;
                continue;
            }
            throw new Error(`unsupported protobuf wire type ${wireType} for field ${fieldNumber}`);
        }
        const len = readVarint(buf, pos);
        pos = len.pos;
        const payload = buf.subarray(pos, pos + len.value);
        pos += len.value;
        if ( fields.has(fieldNumber) === false ) { fields.set(fieldNumber, []); }
        fields.get(fieldNumber).push(payload);
    }
    return fields;
}

/******************************************************************************/

const crx = fs.readFileSync(path.resolve(crxPath));
console.log(`*** verify-crx: ${crxPath} (${crx.length} bytes)`);

if ( crx.subarray(0, 4).toString('latin1') !== 'Cr24' ) {
    fail('magic', `bad magic: expected "Cr24", got ${JSON.stringify(crx.subarray(0, 4).toString('latin1'))}`);
    process.exit(1);
}
pass('magic', 'Cr24');

const format = crx.readUInt32LE(4);
if ( format !== 3 ) {
    fail('format-version', `expected CRX version 3, got ${format}`);
} else {
    pass('format-version', '3');
}

const headerLength = crx.readUInt32LE(8);
if ( headerLength <= 0 || 12 + headerLength > crx.length ) {
    fail('header-length', `header length ${headerLength} does not fit in a ${crx.length}-byte file`);
    process.exit(1);
}
const header = crx.subarray(12, 12 + headerLength);
const zip = crx.subarray(12 + headerLength);
pass('layout', `header ${headerLength} bytes, payload ${zip.length} bytes`);

/******************************************************************************/

let fields;
try {
    fields = readMessage(header);
} catch ( ex ) {
    fail('header-parse', `CrxFileHeader is not valid protobuf: ${ex.message}`);
    process.exit(1);
}

const proofs = fields.get(2) || [];          // sha256_with_rsa
const signedHeaderDatas = fields.get(10000) || [];

if ( proofs.length === 0 ) {
    fail('key-proof', 'no sha256_with_rsa key proof in the header (field 2)');
}
if ( signedHeaderDatas.length !== 1 ) {
    fail('signed-header', `expected exactly one signed_header_data (field 10000), got ${signedHeaderDatas.length}`);
}
if ( failures !== 0 ) { process.exit(1); }
pass('header-fields', `${proofs.length} key proof(s), signed_header_data present`);

const signedHeaderData = signedHeaderDatas[0];
const signedData = readMessage(signedHeaderData);
const crxIds = signedData.get(1) || [];
if ( crxIds.length !== 1 || crxIds[0].length !== 16 ) {
    fail('crx-id', `SignedData.crx_id must be 16 bytes, got ${crxIds[0] ? crxIds[0].length : 'none'}`);
    process.exit(1);
}
const crxId = crxIds[0];

/******************************************************************************/

const proof = readMessage(proofs[0]);
const publicKeyDer = (proof.get(1) || [])[0];
const signature = (proof.get(2) || [])[0];
if ( publicKeyDer === undefined || signature === undefined ) {
    fail('key-proof', 'key proof is missing public_key (field 1) or signature (field 2)');
    process.exit(1);
}

let publicKey;
try {
    publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
} catch ( ex ) {
    fail('public-key', `public_key is not a valid SPKI DER key: ${ex.message}`);
    process.exit(1);
}
pass('public-key', `${publicKey.asymmetricKeyType} ${publicKey.asymmetricKeyDetails?.modulusLength || '?'} bits`);

// The CRX id is the first 16 bytes of SHA-256 over the SPKI public key; the id
// Chrome shows maps each hex digit onto a-p.
const digest = createHash('sha256').update(publicKeyDer).digest();
const derivedId = digest.subarray(0, 16);
if ( derivedId.equals(crxId) === false ) {
    fail('crx-id',
        `SignedData.crx_id does not match SHA-256(public_key)[0..16]\n` +
        `  in file: ${crxId.toString('hex')}\n` +
        `  derived: ${derivedId.toString('hex')}`);
} else {
    pass('crx-id', crxId.toString('hex'));
}

const extensionId = derivedId.toString('hex').replace(
    /[0-9a-f]/g,
    c => String.fromCharCode(0x61 + parseInt(c, 16))
);

/******************************************************************************/

// Signature covers a magic prefix, the length-prefixed signed header, then the
// archive. Verified here against the file as written, not against whatever
// make-crx.mjs thinks it signed.
{
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(signedHeaderData.length, 0);
    const verifier = createVerify('sha256');
    verifier.update(Buffer.from('CRX3 SignedData\x00', 'latin1'));
    verifier.update(lengthPrefix);
    verifier.update(signedHeaderData);
    verifier.update(zip);
    if ( verifier.verify(publicKey, signature) === false ) {
        fail('signature', 'RSA-SHA256 signature does not verify over CRX3 SignedData || len || header || payload');
    } else {
        pass('signature', `RSA-SHA256 over ${zip.length + signedHeaderData.length + 20} bytes`);
    }
}

/******************************************************************************/

// Read the zip's central directory and compare against the source tree. Chrome
// requires manifest.json at the archive root.

function readZipEntries(buf) {
    // End of central directory: scan back for the signature.
    let eocd = -1;
    for ( let i = buf.length - 22; i >= 0; i-- ) {
        if ( buf.readUInt32LE(i) === 0x06054B50 ) { eocd = i; break; }
    }
    if ( eocd === -1 ) { throw new Error('no end-of-central-directory record'); }
    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for ( let i = 0; i < count; i++ ) {
        if ( buf.readUInt32LE(pos) !== 0x02014B50 ) {
            throw new Error(`bad central directory entry at ${pos}`);
        }
        const method = buf.readUInt16LE(pos + 10);
        const crc = buf.readUInt32LE(pos + 16);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const nameLength = buf.readUInt16LE(pos + 28);
        const extraLength = buf.readUInt16LE(pos + 30);
        const commentLength = buf.readUInt16LE(pos + 32);
        const offset = buf.readUInt32LE(pos + 42);
        const name = buf.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
        entries.push({ name, method, crc, compressedSize, uncompressedSize, offset });
        pos += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

let entries;
try {
    entries = readZipEntries(zip);
    pass('zip-structure', `${entries.length} entries`);
} catch ( ex ) {
    fail('zip-structure', `payload is not a readable zip: ${ex.message}`);
    entries = [];
}

if ( entries.length !== 0 ) {
    if ( entries.some(e => e.name === 'manifest.json') === false ) {
        fail('zip-manifest', 'manifest.json is not at the archive root -- Chrome will reject the CRX');
    } else {
        pass('zip-manifest', 'manifest.json at archive root');
    }

    // Extract manifest.json from the local header and confirm it parses.
    const entry = entries.find(e => e.name === 'manifest.json');
    if ( entry !== undefined ) {
        try {
            const nameLength = zip.readUInt16LE(entry.offset + 26);
            const extraLength = zip.readUInt16LE(entry.offset + 28);
            const start = entry.offset + 30 + nameLength + extraLength;
            const raw = zip.subarray(start, start + entry.compressedSize);
            const data = entry.method === 8 ? inflateRawSync(raw) : raw;
            const manifest = JSON.parse(data.toString('utf8'));
            pass('zip-manifest-parse', `version ${manifest.version}, manifest_version ${manifest.manifest_version}`);
            if ( manifest.manifest_version !== 3 ) {
                fail('zip-manifest-parse', `packaged manifest_version is ${manifest.manifest_version}, not 3`);
            }
            globalThis.__packagedVersion = manifest.version;
        } catch ( ex ) {
            fail('zip-manifest-parse', `could not read manifest.json out of the archive: ${ex.message}`);
        }
    }
}

const dir = args.get('dir');
if ( dir !== undefined && entries.length !== 0 ) {
    const root = path.resolve(dir);
    const onDisk = [];
    const walk = current => {
        for ( const e of fs.readdirSync(current, { withFileTypes: true }) ) {
            const full = path.join(current, e.name);
            if ( e.isDirectory() ) { walk(full); continue; }
            if ( e.isFile() === false ) { continue; }
            onDisk.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    walk(root);
    const inCrx = new Set(entries.map(e => e.name));
    const missing = onDisk.filter(f => inCrx.has(f) === false);
    const extra = [ ...inCrx ].filter(f => onDisk.includes(f) === false);
    if ( missing.length !== 0 || extra.length !== 0 ) {
        fail('payload-matches-dir',
            `archive does not match ${dir}\n` +
            (missing.length ? `  ${missing.length} missing from CRX: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}\n` : '') +
            (extra.length ? `  ${extra.length} extra in CRX: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' ...' : ''}` : ''));
    } else {
        pass('payload-matches-dir', `${onDisk.length} files`);
    }
}

/******************************************************************************/

const updateXml = args.get('update-xml');
if ( updateXml !== undefined ) {
    const xml = fs.readFileSync(path.resolve(updateXml), 'utf8');
    const appid = /appid=["']([^"']+)["']/.exec(xml);
    const version = /<updatecheck[^>]*\bversion=["']([^"']+)["']/.exec(xml);
    const codebase = /<updatecheck[^>]*\bcodebase=["']([^"']+)["']/.exec(xml);
    if ( appid === null || appid[1] !== extensionId ) {
        fail('update-xml-appid',
            `update.xml appid does not match the CRX's extension id\n` +
            `  update.xml: ${appid ? appid[1] : '(none)'}\n` +
            `  crx:        ${extensionId}`);
    } else {
        pass('update-xml-appid', extensionId);
    }
    const packaged = globalThis.__packagedVersion;
    if ( version === null ) {
        fail('update-xml-version', 'update.xml has no <updatecheck version="...">');
    } else if ( packaged !== undefined && version[1] !== packaged ) {
        fail('update-xml-version',
            `update.xml advertises ${version[1]} but the packaged manifest says ${packaged} -- ` +
            `Chrome compares the advertised version, so clients would loop or never update`);
    } else {
        pass('update-xml-version', version[1]);
    }
    if ( codebase === null ) {
        fail('update-xml-codebase', 'update.xml has no codebase URL');
    } else if ( codebase[1].startsWith('https://') === false ) {
        fail('update-xml-codebase', `codebase must be https, got ${codebase[1]}`);
    } else {
        pass('update-xml-codebase', codebase[1]);
    }
}

/******************************************************************************/

console.log(`    extension id ${extensionId}`);
if ( failures !== 0 ) {
    console.log(`\n*** verify-crx: FAILED (${failures} problem(s))`);
    process.exit(1);
}
console.log('\n*** verify-crx: OK');
