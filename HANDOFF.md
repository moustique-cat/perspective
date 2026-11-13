# Milestone 2 handoff

Temporary. Written by the cloud session that started milestone 2, for the local session that
continues it on a Mac. **Delete this file before the pull request is merged.**

The owner's brief is the instruction; this note is one session's findings and reasoning. Where
they disagree, the brief wins. Each part below says whether it was **measured**, **reasoned**
(worked out, not yet run) or **recalled** (from memory of Chromium or Skia source: check before
relying on it).

No renderer code exists yet. Nothing was committed before this note.

## 1. Decided with the owner

Asked and answered on 13 November 2026. Do not ask these again.

| Question | Answer |
|---|---|
| How do they reach the branch build on their four devices for `?bench`? | **A preview on GitHub Pages.** Each push to the milestone branch also publishes it under `/perspective/preview/`, beside the main site, which is rebuilt unchanged from `main`. They accepted that this needs one setting from them: Settings > Environments > github-pages > allow the branch to deploy. Tell them the exact branch name or pattern when the workflow is ready. |
| How does `?original` come back "at the same zoom"? | **Remembered in the tab.** The page notes its zoom in session storage. Adding or removing `?original` in the same tab reopens at that zoom. An ordinary visit or reload still starts at Moustique, and the address looks as it does today. |
| Where does the renderer's code live? | **Separate files, fetched on demand.** One file per backend. A device fetches only the one it will use, after the page is zoomable. A device that stays on SVG fetches nothing. The page and its three size budgets stay as they are. The build rule in `vite.config.ts` becomes "one script inside the page". |
| What does `?hand` do in this milestone? | **Stays on the SVG**, exactly as today. The pencil effect on the graphics chip is its own later step. |

Also from the owner:

- **Branch names** relate to the theme of the app and are funny or inspirational. This branch is
  `moustiques-per-second`. Keep to that for later branches.
- They moved the work to a local Mac session so that speed can be measured on a real chip and
  WebGPU can be seen reaching the screen. Use that: measure early.

## 2. Measured in the cloud container

Linux, 4 cores, no graphics chip. Playwright 1.63.0 with Chromium 153.0.8010.12.

- **Baseline on `main` (a9c0349):** 56 unit tests and 35 browser tests pass. Compressed sizes:
  first view 12,494 B, zoomable 26,110 B, whole page 148,034 B.
- **WebGL2** works in headless Chromium through SwiftShader. `failIfMajorPerformanceCaveat: true`
  did **not** refuse it, so software rendering has to be recognised another way (the renderer
  string from `WEBGL_debug_renderer_info` read "SwiftShader").
- **WebGPU:** `navigator.gpu` exists but `requestAdapter()` returns null. With
  `--enable-unsafe-webgpu` it returns a SwiftShader adapter with `isFallbackAdapter: true`, a
  device, and a canvas context; preferred format `rgba8unorm`. Presenting to a canvas was not
  tested there.
- **A canvas changes the SVG around it.** Inserting a WebGL2 canvas behind the SVG at the home
  zoom (1280 x 820) changed 2,805 colour-channel values across the page by up to 4 levels (489
  in the caption area by up to 2; none in the header). So no canvas may exist on the SVG path,
  or the milestone 1 pixel tests break.
- **Text there is grey-scale smoothed:** no coloured fringes in any pixel of the page.
- **A plain distance ramp over-inks dots.** Coverage `clamp(r - d + 0.5)` gives a 1.4 px dot
  17.0 % too much ink, a 2 px dot 8.3 %, a 3.4 px dot 2.9 %, a 5.5 px dot 1.1 % (numerical
  integration against the true disc area). This is very likely the "dots too heavy" gap of the
  throwaway prototype.

Looked up, not measured (web search, November 2026): WebGPU ships in Safari 26 on macOS, iOS and
iPadOS; in Chrome and Edge on Windows, macOS, ChromeOS and Android 12+ with Qualcomm or ARM
chips; in Firefox on Windows (141) and Apple-silicon Macs (147). Still missing or pre-release:
Chrome on Linux, Firefox on Linux and Android. This agrees with the brief.

Not known: whether GitHub's macOS runners give Chromium a working graphics chip. Only a trial
run will tell. `site.yml` on `main` has `workflow_dispatch`, so it can be run on a branch.

## 3. Census of the drawing (measured)

Inside the main SVG: 33 layers, plus a few shapes whose geometry changes every frame.

- **Path commands:** M 5,662; `h0` dots 4,121; C 4,374; L 2,306; A 309; Z 294; V 15; H 10; Q 9.
  No relative commands except the `h0` of the dots.
- **Elements by class:** `ln` 88, `thin` 88, `wf` 38, `faint` 22, `pts` 15, `pt` 13, `dash` 13,
  `ptl` 8, `fi` 3, `ptx` 1, and 42 text labels.
