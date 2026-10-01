/**
 * Validate artwork and inline it into the marked region of client.js.
 *
 * Why inline at all: the browser half cannot import or fetch a sibling file.
 * The host serves plugin bundles over `/plugins` but that route only answers for
 * the entry script and `client.<name>.js` chunks (everything else is a
 * deliberate 404), and `dsh-resource://` addresses are in-page values resolved
 * by React hooks -- the browser never fetches them. So the artwork has to travel
 * as a data URI inside the module source, which is why it is a palette APNG and
 * why this tool refuses a file it cannot vouch for.
 *
 * The list is declared, not accumulated
 * -------------------------------------
 * What ends up in client.js is exactly the files you name, in the order you name
 * them -- or, with no arguments, exactly the PNGs sitting in `asset/`, sorted by
 * name. There is no hidden state to append to and no way to end up with a stale
 * style you forgot about. Rebuilding the whole set is the normal operation and
 * costs nothing when nothing changed, so "the set" stays reproducible from "the
 * folder".
 *
 * The region's format lives in tools/region.mjs, which this tool shares with
 * every reader of it. Each entry carries its own geometry: the edge length and
 * the recommended size are per style, because a 160px raster and a 96px one
 * cannot share a ceiling without one of them being wasted or upscaled.
 * MIN_SIZE is deliberately not part of the region -- it is the host's own
 * footprint, a fact about the app rather than about any artwork.
 *
 *   node tools/embed-asset.mjs                   rebuild from every PNG in asset/
 *   node tools/embed-asset.mjs a.png b.png       rebuild from exactly those
 *   node tools/embed-asset.mjs a.png --id=hero   name it yourself
 *   node tools/embed-asset.mjs a.png --default=56
 *   node tools/embed-asset.mjs --fallback=hero   which one starts selected
 *   node tools/embed-asset.mjs --clear           empty the region again
 *
 * `--clear` exists for publishing: it leaves a tree with no artwork in it, and
 * the plugin handles that state rather than breaking (see the `hasArtwork`
 * guard in client.js). Inlining is idempotent, so re-running costs nothing.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPngMeta, isPng, loopSeconds } from './png-meta.mjs'
import { regionRange, renderRegion, parseRegion, idFromFilename } from './region.mjs'

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const clientPath = fileURLToPath(new URL('client.js', root))
const assetPath = fileURLToPath(new URL('asset', root))

/**
 * Chosen ceilings, not measured cliffs. The module is parsed on every page load
 * and the payloads are its dominant cost.
 *
 * The per-artwork advisory decides whether *one* style is unreasonable -- lower
 * the frame rate, the resolution or the alpha levels. The total is the one that
 * decides whether the *set* is, because that is what the parser and the heap
 * actually see; it is always reported and complained about past the point where
 * the bundle has become the plugin rather than a feature of it.
 */
const BUDGET_WARN = 500_000
const BUDGET_ERROR = 2_000_000
const TOTAL_WARN = 1_000_000

/** Asset edge bounds. Below 32px there is nothing left to sample; past 512px
 *  this has stopped being a status-row icon. Both are judgement calls. */
const MIN_EDGE = 32
const MAX_EDGE = 512

/** Personal artwork lives here and is gitignored. See the warning below. */
const PRIVATE_DIR = 'asset/local'

/**
 * Ids reach the DOM: they are the picker's `aria-label`, they are written into a
 * single-quoted JS literal by renderRegion, and they are keys in localStorage.
 * Restricting them to a lowercase slug keeps all three safe without escaping.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const REBUILD = 'See README "换成你自己的动画": tools/build-spinners.sh generates the '
  + 'bundled styles, tools/build-asset.sh converts a video, and tools/apng-palette.py '
  + 'builds a palette APNG from frames of your own.'

// --- arguments --------------------------------------------------------------
const argv = process.argv.slice(2)
const wantsClear = argv.includes('--clear')
const paths = argv.filter(argument => !argument.startsWith('--'))
const flagValue = name => {
  const flag = argv.find(argument => argument.startsWith(`--${name}=`))
  return flag === undefined ? undefined : flag.slice(name.length + 3)
}

const idFlag = flagValue('id')
const defaultFlag = flagValue('default')
const fallbackFlag = flagValue('fallback')

if (wantsClear && argv.length > 1) {
  throw new Error('--clear takes no other arguments: it empties the region')
}
if ((idFlag !== undefined || defaultFlag !== undefined) && paths.length !== 1) {
  throw new Error('--id and --default describe one artwork, so name exactly one path')
}

const client = await readFile(clientPath, 'utf8')
const { start, end } = regionRange(client)
const previous = parseRegion(client)

/** client.js keeps the host floor outside the region; the slider has to agree. */
const minSize = (() => {
  const match = client.match(/const MIN_SIZE = (\d+)/)
  if (!match) throw new Error('client.js has no `const MIN_SIZE = <number>` literal')
  return Number(match[1])
})()

