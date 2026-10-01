/**
 * Assert that tools/embed-asset.mjs actually refuses what it claims to, and that
 * what it writes is what tools/region.mjs reads.
 *
 * tools/check-plugin.mjs covers the plugin's behaviour; this covers the tool
 * that feeds it. Every guard added for people swapping in their own artwork is
 * only worth having if it fires, and a guard nobody runs rots quietly.
 *
 * The fixtures are built in memory rather than checked in, so there is no pile
 * of tiny PNGs to keep honest, and each one is named for the single thing it
 * exists to trigger. They are metadata-level files: enough chunk structure for
 * tools/png-meta.mjs to describe them, not something a decoder should be handed.
 * Chromium is given the real assets only, by tools/verify-chromium.mjs.
 *
 * client.js is backed up and restored in a `finally`, because the accept cases
 * really do rewrite its region.
 *
 *   node tools/check-embed.mjs
 */
import { execFile } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { regionRange, renderRegion, parseRegion, idFromFilename } from './region.mjs'

const root = new URL('../', import.meta.url)
const fileOf = relative => fileURLToPath(new URL(relative, root))
const runFile = promisify(execFile)

const failures = []
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(detail === undefined ? name : `${name} — ${detail}`)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
const section = name => { console.log(`\n${name}`) }

// --- a minimal PNG writer ---------------------------------------------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buffer) => {
  let c = 0xFFFFFFFF
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const chunk = (type, body) => {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 8 + body.length)
  return out
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

/**
 * Build a palette PNG. `frames > 0` adds an acTL, which is the only thing that
 * makes this project call a file animated.
 * @param spec - geometry, colour type, and the flags under test.
 * @returns the file's bytes.
 */
