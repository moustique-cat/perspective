# Third-party notices

Everything in this repository is covered by the licences described in the README, except
the items below, which belong to their own authors and keep their own licences.

## Shipped with the site

The site contains no third-party code. It serves two typefaces, the same ones the design
loads from Google Fonts, as files of its own:

| Typeface | Files | Copyright | Licence |
|---|---|---|---|
| Inter | `public/fonts/inter-v20-*.woff2` | The Inter Project Authors (https://github.com/rsms/inter) | SIL Open Font License 1.1: `public/fonts/OFL-Inter.txt` |
| EB Garamond | `public/fonts/eb-garamond-v33-*.woff2` | The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12) | SIL Open Font License 1.1: `public/fonts/OFL-EB-Garamond.txt` |

The font files are unmodified copies of the ones served by Google Fonts for
`EB Garamond:ital,wght@0,400;0,500;1,400` and `Inter:wght@400;500;600` (Latin and Latin
Extended subsets).

## Used to build and test, not shipped

Installed from npm by `npm ci`; none of it ends up in the published site.

| Tool | Licence |
|---|---|
| TypeScript | Apache-2.0 |
| Vite | MIT |
| Vitest | MIT |
| Playwright | Apache-2.0 |
| pngjs | MIT |
| @types/node, @types/pngjs | MIT |
