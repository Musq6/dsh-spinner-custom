/**
 * The generated region of client.js: the one place that knows its shape.
 *
 * client.js carries a block bounded by two banners, and that block is written by
 * a tool rather than by hand. This module is the format — the writer
 * (tools/embed-asset.mjs) and every reader (tools/check-plugin.mjs,
 * tools/build-preview.mjs, tools/verify-chromium.mjs, tools/check-embed.mjs) go
 * through it, so the two halves cannot drift apart.
 *
 * That matters more here than it looks. The region holds not only the payloads
 * but the numbers derived from them — each style's edge and recommended size —
 * and those numbers are what the size slider's range, its readout and the
 * checker assertions are all built from. Two independent regexes over the same
 * text would be two chances to disagree about what the plugin is set to.
 *
 * The same argument as tools/png-meta.mjs: read the thing in one place, or
 * accept that you have N implementations of "what does this say".
 *
 * @module tools/region
 */

/** The opening banner, without indentation. Both must be present, in order. */
export const REGION_START = '// ===================== generated: the artwork =========================='

/** The closing banner, without indentation. */
export const REGION_END = '// ===================== end generated ==================================='

/** The region lives inside `factory(require) {`, four spaces in. */
const INDENT = '    '

/**
 * The comment block that introduces the region.
 *
 * Kept here rather than in client.js because the region is output: everything
 * between the banners is rebuilt from the artwork list, so text typed into it by
 * hand is lost on the next run. Putting the prose where the code that owns it
 * lives is the only way that stays true.
 */
const PROSE = [
  'Everything down to the closing banner is written by',
  'tools/embed-asset.mjs. Do not hand-edit it: the tool rebuilds this whole',
  'region, so anything typed in here is lost on the next run.',
  '',
  '  node tools/embed-asset.mjs              rebuild from every PNG in asset/',
  '  node tools/embed-asset.mjs a.png b.png  rebuild from exactly those',
  '  node tools/embed-asset.mjs --clear      empty it again',
  '',
  'Each entry is one built-in style, and each carries its own geometry. The',
  "artwork's edge is that style's ceiling -- past it you would be upscaling --",
  'and half the edge is its recommended size, because the raster is a 2x one.',
  'Keeping the numbers next to the pixels is what lets styles of different',
  'sizes coexist; there is no single answer to "how big should the icon be".',
  '',
  '  ARTWORKS      the styles, in the order the picker shows them',
  '  FALLBACK_ART  the id shown before anything is chosen',
  '',
  '`mime` says how the payload becomes a data URI. A PNG and an SVG are both',
  'opaque base64 blobs at this point, so the type has to travel with them.',
  '',
  'An empty list is a state, not a fault: `--clear` produces it deliberately, to',
  'build a tree with no artwork in it. See the guard at the top of apply().',
  '',
  'MIN_SIZE is deliberately outside this region: 14px is the host\'s own',
  'footprint, a fact about the app rather than about any artwork, so changing',
  'the styles must not move it.',
]

/**
 * Build the whole region, banners included, from an artwork list.
 *
 * @param spec - the styles and which one starts selected.
 * @param spec.artworks - `{ id, edge, defaultSize, art }`, in picker order.
 * @param spec.fallback - the id to select initially; `''` for an empty list.
 * @returns the region's text, ending in a newline.
 */
export function renderRegion({ artworks, fallback }) {
  const entries = artworks.map(artwork =>
    `${INDENT}  { id: '${artwork.id}', mime: '${artwork.mime}', edge: ${artwork.edge}, `
    + `defaultSize: ${artwork.defaultSize}, art: '${artwork.art}' },`)

  const list = entries.length === 0
    // The empty case gets the one-line spelling rather than an empty pair of
    // brackets on separate lines: it is the state a reader is most likely to
    // meet without context, and it should look deliberate.
    ? [`${INDENT}const ARTWORKS = []`]
    : [`${INDENT}const ARTWORKS = [`, ...entries, `${INDENT}]`]

  return [
    `${INDENT}${REGION_START}`,
    ...PROSE.map(line => (line === '' ? `${INDENT}//` : `${INDENT}// ${line}`)),
    ...list,
    `${INDENT}const FALLBACK_ART = '${fallback}'`,
    `${INDENT}${REGION_END}`,
    // Trailing element so the join leaves a newline after the closing banner:
    // the range swallows the old banner line's newline, so the body has to
    // supply it.
    '',
  ].join('\n')
}

/**
 * Locate the region in the module source.
 *
 * The range starts at the beginning of the banner's line rather than at the
 * banner's first character, because the body carries its own indentation.
 * Anchoring on the `//` instead leaves the old indent in the prefix and adds a
 * second copy from the body — four bytes per run, invisible in a diff and
 * obvious only when two runs disagree.
 *
 * @param source - the whole of client.js.
 * @returns the half-open `[start, end)` character range.
 */
export function regionRange(source) {
  const bannerStart = source.indexOf(REGION_START)
  const bannerEnd = source.indexOf(REGION_END)
  if (bannerStart < 0 || bannerEnd < 0) {
    throw new Error('client.js has no generated region: expected both the '
      + '"generated: the artwork" and "end generated" banners')
  }
  if (bannerEnd < bannerStart) {
    throw new Error('client.js has its generated-region banners in the wrong order')
  }

  const start = source.lastIndexOf('\n', bannerStart) + 1
  // Swallow the banner line's own newline too, so the body is the only thing
  // that decides what follows the closing banner.
  const endOfLine = source.indexOf('\n', bannerEnd)
  return { start, end: endOfLine < 0 ? source.length : endOfLine + 1 }
}

/** One entry, as rendered above. Ids and base64 never contain a quote. */
const ENTRY
  = /\{ id: '([^']+)', mime: '([^']+)', edge: (\d+), defaultSize: (\d+), art: '([^']*)' \}/g

/**
 * Read the region back out of a source text.
 *
 * @param source - the whole of client.js.
 * @returns `{ artworks, fallback, start, end }`, where each artwork is
 *   `{ id, edge, defaultSize, art, chars }` and `chars` is the base64 length —
 *   the number that decides whether inlining it is reasonable, so every caller
 *   that reports on an artwork wants it.
 */
export function parseRegion(source) {
  const { start, end } = regionRange(source)
  const body = source.slice(start, end)

  const artworks = []
  for (const match of body.matchAll(ENTRY)) {
    artworks.push({
      id: match[1],
      mime: match[2],
      edge: Number(match[3]),
      defaultSize: Number(match[4]),
      art: match[5],
      chars: match[5].length,
    })
  }

  const fallback = body.match(/const FALLBACK_ART = '([^']*)'/)?.[1] ?? ''
  return { artworks, fallback, start, end }
}

/**
 * The style a fresh install would show: the declared fallback, or the first
 * entry when that id is not in the list.
 *
 * Checkers and previews all need "the one that is on by default", and it is
 * never simply `artworks[0]`: the fallback is declared separately precisely so
 * the list order can change without changing what people see first.
 *
 * @param region - a {@link parseRegion} result.
 * @returns the artwork, or `undefined` when the list is empty.
 */
export function fallbackArtwork(region) {
  return region.artworks.find(artwork => artwork.id === region.fallback)
    ?? region.artworks[0]
}

/** The id a file contributes, taken from its name before the `-160x160` part. */
export function idFromFilename(name) {
  const stem = name.replace(/^.*[\\/]/, '').replace(/\.(png|svg)$/i, '')
  const trimmed = stem.replace(/-\d+x\d+.*$/, '')
  return trimmed === '' ? stem : trimmed
}
