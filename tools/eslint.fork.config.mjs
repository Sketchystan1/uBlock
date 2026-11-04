import js from '@eslint/js';
import globals from 'globals';

// Fork-only ESLint config. The root eslint.config.mjs is an UPSTREAM file the
// port must not modify, and upstream's own sources do not pass a strict config
// (chrome/browser are undeclared, ~130 no-undef), so the CI `npm run lint` step
// is informational. This config lints ONLY the files the fork owns, with the
// service-worker/extension globals declared, and CI gates on it -- so a real
// error introduced into a fork file (an undefined variable, a duplicate key, an
// unreachable return) fails the build instead of shipping.
//
// It catches BUGS, not style: rules that would flag intentional fork patterns
// (empty catch blocks, control chars in the injection-error regexp) are off.

export default [
    {
        // Fork-owned sources only. Everything else is upstream.
        files: [
            'platform/chromium-mv3/*.js',
            'tools/patch-mv3-modules.mjs',
            'tools/verify-mv3-package.mjs',
            'tools/make-crx.mjs',
        ],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.serviceworker,
                ...globals.browser,
                ...globals.node,
                // uBO's background globals, referenced (not imported) by the
                // post module. `chrome`/`browser` are NOT declared here -- the
                // fork modules declare those themselves, and adding them would
                // trip no-redeclare. no-undef still catches a genuinely
                // undefined reference to anything else.
                µb: 'readonly',
                vAPI: 'writable',
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            // Bug-catching stays on (no-undef, no-dupe-keys, no-unreachable,
            // use-isnan, valid-typeof, ...). The following are intentional in
            // fork code or pure style, so they must not gate the build:
            'no-empty': 'off',          // `try { ... } catch {}` is idiomatic here
            'no-control-regex': 'off',  // the injection-error regexp is deliberate
            'no-unused-vars': [ 'warn', { args: 'none', caughtErrors: 'none' } ],
            'no-cond-assign': [ 'error', 'except-parens' ],
        },
    },
];
