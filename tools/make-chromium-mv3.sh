#!/usr/bin/env bash
#
# This script assumes a linux environment
#
# Build the Chromium MV3 package. Mirrors tools/make-chromium.sh, with three
# differences:
# - platform/chromium/manifest.json is not used directly; the MV3 manifest is
#   generated from it by tools/make-chromium-mv3-meta.py
# - platform/chromium-mv3/ supplies the service worker, the MV2->MV3 compat
#   shims, and the offscreen document
# - src/background.html is dropped, as MV3 has no background page

set -e

echo "*** uBlock0.chromium-mv3: Creating web store package"

DES=dist/build/uBlock0.chromium-mv3
rm -rf $DES
mkdir -p $DES

echo "*** uBlock0.chromium-mv3: Copying common files"
bash ./tools/copy-common-files.sh $DES

# Chromium-specific. webext.js and vapi-background-ext.js are reused as-is --
# platform/chromium-mv3/mv3-shims.js patches the chrome.* APIs underneath them.
echo "*** uBlock0.chromium-mv3: Copying chromium-specific files"
cp platform/chromium/*.js   $DES/js/
cp platform/chromium/*.html $DES/

# MV3-specific
echo "*** uBlock0.chromium-mv3: Copying MV3-specific files"
cp platform/chromium-mv3/*.js   $DES/js/
cp platform/chromium-mv3/*.html $DES/

# No background page under MV3.
rm -f $DES/background.html

# Chrome store-specific
cp -R $DES/_locales/nb $DES/_locales/no

echo "*** uBlock0.chromium-mv3: Generating manifest..."
python3 tools/make-chromium-mv3-meta.py $DES/

if [ "$1" = all ]; then
    echo "*** uBlock0.chromium-mv3: Creating plain package..."
    pushd $(dirname $DES/) > /dev/null
    zip uBlock0.chromium-mv3.zip -qr $(basename $DES/)/*
    popd > /dev/null
elif [ -n "$1" ]; then
    echo "*** uBlock0.chromium-mv3: Creating versioned package..."
    pushd $(dirname $DES/) > /dev/null
    zip uBlock0_"$1".chromium-mv3.zip -qr $(basename $DES/)/*
    popd > /dev/null
fi

echo "*** uBlock0.chromium-mv3: Package done."
