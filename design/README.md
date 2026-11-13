# The design

`original/` holds the design exactly as it was made: the artboard
"1b · Powers of Moustique (refined)" (`PowersRefined.dc.html`) and the canvas index it came
with (`canvas.json`). These two files are never edited. `original/SHA256SUMS` records their
checksums, and the tests and the CI workflow fail if either file changes by a single byte.

The site is built *from* `PowersRefined.dc.html` on every build
(`scripts/extract-design.mjs`): the drawing, the captions and the stylesheet are read out of
it, not copied by hand. The same file is also the judge in the tests: they run its own script
and its own markup and require the site to agree with it.

The files are the work of Moustique and are covered by the licences in the repository's
README.