- **Paint order matters only around fills.** `wf` (white fill, then a 1.25 px stroke): street 8
  (trees), room 1, cat 3, mosq 3, fur 5, mite 1, nuc 12, proton 3, and the Earth circle.
  `fi` (ink fill, no stroke): one path in the cat (three closed arc shapes: her eyes and nose),
  the Sun's dot, the marker's dot.
- **Translucent strokes** (`faint` 42 %, `dash` 55 %) appear in most layers. Two special cases:
  laniakea has a `thin` path with `stroke-opacity: 0.6`, and edge has a `pts` path inside
  `<g opacity="0.4">`.
- **Dashed:** edge, laniakea, bao, stars (two rings), sedna, helio, moon (two), kingdom, fur,
  chrom, proton, and the atmosphere circle.
- **Static transforms inside layers:** andro `rotate(-20)`; mw and mwdots
  `translate scale(1.06) translate`; cat `{{ catK }}` then `translate scale(1.4027)`; mite
  `translate rotate(-15)`; win `{{ winT }}`, which is `scale(1.4 1)`: the one non-uniform scale,
  and it holds no dashes.
- **Largest layers by element count:** cells 60, street 53, nuc 18 (white circle, white circle,
  plus sign, repeated), fur 13, mw 12, house 12, mosq 11, stars 11.
- **Per-frame shapes inside the filter group:** atmosphere `<circle class="dash">`, Earth
  `<circle class="wf">`, the grid group (`faint`), the ground `<line class="ln">`.
- **Outside the filter group, after every layer:** the Sun group, the space station group, the
  100 km label, the "Moustique is here" marker group, then the labels.

## 4. The design I had settled on (reasoned, not yet run)

### What the chip draws

Everything inside `<g filter="{{ pf }}">`: the 33 layers, the atmosphere and Earth circles, the
grid and the ground line. That is also exactly what the `?hand` filter covers.

The Sun, the space station, the marker and all labels stay SVG, in a second small SVG above the
canvas. They are a handful of marks, they sit outside the filter group in the design too, and
the browser keeps setting the text, so the words cannot change.

Stacking after takeover: the old SVG drawing (hidden), an **opaque** canvas above it, the small
SVG with labels above that, then the stage, header, rail and captions as today. An opaque
canvas on top needs no perfectly timed swap: it can appear over the SVG, and the SVG is hidden
a frame later.

### Two colours make most of the order free

Every mark is ink or white, so the picture is one number per pixel: how much ink. Ink over ink
multiplies what is left of the white, and multiplication does not care about order. Only white
fills and group opacity impose an order. So all ink between two fills can go in one batch.

### Smoothing

Computed per pixel from geometry, never multisampling: four samples give five grey levels, the
coarse smoothing the other engines were rejected for.

- **Strokes:** the exact area a strip covers in a pixel depends on its angle (a trapezoid
  kernel, not a box). At 45 degrees a 1.25 px line peaks at 0.987, not 1. Cheap to do exactly.
- **Dots:** exact disc-against-pixel area, see the 17 % figure above.
- **Joints:** each segment carries its neighbours; a pixel belongs to the segment on its side
  of the angle bisector. Adjacent segments then never both shade a pixel, so plain "over"
  blending is right at joints and at crossings.

### What SVG means, and has to keep meaning

- The stroke of one path is one shape. A translucent path does not darken where it crosses
  itself. Example: the Earth grid's meridians all meet at the poles; drawn naively the poles go
  from 42 % to nearly black.
- A layer's opacity is group opacity: draw the layer whole, then fade it.

### One element as one shape, in a single pass

Uses the destination's alpha as a scratch register, resting at 1. For a translucent element
with opacity a and per-pixel coverage c:

1. **Accumulate:** colour untouched; `alpha = c * (1 - a) + alpha * (1 - c)`.
   Blend: colour (ZERO, ONE); alpha (CONSTANT_ALPHA, ONE_MINUS_SRC_ALPHA) with the blend
   constant's alpha set to `1 - a`; the shader outputs alpha = c.
2. **Resolve**, drawing the same marks again with a trivial shader:
   `colour = ink * (1 - alpha) + colour * alpha`, then `alpha = 1`.
   Blend: colour (ONE_MINUS_DST_ALPHA, DST_ALPHA); alpha (ONE, ZERO).

The first touch of a pixel in step 2 applies the whole element and resets the register, so
later touches do nothing. No extra render target. Two draws per translucent element.

A variant with `MIN` as the alpha equation gives a strict maximum instead; better for many
coincident marks (a dot cloud shrunk to a blob), worse at crossings. Which to use where should
be settled against the SVG, not on paper.

The canvas needs a real alpha channel for this (premultiplied mode; it ends every frame at
alpha 1, so it is still an opaque picture), or else render to a texture and copy.

### Fading layers

A layer at full opacity draws straight to the main target. A layer in mid-fade draws into an
RGBA8 target (ink amount, coverage, register) and is then laid over the picture with its
opacity. Render those targets first, then one main pass, to avoid switching back and forth.

