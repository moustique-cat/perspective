# perspective
meow meow meow

## Development

The site is one continuous zoom from a proton to the edge of the observable universe, with
Moustique at the centre. It is built from the unedited design in
[`design/original/`](design/README.md): the drawing, the captions and the stylesheet are
read out of that file on every build, and the tests hold the site to it.

### Setting up on macOS or Linux

Node.js comes from [fnm](https://github.com/Schniz/fnm), which installs the exact version pinned in
`.nvmrc`, the one the tests run on. Do not install Node.js itself from Homebrew or a system package.

macOS, with [Homebrew](https://brew.sh):

```bash
brew install git fnm
echo 'eval "$(fnm env --use-on-cd --shell zsh)"' >> ~/.zshrc
```

Linux (Debian or Ubuntu; elsewhere, your own package manager for the first line):

```bash
sudo apt install -y git curl unzip
curl -fsSL https://fnm.vercel.app/install | bash
```

Then, in a new terminal, on both:

```bash
git clone https://github.com/moustique-cat/perspective.git
cd perspective
fnm use --install-if-missing   # install and select the pinned Node.js (if fnm asks first, answer y)
npm ci --include=dev           # exactly the versions in package-lock.json
npm run dev                    # start the site, then open the address it prints
```

After a `git pull`, run the `fnm` and `npm ci` lines again. Use `npm ci`, not `npm install`, which can
rewrite the lockfile, and never `sudo` or `-g` with npm: the tools run from the project with `npx`.

### The other commands

```bash
npm test                          # unit tests
npm run build                     # build the site into dist/
npx playwright install chromium   # once, for the browser tests (on Linux, add --with-deps)
npm run test:e2e                  # browser tests, against dist/
npm run bench                     # speed report, against dist/
```

- `npm test` runs the design's own script next to the site's code and requires every value
  and every frame of motion to be equal.
- `npm run test:e2e` opens the original artboard and the built site side by side in a browser
  and compares them, structure and pixels, across the whole zoom.
- `npm run bench` times a scripted zoom from proton to edge and the first moments of loading.

Options in the address: `?cm=60` (Moustique's length, 20 to 90), `?speed=2` (flight speed,
0.2 to 3), `?ink=26304A` (ink colour) and `?hand=1` (hand-drawn line).

Pushing to `main` publishes to GitHub Pages once the tests pass
(`.github/workflows/site.yml`). Third-party fonts and tools are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

© 2026 Moustique.

- **Code** (HTML, CSS, JavaScript, scripts): [PolyForm Noncommercial 1.0.0](LICENSE).
  Free for personal, educational and other noncommercial use. No commercial use.
- **Artwork and writing**: the drawings (including their SVG path data,
  wherever it is stored), the Moustique character, and all captions and
  on-screen text are licensed under
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/):
  free to share and adapt for non-commercial purposes, with credit to
  "Moustique". No commercial use.
