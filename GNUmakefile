# GNU Make reads this file before Makefile. Keep upstream's default target and
# targets intact, and add the full MV3 fork without changing upstream's file.
include Makefile

.PHONY: chromium-mv3-fork

fork-mv3-sources := $(sources) \
	$(wildcard platform/chromium/*) \
	$(wildcard platform/chromium-mv3/*) \
	$(wildcard platform/common/*) \
	$(wildcard tools/*mv3* tools/make-crx* tools/copy-common-files*) \
	dist/mv3-build $(wildcard dist/mv3-release.json) GNUmakefile

dist/build/uBlock0.chromium-mv3: tools/make-chromium-mv3.sh $(fork-mv3-sources) $(assets)
	bash tools/make-chromium-mv3.sh

chromium-mv3-fork: dist/build/uBlock0.chromium-mv3