### Fills

A white fill only needs a hard-edged inside: its own stroke sits on the edge. The error is at
most about 9 levels, and only where ink lies under the edge. The cat's `fi` path needs smoothed
edges of its own.

### Geometry

- **Source:** parse the path data from the SVG already in the page. No extra download, and the
  two drawings have identical content by construction.
- **Arcs (recalled):** Chromium turns a path's `A` commands into cubic curves, at most 90
  degrees each, with handle length `4/3 * tan(angle / 4)`. Such a curve is off the true circle
  by up to 0.027 % of the radius: a quarter of a pixel at a radius near 1,000 px. To match the
  SVG closely, convert arcs the same way. A `<circle>` element, by contrast, is a true circle.
- **Curves:** flatten once into segment records at several levels of fineness. Each record
  carries the range of scale it is for, and the vertex shader drops the others. Nothing is
  recomputed when the zoom changes. Aim for about 0.02 to 0.03 device px of error.
- **Numbers:** keep each layer in its own 32-bit coordinates and give it a transform computed
  in double precision from the very strings the SVG gets (`toPrecision(6)`, `toFixed(2)`), so
  both pictures are placed by the same numbers.
- **Huge circles:** the atmosphere circle is about 41,500 units in radius at 10^5.3 m, about
  62,000 px on a 1,920 px window; the Earth circle reaches about 129,000 units. Measure
  distance from the point of the circle nearest the screen, not from its centre, or 32-bit
  floats cancel.

### Dashes

Non-scaling strokes dash in screen pixels (2 on, 5 off, round caps), counted along each
subpath from its start.

- **Why the SVG is slow (reasoned):** the dasher walks the whole circle even when a sliver is
  on screen. That fits both slow patches: the atmosphere circle near 10^5 m, and the two star
  rings (radius 303 and 607 units, layer scale up to 31.6) near 10^15.8 m.
- **Phase (recalled):** Skia measures length by adding chords, splitting a curve until it is
  within 0.5 device px of flat (`SkContourMeasure`: `compute_cubic_segs`, `cubic_too_curvy`).
  Its lengths run short of the true length: up to about 1 px over a full circle, and several
  px along a long curvy outline. Dashes placed by true length would sit visibly apart from the
  SVG's in a pixel comparison. Plan: port that measuring, keep a fixed fraction-along-the-curve
  on each segment, and refresh a small table of measured lengths per dashed curve per frame.
  Try the simple version first and see what the comparison says.
- **Non-scaling strokes (recalled):** Chromium transforms the path by the scale and rotation
  to the SVG root, without translation, and strokes it there.

### Cost follows what is visible

The view is nested around a fixed centre in each layer's own coordinates. For zoom >= -0.25
the centre is the cat's point (201.4, 103.1) x cm/46; below -0.85 it is the layer origin; in
between it moves. Sort marks by distance from that centre and the visible set is a prefix,
found by one binary search. For milestone 3, bucket by fineness and by distance.

Draw calls: dots, segments and fill triangles can all be four-vertex instances of one shader,
so a layer is a handful of calls. Budget tens per frame, not hundreds; WebGL calls are costly
on phones.

### The page

- **Milestone 1 tests stay as they are.** On a machine with no graphics chip the address `/`
  stays on SVG and fetches nothing extra, so those tests keep testing the SVG path. New tests
  switch the renderer on through an explicit address option. On a machine that has a chip
  (this Mac) the test browser must not quietly take the renderer path: pin that in
  `playwright.config.ts`, not in the tests.
- **Takeover:** at rest, a short crossfade of the canvas over the SVG drawing; in motion,
  switch on a frame boundary. Then hide the SVG drawing and stop writing its bindings.
- **Speed is only real on a real chip.** GitHub's Linux job catches regressions only.

## 5. Not yet known

- Whether text keeps its look when a canvas sits under it on Windows, where text is smoothed
  in colour. It may turn grey-scale at takeover. Needs a look on the owner's PC.
- The comparison limits (total ink, per-pixel difference, line width). The brief asks to
  propose them and show what they allow. Known floor: Skia's own stroker is only within about
  a quarter of a pixel of ideal in its worst spots (recalled).
- Whether the preview deploy needs a `push` trigger, not `pull_request` (recalled: the
  environment's branch rule is checked against the ref, and a pull request's ref is not a
  branch).
- Real speed, on anything.

## 6. Housekeeping

- The cloud session's auto-named branch `claude/intelligent-cori-d26ybr` is still on GitHub,
  with nothing on it beyond `main`. It can be deleted.
- Suggested order: marks into records with unit tests; WebGL2 backend; comparison against the
  SVG and tuning; WebGPU backend; the page (takeover, `?original`, loading); `npm run bench`
  and the `?bench` page; CI, the Mac job and the preview; screenshots and the pull request.