/** Replace the region and report what happened. */
async function writeRegion({ artworks, fallback }) {
  const next = client.slice(0, start)
    + renderRegion({ artworks, fallback })
    + client.slice(end)
  const changed = next !== client
  if (changed) await writeFile(clientPath, next, 'utf8')
  return { changed, bytes: Buffer.byteLength(next) }
}

// --- the clear path ---------------------------------------------------------
if (wantsClear) {
  const { changed, bytes } = await writeRegion({ artworks: [], fallback: '' })
  if (!changed) {
    console.log('the generated region in client.js is already empty')
    process.exit(0)
  }
  console.log('cleared the generated region in client.js')
  console.log(`  client.js is now ${bytes.toLocaleString()} B`)
  console.log('\nThe plugin now loads and does nothing: with no artwork to mask with it leaves')
  console.log('the host icon alone, and registers no settings row. That is the state to publish')
  console.log('in when the artwork you were developing against is not yours to distribute.')
  process.exit(0)
}

/** What is in `asset/` right now, ignoring the private subdirectory. */
async function publicAssets() {
  const entries = await readdir(assetPath, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .map(entry => `asset/${entry.name}`)
    .sort()
}

// --- resolve the file list --------------------------------------------------
let requested = paths
if (requested.length === 0) {
  requested = await publicAssets()
  if (requested.length === 0) {
    throw new Error('no artwork in asset/ to inline. Pass a path, e.g.\n'
      + '  node tools/embed-asset.mjs asset/your-art.png\n'
      + 'or generate the bundled set:\n  bash tools/build-spinners.sh')
  }
}

// An absolute path has to bypass `new URL(relative, base)`: on Windows `C:/...`
// is read as the scheme `c:`, and the path silently becomes something else. The
// message keeps whatever was typed, so a typo is quoted back as written.
const absolutise = path => (isAbsolute(path) ? path : fileURLToPath(new URL(path, root)))

const warnings = []
const artworks = []

for (const typed of requested) {
  const absolute = absolutise(typed)
  const named = relative(rootPath, absolute).split(sep).join('/')

  /** Fail with the file's name in front, so the message reads as one sentence. */
  const reject = (reason) => { throw new Error(`${typed}: ${reason}`) }

  let png
  try {
    png = await readFile(absolute)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const present = await publicAssets()
    reject(`no such file. In this checkout, asset/ holds:\n  ${present.join('\n  ')}`)
  }

  if (!isPng(png)) reject(`not a PNG (the 8-byte signature is missing). ${REBUILD}`)

  const meta = readPngMeta(png)
  if (meta.colourType !== 3) {
    reject(`colour type ${meta.colourType}, expected 3 (indexed colour). ${REBUILD}`)
  }
  if (meta.bitDepth !== 2 && meta.bitDepth !== 4) {
    reject(`bit depth ${meta.bitDepth}, expected 2 (four alpha levels) or 4 (sixteen). ${REBUILD}`)
  }
  if (meta.interlace !== 0) reject('interlaced. A masked icon must not be: the mask samples one frame.')
  if (meta.frames === undefined) {
    reject('a still image, not an APNG. A still icon is what the host already ships.')
  }
  if (meta.width !== meta.height) {
    reject(`${meta.width}x${meta.height} is not square. The icon box is square and the mask is `
      + 'stretched to fill it (`center / 100% 100%`), so non-square art would be distorted.')
  }
  if (meta.width < MIN_EDGE) reject(`${meta.width}px is below the ${MIN_EDGE}px floor.`)
  if (meta.width > MAX_EDGE) reject(`${meta.width}px is above the ${MAX_EDGE}px ceiling.`)

  const art = png.toString('base64')
  if (art.length > BUDGET_ERROR) {
    reject(`inlines to ${art.length.toLocaleString()} chars of base64, over the `
      + `${BUDGET_ERROR.toLocaleString()} ceiling. Lower the frame rate, the resolution, `
      + 'or the alpha levels.')
  }
  if (art.length > BUDGET_WARN) {
    warnings.push(`${typed}: ${art.length.toLocaleString()} chars of base64 is past the `
      + `${BUDGET_WARN.toLocaleString()} advisory; the module is parsed on every page load.`)
  }
  if (meta.frames < 2) warnings.push(`${typed}: ${meta.frames} frame, i.e. a still image.`)
  if (meta.plays !== 0) {
    warnings.push(`${typed}: plays=${meta.plays}, so the animation stops. The running indicator `
      + 'is on screen for as long as the task runs, so a finite loop will visibly end.')
  }

  // --- publication guard ----------------------------------------------------
  // Inlining copies the bytes into client.js, and a .gitignore cannot hide a
  // copy that lives inside a tracked file. This is the one mistake that is
  // silent and expensive, so it is said out loud every time.
  if (named === PRIVATE_DIR || named.startsWith(`${PRIVATE_DIR}/`)) {
    warnings.push(`${typed} is in ${PRIVATE_DIR}/, which .gitignore excludes -- but inlining `
      + 'copies it into client.js, and THAT copy is not ignored. Before you publish, run\n'
      + '    node tools/embed-asset.mjs --clear\n'
      + '  unless you hold the rights to redistribute this artwork.')
  } else if (!named.startsWith('asset/')) {
    warnings.push(`${typed} is outside asset/, so nothing keeps it out of the repository except `
      + 'you. The inlined copy in client.js is what ships.')
  }

  const id = idFlag ?? idFromFilename(typed)
  if (!ID_PATTERN.test(id)) {
    reject(`"${id}" is not usable as a style id. Use lowercase letters, digits and dashes, `
      + 'or name it yourself with --id=.')
  }

  const defaultSize = defaultFlag === undefined ? Math.round(meta.width / 2) : Number(defaultFlag)
  if (!Number.isFinite(defaultSize)) reject(`--default=${defaultFlag} is not a number.`)
  if (defaultSize < minSize || defaultSize > meta.width) {
    reject(`--default=${defaultSize} is outside the legal ${minSize}..${meta.width}px range.`)
  }

  artworks.push({
    id,
    edge: meta.width,
    defaultSize,
    art,
    typed,
    png,
    meta,
    loop: loopSeconds(meta),
  })
}

// --- ids are unique, and the fallback has to exist ---------------------------
const seen = new Map()
for (const artwork of artworks) {
  const clash = seen.get(artwork.id)
  if (clash !== undefined) {
    throw new Error(`${artwork.typed} and ${clash} both become the id "${artwork.id}". `
      + 'Rename one, or name them with --id=.')
  }
  seen.set(artwork.id, artwork.typed)
}

const known = new Set(artworks.map(artwork => artwork.id))
const fallback = fallbackFlag ?? (known.has(previous.fallback) ? previous.fallback : artworks[0].id)
if (!known.has(fallback)) {
  throw new Error(`--fallback=${fallback} is not one of ${[...known].join(', ')}`)
}

const wasEmbedded = previous.artworks.length > 0
const { changed, bytes } = await writeRegion({ artworks, fallback })
if (changed && wasEmbedded) warnings.push('replaced the previously embedded set')

// --- report -----------------------------------------------------------------
const total = artworks.reduce((sum, artwork) => sum + artwork.art.length, 0)

console.log(`embedded ${artworks.length} style(s)`)
for (const artwork of artworks) {
  const { meta } = artwork
  const marks = [
    artwork.id === fallback ? 'default' : '',
    `${meta.width}x${meta.height}`,
    `${meta.bitDepth}bpp`,
    `${meta.frames} frames`,
    artwork.loop === undefined ? 'no timing' : `${artwork.loop.toFixed(2)}s`,
    `plays=${meta.plays}`,
  ].filter(Boolean)
  console.log(`  ${artwork.id.padEnd(12)} ${marks.join(', ')}`)
  console.log(`  ${' '.repeat(12)} ${artwork.png.byteLength.toLocaleString()} B -> `
    + `${artwork.art.length.toLocaleString()} chars `
    + `(${(artwork.art.length / BUDGET_WARN * 100).toFixed(0)}% of the advisory), `
    + `icon ${artwork.defaultSize}px of ${meta.width}`)
}
console.log(`  ${'total'.padEnd(12)} ${total.toLocaleString()} chars of base64`
  + (total > TOTAL_WARN ? ` -- past the ${TOTAL_WARN.toLocaleString()} advisory` : ''))

for (const warning of warnings) console.warn(`warning: ${warning}`)

if (changed) {
  console.log(`  client.js is now ${bytes.toLocaleString()} B`)
} else {
  console.log('  client.js unchanged: these are already the embedded styles')
}
