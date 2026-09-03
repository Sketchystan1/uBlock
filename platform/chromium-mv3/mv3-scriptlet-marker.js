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

    Carries the list of scriptlet filters that fired from `mv3-post.js`, which
    knows it, to `mv3-shims.js`, which needs it in a different execution world.

    Under MV2 the wrapper returned by `vAPI.scriptletsInjector` recorded those
    filters in `self.uBO_scriptletsInjected`, in the same isolated world as
    `contentscript.js`. Under MV3 the wrapper is a code string, so only
    `chrome.userScripts` can inject it, and its only non-`MAIN` world is
    `USER_SCRIPT` -- where neither of the marker's readers can see it. The two
    ends of this module put it back: `mv3-post.js` prefixes the wrapper's output
    with an encoded marker, and `mv3-shims.js` peels it off before injecting and
    replays it into the `ISOLATED` world.

    It lives in a module of its own, with no dependency on `chrome.*` or the DOM,
    for two reasons: the two ends must not drift apart, and
    `tools/verify-mv3-package.mjs` can then import this straight out of a built
    package and round-trip it as part of every build.

    The wire format is one line comment holding percent-encoded JSON. Three
    properties are load-bearing, because the marker is concatenated into a larger
    program by `src/js/scriptlet-filtering.js` and must not disturb it:

    - percent-encoding emits no slash, so the payload can never close a block
      comment early -- which raw JSON would, given a filter containing a
      block-comment terminator (plenty do: `trusted-replace-regex` arguments);
    - it emits no newline, so the line comment cannot be cut short;
    - it round-trips text outside Latin-1, which `btoa()` would throw on -- filter
      lists are full of internationalized domains.

**/

/******************************************************************************/

const MARKER = '//uBO-mv3-filters:';

// Anchored to the start of a line, because `injectNow()` may prepend the logger
// relay and a `debugger` statement ahead of the wrapper, so the marker is not
// reliably first. Nothing else in the assembled program can start a line with
// it: every string literal in there has been through `JSON.stringify()`, which
// escapes newlines.
const reMarker = new RegExp(`^${MARKER}([^\\n]*)\\n?`, 'm');

/******************************************************************************/

export function encodeScriptletMarker(details) {
    return `${MARKER}${encodeURIComponent(JSON.stringify(details))}\n`;
}

// Returns the code with the marker removed, plus whatever it carried --
// `undefined` when there is no marker, which is the normal case for a document
// where only isolated-world scriptlets fired.
export function decodeScriptletMarker(code) {
    const match = reMarker.exec(code);
    if ( match === null ) {
        return { code, details: undefined };
    }
    return {
        code: code.replace(reMarker, ''),
        details: JSON.parse(decodeURIComponent(match[1])),
    };
}

/******************************************************************************/