function palettePng({ width = 96, height = width, bitDepth = 2, colourType = 3, interlace = 0, frames = 0, plays = 0, pad = 0 }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colourType
  ihdr[12] = interlace

  const levels = bitDepth >= 8 ? 256 : 1 << bitDepth
  const palette = Buffer.alloc(levels * 3)
  const alpha = Buffer.alloc(levels)
  for (let i = 0; i < levels; i++) {
    const value = Math.round(i * 255 / (levels - 1))
    palette[i * 3] = palette[i * 3 + 1] = palette[i * 3 + 2] = value
    alpha[i] = value
  }

  // One all-zero scanline per row; nothing here decodes, so the pixels are placeholders.
  const rowBytes = Math.ceil(width * bitDepth / 8)
  const raw = Buffer.alloc((1 + rowBytes) * height)

  const chunks = [SIGNATURE, chunk('IHDR', ihdr)]
  if (frames > 0) {
    const actl = Buffer.alloc(8)
    actl.writeUInt32BE(frames, 0)
    actl.writeUInt32BE(plays, 4)
    chunks.push(chunk('acTL', actl))
    const fctl = Buffer.alloc(26)
    fctl.writeUInt32BE(width, 4)
    fctl.writeUInt32BE(height, 8)
    fctl.writeUInt16BE(100, 20)
    fctl.writeUInt16BE(1000, 22)
    chunks.push(chunk('fcTL', fctl))
  }
  chunks.push(chunk('PLTE', palette), chunk('tRNS', alpha))
  if (pad > 0) chunks.push(chunk('zzzz', Buffer.alloc(pad, 0x5A)))
  chunks.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

// --- harness ----------------------------------------------------------------
const tool = fileOf('tools/embed-asset.mjs')
const clientPath = fileOf('client.js')
const backup = `${clientPath}.check-embed-backup`
const scratch = await mkdtemp(join(tmpdir(), 'spinner-custom-'))

/** Run the tool and fold both streams into one report. */
async function embed(...args) {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [tool, ...args], { cwd: fileOf('.') })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const region = async () => parseRegion(await readFile(clientPath, 'utf8'))

/** Write a fixture and return the absolute path to hand the tool. */
let fixtureCount = 0
async function fixture(name, bytes) {
  const path = join(scratch, `${String(++fixtureCount).padStart(2, '0')}-${name}`)
  await writeFile(path, bytes)
  return path
}

/** The region as it stands right now, live — not a cached copy. */
const startRegion = parseRegion(await readFile(clientPath, 'utf8'))

await copyFile(clientPath, backup)

try {
  // --- 1. refusals ----------------------------------------------------------
  section('refuses an asset it cannot vouch for')
  {
    const cases = [
      ['not-a-png.bin', Buffer.from('this is a shell script, not a PNG\n'), 'neither a PNG nor an SVG'],
      ['still-palette.png', palettePng({}), 'a still image, not an APNG'],
      ['not-square.png', palettePng({ width: 96, height: 128, frames: 90 }), 'is not square'],
      ['depth-8.png', palettePng({ bitDepth: 8, frames: 90 }), 'bit depth 8'],
      ['interlaced.png', palettePng({ interlace: 1, frames: 90 }), 'interlaced'],
      ['truecolour.png', palettePng({ colourType: 2, frames: 90 }), 'colour type 2'],
      ['tiny.png', palettePng({ width: 16, frames: 90 }), 'below the 32px floor'],
      ['huge.png', palettePng({ width: 1024, frames: 90 }), 'above the 512px ceiling'],
      ['oversize.png', palettePng({ frames: 90, pad: 3_000_000 }), 'over the 2,000,000 ceiling'],
    ]

    for (const [name, bytes, reason] of cases) {
      const path = await fixture(name, bytes)
      const result = await embed(path)
      check(`refuses ${name}`, result.code !== 0 && result.out.includes(reason),
        `exit=${result.code} out=${JSON.stringify(result.out.slice(0, 150))}`)
    }

    const missing = await embed(join(scratch, 'no-such-file.png'))
    check('refuses a missing file and lists the folder',
      missing.code !== 0 && missing.out.includes('no such file') && missing.out.includes('asset/'),
      `exit=${missing.code}`)
  }

  // --- 2. warnings that do not block ----------------------------------------
  section('warns without blocking')
  {
    const finite = await fixture('finite-plays.png', palettePng({ frames: 90, plays: 1 }))
    const result = await embed(finite, '--default=48')
    check('accepts a finite-loop asset but says so',
      result.code === 0 && result.out.includes('plays=1'), `exit=${result.code}`)
    check('the finite-loop warning explains the consequence',
      result.out.includes('the animation stops'), result.out.slice(0, 200))
  }

  // --- 3. the geometry follows the file -------------------------------------
  section('the artwork decides the geometry')
  {
    await embed()
    const before = await region()

    const source = await fixture('square-96.png', palettePng({ width: 96, frames: 90 }))
    const id = idFromFilename(source)
    const result = await embed(source)
    check('accepts a square palette APNG', result.code === 0, `exit=${result.code}`)

    const after = await region()
    check('the named file becomes the whole list', after.artworks.length === 1,
      `${after.artworks.length} entries`)
    check('the entry takes the file name as its id', after.artworks[0]?.id === id,
      `${after.artworks[0]?.id} vs ${id}`)
    check('the edge becomes the artwork width', after.artworks[0]?.edge === 96,
      String(after.artworks[0]?.edge))
    check('half the edge becomes the recommended size', after.artworks[0]?.defaultSize === 48,
      String(after.artworks[0]?.defaultSize))
    check('the entry carries the payload', (after.artworks[0]?.art.length ?? 0) > 0)
    check('the only style is the default one', after.fallback === id, after.fallback)
    check('the report names the size it chose',
      result.out.includes('icon 48px of 96'), result.out.slice(0, 400))
    check('replacing a set says so', result.out.includes('replaced the previously embedded set'),
      'the replacement was not announced')
    check('the old set is gone, not appended to',
      !after.artworks.some(artwork => artwork.id === before.fallback),
      after.artworks.map(artwork => artwork.id).join(','))

    const override = await embed(source, '--default=72')
    check('--default= overrides the half-edge rule',
      (await region()).artworks[0]?.defaultSize === 72, override.out.slice(0, 200))

    const illegal = await embed(source, '--default=8')
    check('refuses a default below the host floor',
      illegal.code !== 0 && illegal.out.includes('outside the legal 14..96px range'), `exit=${illegal.code}`)

    const NaNFlag = await embed(source, '--default=nonsense')
    check('refuses a non-numeric default', NaNFlag.code !== 0, `exit=${NaNFlag.code}`)

    const bothFlags = await embed(source, '--default=48', '--id=hero')
    check('accepts --id alongside --default', bothFlags.code === 0, `exit=${bothFlags.code}`)
    check('--id names the style', (await region()).artworks[0]?.id === 'hero',
      (await region()).artworks[0]?.id)

    const noPath = await embed('--id=hero')
    check('refuses --id without exactly one path',
      noPath.code !== 0 && noPath.out.includes('name exactly one path'), `exit=${noPath.code}`)
  }

  // --- 4. several styles at once --------------------------------------------
  section('the list takes every file it is given')
  {
    const one = await fixture('alpha.png', palettePng({ frames: 60 }))
    const two = await fixture('beta.png', palettePng({ frames: 60 }))
    const three = await fixture('gamma.png', palettePng({ frames: 60 }))
    // Derived, not written out: the fixtures carry a counter prefix so a failing
    // case can be told apart from the rest, and hardcoding it here would make
    // these assertions depend on how many cases ran before them.
    const ids = [one, two, three].map(idFromFilename)

    const result = await embed(one, two, three)
    check('accepts several files in one run', result.code === 0, `exit=${result.code}`)

    const written = await region()
    check('the list has one entry per file', written.artworks.length === 3,
      `${written.artworks.length} entries`)
    check('the order is the order given',
      written.artworks.map(artwork => artwork.id).join(',') === ids.join(','),
      `${written.artworks.map(artwork => artwork.id).join(',')} vs ${ids.join(',')}`)
    check('the first entry is the default', written.fallback === ids[0], written.fallback)
    check('the report totals the payloads',
      result.out.includes('total') && result.out.includes('chars of base64'), result.out.slice(-300))

    // Ids land in a JS literal, in the DOM and in localStorage, so they are
    // restricted rather than escaped.
    const awkward = await fixture('Not A Slug.png', palettePng({ frames: 60 }))
    const refused = await embed(awkward)
    check('refuses an id that is not a slug',
      refused.code !== 0 && refused.out.includes('not usable as a style id'), `exit=${refused.code}`)

    const named = await embed(awkward, '--id=ok-slug')
    check('--id rescues an awkward file name', named.code === 0, `exit=${named.code}`)

    const clash = await embed(one, one)
    check('refuses two files that would share an id',
      clash.code !== 0 && clash.out.includes('both become the id'), `exit=${clash.code}`)
  }

  // --- 5. which one starts selected -----------------------------------------
  section('the fallback is named, not positional')
  {
    const one = await fixture('first.png', palettePng({ frames: 60 }))
    const two = await fixture('second.png', palettePng({ frames: 60 }))
    const [first, second] = [one, two].map(idFromFilename)

    await embed(one, two)
    check('the first entry is the default when nothing is said',
      (await region()).fallback === first, (await region()).fallback)

    await embed(one, two, `--fallback=${second}`)
    check('--fallback picks another entry', (await region()).fallback === second,
      (await region()).fallback)

    await embed(one, two)
    check('a fallback that is still in the list survives the rebuild',
      (await region()).fallback === second, (await region()).fallback)

    const unknown = await embed(one, two, '--fallback=nope')
    check('refuses a fallback that is not in the list',
      unknown.code !== 0 && unknown.out.includes('is not one of'), `exit=${unknown.code}`)

    // The other file still carries the chosen fallback, so it stays chosen —
    // this is the case where the position changed, not the selection.
    await embed(two)
    check('a fallback that survives a positional change stays chosen',
      (await region()).fallback === second, (await region()).fallback)

    await embed(one)
    check('a fallback that fell out of the list is replaced by the first entry',
      (await region()).fallback === first, (await region()).fallback)
  }

  // --- 5b. SVG styles --------------------------------------------------------
  section('accepts an animated SVG, and refuses one it cannot vouch for')
  {
    // A spinner built from SMIL: one shape, one rotation, endless by spelling.
    const smil = (body, box = '0 0 24 24') =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${body}</svg>`
    const spin = '<rect width="10" height="10" fill="#000">'
      + '<animateTransform attributeName="transform" type="rotate" from="0 12 12" '
      + 'to="360 12 12" dur="1s" repeatCount="indefinite"/></rect>'

    const good = await fixture('good-spin.svg', Buffer.from(smil(spin)))
    const result = await embed(good)
    check('accepts a square SMIL SVG', result.code === 0,
      `exit=${result.code} out=${result.out.slice(0, 200)}`)
    const written = await region()
    check('the SVG carries its own mime', written.artworks[0]?.mime === 'image/svg+xml',
      written.artworks[0]?.mime)
    check('the recommended size is the authored size', written.artworks[0]?.defaultSize === 24,
      String(written.artworks[0]?.defaultSize))
    check('the ceiling for a vector is the status-row bound',
      written.artworks[0]?.edge === 512, String(written.artworks[0]?.edge))

    const lower = await fixture('lower-viewbox.svg', Buffer.from(smil(spin).replace('viewBox', 'viewbox')))
    const refused = await embed(lower)
    check('refuses a lowercase viewbox — renderers ignore it',
      refused.code !== 0 && refused.out.includes('`viewbox`'), refused.out.slice(0, 260))

    const tall = await fixture('tall-spin.svg', Buffer.from(smil(spin, '0 0 24 40')))
    const square = await embed(tall)
    check('refuses a non-square viewBox',
      square.code !== 0 && square.out.includes('is not square'), square.out.slice(0, 260))

    const stillSvg = await fixture('still-spin.svg', Buffer.from(smil('<rect width="10" height="10"/>')))
    const motionless = await embed(stillSvg)
    check('refuses an SVG with no animation in it',
      motionless.code !== 0 && motionless.out.includes('a still image'), motionless.out.slice(0, 260))

    const scripted = await fixture('scripted-spin.svg', Buffer.from(smil(`${spin}<script>steal()</script>`)))
    const code = await embed(scripted)
    check('refuses an SVG that carries a script',
      code.code !== 0 && code.out.includes('<script>'), code.out.slice(0, 260))

    const phoning = await fixture('phoning-spin.svg',
      Buffer.from(smil(spin.replace('<rect ', '<a href="https://example.test"><rect ').replace('</rect>', '</rect></a>'))))
    const external = await embed(phoning)
    check('refuses an SVG that references the outside',
      external.code !== 0 && external.out.includes('outside the file'), external.out.slice(0, 260))
  }

  // --- 6. the format is one format ------------------------------------------
  section('the writer and the reader agree')
  {
    const source = await readFile(clientPath, 'utf8')
    const { start, end } = regionRange(source)
    const written = source.slice(start, end)
    const round = renderRegion(parseRegion(source))

    check('re-rendering what was parsed reproduces the region byte for byte',
      round === written, 'the reader and the writer disagree about the format')

    const emptied = renderRegion({ artworks: [], fallback: '' })
    check('an empty list renders as a deliberate assignment',
      emptied.includes('const ARTWORKS = []'), emptied.slice(0, 200))
    check('an empty list parses back to nothing',
      parseRegion(`x\n${emptied}`).artworks.length === 0)
  }

  // --- 7. the empty state ---------------------------------------------------
  section('--clear empties the list, and changes its mind as easily')
  {
    await embed()
    const before = await readFile(clientPath, 'utf8')
    const full = await region()

    const cleared = await embed('--clear')
    check('--clear exits 0', cleared.code === 0, `exit=${cleared.code} out=${cleared.out.slice(0, 200)}`)

    const after = await readFile(clientPath, 'utf8')
    check('the payloads are gone', (await region()).artworks.length === 0,
      `${(await region()).artworks.length} survived`)
    check('the module got shorter', after.length < before.length, `${before.length} -> ${after.length}`)
    check('the generated region is still there to be refilled',
      after.includes('generated: the artwork') && after.includes('end generated'))
    check('no fallback is left pointing at nothing', (await region()).fallback === '',
      (await region()).fallback)
    check('MIN_SIZE survives, being a host fact', /const MIN_SIZE = 14/.test(after))
    check('the tool says what the state is for',
      cleared.out.includes('does nothing') && cleared.out.includes('publish'),
      cleared.out.slice(0, 400))

    const again = await embed('--clear')
    check('clearing twice is a no-op, and says so',
      again.code === 0 && again.out.includes('already empty'), `exit=${again.code}`)

    const withPath = await embed('--clear', 'asset/local/x.png')
    check('--clear refuses a path', withPath.code !== 0 && withPath.out.includes('takes no other'),
      `exit=${withPath.code}`)

    const restored = await embed()
    check('the whole set can be inlined again', restored.code === 0, `exit=${restored.code}`)
    const back = await region()
    check('and it is the same set, entry for entry',
      back.artworks.map(artwork => artwork.id).join(',')
      === full.artworks.map(artwork => artwork.id).join(','),
      back.artworks.map(artwork => artwork.id).join(','))
    check('and client.js returns to exactly what it was',
      (await readFile(clientPath, 'utf8')) === before, 'the round trip was not byte-identical')
  }
} finally {
  await copyFile(backup, clientPath)
  await rm(backup, { force: true })
  await rm(scratch, { recursive: true, force: true })
}

// --- 8. idempotency, on the real set ----------------------------------------
section('running it twice changes nothing')
{
  const before = await readFile(clientPath, 'utf8')
  const result = await embed()
  const after = await readFile(clientPath, 'utf8')
  check('the shipped styles leave client.js byte-identical', before === after,
    'the second run rewrote the file')
  check('the run says so rather than implying a write',
    result.out.includes('client.js unchanged'), result.out.slice(-200))
  check('and it still reports the whole set',
    (result.out.match(/chars \(/g) ?? []).length === startRegion.artworks.length,
    result.out.slice(0, 300))
}

console.log()
if (failures.length) {
  console.error(`FAIL (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('PASS')
}
