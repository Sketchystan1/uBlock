# Network requests this fork makes

Upstream uBlock Origin's privacy policy states that "the only time uBO connects to a
remote server is to update the filter lists and other related assets" — no telemetry, no
home server, no data collection. That remains true of the filtering engine in this fork:
it collects nothing and phones nothing home.

This fork does, however, add **one class of behind-the-scene request upstream never made**:
the extension updates *itself* from a self-hosted endpoint. Upstream's own trust checklist
asks "what network requests are made by an extension behind the scene?", so this document
answers that explicitly rather than folding it into "other related assets."

## The self-update request

MV3 builds bake an `update_url` into the generated manifest
(`tools/make-chromium-mv3-meta.py`), pointing at this fork's GitHub Pages site:

| Build channel | Endpoint |
|---|---|
| Stable (`X.Y.Z`) | `https://sketchystan1.github.io/uBlock/update.xml` |
| Dev / beta / rc | `https://sketchystan1.github.io/uBlock/update-dev.xml` |

Chrome polls that URL roughly every five hours (the same Omaha mechanism the Web Store
uses), reads the advertised version, and downloads a new CRX from the release's GitHub
download URL when one is newer. This is the price of shipping a full-engine MV3 build
outside the Web Store — there is no store to deliver updates, so the extension carries its
own update pointer.

Notes:

- The base URL is overridable at build time via `UBLOCK_UPDATE_BASE_URL`.
- The `update_url` is **inert for unpacked/dev loads** and **ignored by the Web Store**, so
  it only ever fires for CRX installs (external-update-url or policy force-install).
- A policy force-install can point at the same manifest; a self-updating CRX and a policy
  install then track the identical `update.xml`. See [`mv3-deployment.md`](mv3-deployment.md).

## What this means for the privacy posture

- **The update endpoint is visible in uBO's own logger** as a behind-the-scene request. That
  is expected, not a leak — but it is a request upstream's policy text does not cover, which
  is why it is named here.
- The request carries only what Chrome's update protocol sends (extension id, current
  version, standard update-check parameters). No user data, filter state, or browsing
  information is transmitted.
- The no-telemetry, no-data-collection, and no-home-server clauses inherited from upstream
  stay true only while this fork keeps them true. This document is the one deliberate,
  disclosed exception.

## Identity

This is a **fork** of uBlock Origin, not upstream uBO and not `ublock.org`. It is not
distributed through the Chrome Web Store. Filter-list update requests behave exactly as
upstream; the self-update request above is the only fork-specific addition.
