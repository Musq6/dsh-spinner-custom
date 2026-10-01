/**
 * Assert what client.js actually does.
 *
 * The browser half cannot be exercised through the running app from here, so
 * this harness supplies the smallest environment the module contract promises
 * (see tools/harness.mjs for what is stubbed and why) and then makes claims about
 * observable behaviour rather than about source text:
 *
 *   - the effect graph: one locale dictionary, one applier, one settings row;
 *   - the icon override reacts to the settings store (two custom properties);
 *   - the payload the sheet carries travels once and is referenced twice,
 *     never duplicated;
 *   - the sheet carries no animation, because the artwork is a fixed clip;
 *   - the size range, readout and reset all follow the *selected* style, and
 *     switching styles re-ranges them;
 *   - the value domain holds against hostile input, including a poisoned
 *     localStorage entry;
 *   - an emptied generated region makes the plugin stand down cleanly rather
 *     than half-register;
 *   - disposal leaves no stylesheet, no custom property and no hook behind.
 *
 * Every number asserted here is read back out of client.js — the region is
 * parsed with the same module that wrote it, and MIN_SIZE is read as a literal.
 * A hardcoded 160/80 would turn these into a test of a remembered build, and
 * would start failing for the wrong reason the moment somebody swapped a style.
 *
 *   node tools/check-plugin.mjs
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bootClient, openSlot, render } from './harness.mjs'
import { regionRange, renderRegion, parseRegion, fallbackArtwork } from './region.mjs'

const CLIENT = await readFile(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

const MIN_SIZE = (() => {
  const match = CLIENT.match(/const MIN_SIZE = (\d+)/)
  if (!match) throw new Error('client.js has no `const MIN_SIZE = <number>` literal')
  return Number(match[1])
})()

const region = parseRegion(CLIENT)
const FALLBACK = fallbackArtwork(region)
if (FALLBACK === undefined) {
  throw new Error('client.js has no styles inlined; run tools/embed-asset.mjs first')
}

/** Rewrite the generated region, to build states the shipped file is not in. */
const withRegion = (source, spec) => {
  const { start, end } = regionRange(source)
  return source.slice(0, start) + renderRegion(spec) + source.slice(end)
}

/** Just the region, emptied — the state `--clear` produces. */
const CLEARED = withRegion(CLIENT, { artworks: [], fallback: '' })

/**
 * Two styles of *different* edges. The shipped set is all 160px, so without
 * this the whole point of per-style geometry — that the range follows the
 * selection — would go untested. The payloads are placeholders: nothing here
 * decodes them, and the plugin never inspects what it inlines.
 */
const MIXED = withRegion(CLIENT, {
  artworks: [
    { id: 'big', edge: 160, defaultSize: 80, art: 'AAAA' },
    { id: 'small', edge: 64, defaultSize: 32, art: 'BBBB' },
  ],
  fallback: 'big',
})

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

const boot = options => bootClient(options)

/** Every key the row asks `t` for, so a missing entry is caught here. */
const COPY_KEYS = ['title', 'description', 'style', 'size', 'reset', 'hint']

/** A size that is legal for a style and off its recommendation. */
const movedSize = artwork =>
  artwork.defaultSize + Math.max(1, Math.round((artwork.edge - artwork.defaultSize) / 2))

const SETTINGS_KEY = 'dsh.spinner-custom.settings.v1'

// --- 1. the effect graph ----------------------------------------------------
section('bundle shape')
{
  const env = await boot()
  check('module id is the package name', env.registration.id === '@local/spinner-custom', env.registration.id)
  check('inject asks for slots and locale',
    env.mod.inject.join(',') === 'slots,locale', env.mod.inject.join(','))

  env.mod.apply(env.ctx)

  check('exactly one locale dictionary is registered', env.dictionaries.length === 1,
    `${env.dictionaries.length} registered`)
  check('dictionary namespace is settings.spinnerCustom',
    env.dictionaries[0]?.ns === 'settings.spinnerCustom', env.dictionaries[0]?.ns)
  check('dictionary ships zh and en', Object.keys(env.dictionaries[0]?.dicts ?? {}).join(',') === 'zh,en')
  check('every key the row asks for exists in both dictionaries', (() => {
    const dicts = env.dictionaries[0].dicts
    return COPY_KEYS.every(key => dicts.zh[key] !== undefined && dicts.en[key] !== undefined)
  })(), 'a copy key is missing from a dictionary')
  check('the dictionary carries no leftover preset copy', (() => {
    const keys = Object.keys(env.dictionaries[0].dicts.zh)
    return !keys.some(key => key === 'mode' || key.startsWith('mode.'))
  })(), 'a mode key survived in the dictionary')

  check('exactly one stylesheet is injected', env.styles.length === 1, `${env.styles.length} injected`)
  check('the sheet carries the owner marker',
    env.styles.every(tag => tag.dataset.spinnerCustom === '@local/spinner-custom'))
  check('the sheet has no role marker, one sheet being all there is',
    env.styles[0].dataset.spinnerCustomRole === undefined, env.styles[0].dataset.spinnerCustomRole)
  check('one slot wait is installed', env.waits.length === 1, `${env.waits.length} waits`)
  check('the wait targets settings.general.item',
    env.waits[0]?.key === 'settings.general.item', env.waits[0]?.key)
}

// --- 2. the icon override ---------------------------------------------------
section('icon override')
{
  const env = await boot()
  env.mod.apply(env.ctx)
  const sheet = env.styles[0]
  const text = sheet.textContent
  const property = name => env.documentStub.documentElement.style.getPropertyValue(name)

  check('the default edge reaches the document',
    property('--spinner-custom-size') === `${FALLBACK.defaultSize}px`,
    property('--spinner-custom-size'))
  check('the selected style reaches the document as a mask',
    property('--sc-mask') === `url("data:${FALLBACK.mime};base64,${FALLBACK.art}")`,
    property('--sc-mask').slice(0, 60))
  check('the override is gated on motion and forced colours',
    text.includes('@media (prefers-reduced-motion: no-preference) and (forced-colors: none)'))
  check('the mask is swapped with mask-mode alpha',
    text.includes('mask-mode: alpha') && text.includes('var(--sc-mask)'))
  check('the size custom property is read with the default as fallback',
    text.includes(`var(--spinner-custom-size, ${FALLBACK.defaultSize}px)`))
  check('the sheet carries exactly one payload, the fallback',
    (text.match(/base64,/g) ?? []).length === 1,
    `${(text.match(/base64,/g) ?? []).length} occurrences`)
  check('the payload is referenced, never rewritten',
    (text.match(/var\(--sc-mask\)/g) ?? []).length === 4,
    `${(text.match(/var\(--sc-mask\)/g) ?? []).length} references (two rules x the -webkit- pair)`)
  check('the picker tiles keep their payloads out of the sheet',
    text.includes('var(--sc-art)') && !text.includes('--sc-art:'),
    'a tile payload leaked into the stylesheet')
  check('the fallback is declared on :root',
    /:root\s*\{[^}]*--sc-mask:\s*url\("data:image\/png;base64,/.test(text))

  // The plugin's contract is that the sheet carries no motion at all: the
  // animation lives in the APNG, so any @keyframes or animation declaration here
  // means a second, competing source of timing crept in. These three also keep
  // the CSS out of "we reinvented the artwork in CSS" territory.
  check('the sheet carries no keyframes', !text.includes('@keyframes'),
    'an animation survived into the sheet')
  check('the sheet carries no animation shorthand', !/(^|[;\s])animation:/.test(text),
    'an animation declaration survived into the sheet')
  check('the sheet carries no procedural SVG mask', !text.includes('data:image/svg+xml,'))
  check('no injected sheet carries a stray backtick', !text.includes('`'),
    'a backtick survived into an injected sheet')
}

// --- 3. live reactions ------------------------------------------------------
section('live reactions')
{
  const env = await boot()
  env.mod.apply(env.ctx)
  const slot = openSlot(env)
  const property = name => env.documentStub.documentElement.style.getPropertyValue(name)
  const stored = () => JSON.parse(env.storage.get(SETTINGS_KEY))

  check('row registration uses the plugin-own id',
    slot.options.id === 'spinner-custom' && slot.options.name === 'settings.general.item', slot.options.id)
  check('row order is 40', slot.options.order === 40, String(slot.options.order))
  check('row declares its own dictionary', slot.options.locale === 'settings.spinnerCustom', slot.options.locale)
  check('the face injects exactly one hook',
    Object.keys(slot.face.hooks).join(',') === 'spinnerCustomSettings',
    Object.keys(slot.face.hooks).join(','))

  const wanted = movedSize(FALLBACK)
  slot.face.setSpinnerCustomSize(wanted)
  check('a size write reaches the document', property('--spinner-custom-size') === `${wanted}px`,
    property('--spinner-custom-size'))
  check('a size write persists', stored().size === wanted, JSON.stringify(stored()))
  check('a size write leaves the style alone', stored().art === FALLBACK.id, JSON.stringify(stored()))

  const other = region.artworks.find(artwork => artwork.id !== FALLBACK.id)
  slot.face.setSpinnerCustomArt(other.id)
  check('a style write reaches the document',
    property('--sc-mask') === `url("data:${other.mime};base64,${other.art}")`,
    property('--sc-mask').slice(0, 60))
  check('a style write persists', stored().art === other.id, JSON.stringify(stored()))
  check('a style write keeps the size the user chose', stored().size === wanted, JSON.stringify(stored()))

  slot.face.resetSpinnerCustomSize()
  check('reset clears the override rather than pinning a number', stored().size === null,
    JSON.stringify(stored()))
  check('reset lands on the style-own recommendation',
    property('--spinner-custom-size') === `${other.defaultSize}px`, property('--spinner-custom-size'))

  const hook = env.sandbox.window.__spinnerCustom
  const state = hook.state()
  check('the console hook reports the style, the stored size and the shown one',
    state.art === other.id && state.size === null && state.px === other.defaultSize,
    JSON.stringify(state))
  check('the console hook clamps through the same door',
    hook.size(9999) === other.edge, String(hook.size(9999)))
  hook.reset()
  check('the console hook can restore the recommendation', hook.state().px === other.defaultSize,
    JSON.stringify(hook.state()))
  check('the console hook can pick a style by id', hook.style(FALLBACK.id) === FALLBACK.id)
  check('the console hook rejects a style it does not have',
    hook.style('no-such-style') === FALLBACK.id, hook.style('no-such-style'))
  // size() with no argument is documented as a read, not a write. That matters:
  // an earlier shape of this hook treated a missing argument as an illegal value
  // and reset the size, so the read/write distinction here is load-bearing.
  const beforeRead = hook.state()
  check('the console hook size() with no argument reads without writing',
    hook.size() === beforeRead.px && hook.state().size === beforeRead.size,
    JSON.stringify(hook.state()))
}

// --- 4. the value domain ----------------------------------------------------
section('value domain')
{
  const env = await boot()
  env.mod.apply(env.ctx)
  const slot = openSlot(env)
  const read = () => Number(
    env.documentStub.documentElement.style.getPropertyValue('--spinner-custom-size').replace('px', ''))

  slot.face.setSpinnerCustomSize(1000)
  check(`above the ceiling clamps to ${FALLBACK.edge}`, read() === FALLBACK.edge, String(read()))
  slot.face.setSpinnerCustomSize(-4)
  check(`below the floor clamps to ${MIN_SIZE}`, read() === MIN_SIZE, String(read()))
  slot.face.setSpinnerCustomSize('not a number')
  check('garbage falls back to the recommendation', read() === FALLBACK.defaultSize, String(read()))
  // A fraction just above the floor, so the rounding case is in range whatever
  // the styles happen to be.
  slot.face.setSpinnerCustomSize(MIN_SIZE + 0.6)
  check('fractions round to whole px', read() === MIN_SIZE + 1, String(read()))
  slot.face.setSpinnerCustomSize(null)
  check('null falls back to the recommendation', read() === FALLBACK.defaultSize, String(read()))
  slot.face.setSpinnerCustomSize('')
  check('an empty string falls back to the recommendation', read() === FALLBACK.defaultSize, String(read()))
}

// --- 5. rehydration ---------------------------------------------------------
section('rehydration')
{
  const shown = env => Number(
    env.documentStub.documentElement.style.getPropertyValue('--spinner-custom-size').replace('px', ''))
  const masked = env => env.documentStub.documentElement.style.getPropertyValue('--sc-mask')

  const other = region.artworks.find(artwork => artwork.id !== FALLBACK.id)
  const wanted = movedSize(other)

  const good = await boot({ stored: { [SETTINGS_KEY]: JSON.stringify({ art: other.id, size: wanted }) } })
  good.mod.apply(good.ctx)
  check('a stored style and size are applied on boot',
    shown(good) === wanted && masked(good).includes(other.art),
    `${shown(good)} ${masked(good).slice(0, 40)}`)

  // An id that is not in this build — a style that was removed, or a hand-edit.
  const alien = await boot({
    stored: { [SETTINGS_KEY]: JSON.stringify({ art: 'no-such-style', size: wanted }) },
  })
  alien.mod.apply(alien.ctx)
  check('a style that is not in this build heals to the default',
    masked(alien).includes(FALLBACK.art), masked(alien).slice(0, 40))
  check('the healed style is written back',
    JSON.parse(alien.storage.get(SETTINGS_KEY)).art === FALLBACK.id, alien.storage.get(SETTINGS_KEY))

  const bad = await boot({ stored: { [SETTINGS_KEY]: '{"oops":1}' } })
  bad.mod.apply(bad.ctx)
  check('a poisoned entry heals to the default',
    shown(bad) === FALLBACK.defaultSize && masked(bad).includes(FALLBACK.art),
    `${shown(bad)} ${masked(bad).slice(0, 40)}`)
  check('the healed value is written back',
    JSON.parse(bad.storage.get(SETTINGS_KEY)).art === FALLBACK.id, bad.storage.get(SETTINGS_KEY))

  // A stored JSON `null` is the case that used to clamp to the floor: Number(null)
  // is 0, so a hand-edited entry read as "the smallest icon" instead of "unset".
  const nulled = await boot({ stored: { [SETTINGS_KEY]: 'null' } })
  nulled.mod.apply(nulled.ctx)
  check('a stored null heals to the default, not to the floor',
    shown(nulled) === FALLBACK.defaultSize, String(shown(nulled)))

  // The previous release stored a bare number under a different key. Reading it
  // as "no size chosen" is the honest degradation: the size it named may not
  // even be legal for the style that is now selected.
  const legacy = await boot({ stored: { [SETTINGS_KEY]: String(MIN_SIZE) } })
  legacy.mod.apply(legacy.ctx)
  check('a bare number from an older shape is treated as unset',
    shown(legacy) === FALLBACK.defaultSize, String(shown(legacy)))
}

// --- 6. per-style geometry --------------------------------------------------
section('the range follows the selected style')
{
  const env = await boot({ source: MIXED })
  env.mod.apply(env.ctx)
  const shown = () => Number(
    env.documentStub.documentElement.style.getPropertyValue('--spinner-custom-size').replace('px', ''))

  check('the bigger style starts at its own recommendation', shown() === 80, String(shown()))

  const row = () => openSlot(env)
  const big = row()
  const withBig = render(big.component(big.props))
  check('the range ceiling is the selected style edge', /max="160"/.test(withBig),
    'the range is not the style edge')

  // A size that is perfectly legal for the 160px style...
  big.face.setSpinnerCustomSize(140)
  check('a legal size for the big style is kept', shown() === 140, String(shown()))

  // ...must not survive as-is into a style whose raster is 64px.
  big.face.setSpinnerCustomArt('small')
  check('switching to a smaller style clamps the size to its edge', shown() === 64, String(shown()))
  check('the stored size is left alone, so switching back restores it',
    JSON.parse(env.storage.get(SETTINGS_KEY)).size === 140,
    env.storage.get(SETTINGS_KEY))

  const small = row()
  const withSmall = render(small.component(small.props))
  check('the range ceiling follows the smaller style', /max="64"/.test(withSmall),
    'the range kept the old ceiling')

  small.face.resetSpinnerCustomSize()
  check('reset lands on the smaller style-own recommendation', shown() === 32, String(shown()))
  small.face.setSpinnerCustomArt('big')
  check('with no size stored, each style shows its own default', shown() === 80, String(shown()))
}

// --- 7. the row itself ------------------------------------------------------
section('settings row')
{
  const env = await boot()
  env.mod.apply(env.ctx)
  const slot = openSlot(env)
  const html = slot.html
  const has = (needle, label) => check(label, html.includes(needle), `expected ${needle} in the row`)

  has('class="sc-row"', 'the row root is mounted with its own class')
  has('data-spinner-custom-row="spinner-custom"', 'the row carries its owner marker')
  has('role="radiogroup"', 'the style picker is a radiogroup')
  has('type="range"', 'the size control is a range input')
  has(`min="${MIN_SIZE}"`, 'the range floor is the native footprint')
  has(`max="${FALLBACK.edge}"`, 'the range ceiling is the default style edge')
  has('step="1"', 'the range steps one pixel')
  has(`value="${FALLBACK.defaultSize}"`, 'the range starts at the recommendation')
  has('aria-label="style"', 'the picker carries an accessible name')
  has('aria-label="size"', 'the range carries an accessible name')
  has(`>${FALLBACK.defaultSize} px<`, 'the numeric readout shows the current size')
  has('class="sc-stage" aria-hidden="true"', 'the preview is decorative, not a second control')

  const tiles = html.split('<button').filter(chunk => chunk.includes('class="sc-tile"'))
  check('every style gets a tile', tiles.length === region.artworks.length,
    `${tiles.length} tiles for ${region.artworks.length} styles`)
  const checked = tiles.filter(chunk => chunk.includes('aria-checked="true"'))
  check('exactly one tile is marked as chosen', checked.length === 1, `${checked.length} checked`)
  check('the chosen tile is the fallback style',
    checked[0]?.includes(`aria-label="${FALLBACK.id}"`) ?? false, checked[0]?.slice(0, 140))
  check('every tile carries its style id as a name',
    tiles.every(chunk => chunk.includes('aria-label="')), 'a tile is missing its name')
  check('every tile carries its own payload',
    tiles.every(chunk => chunk.includes('--sc-art')), 'a tile is missing its payload')

  check('the row offers no tab strip, the picker being a radiogroup',
    !html.includes('role="tab"') && !html.includes('tablist'), 'a tablist survived in the row')
  const cells = (html.match(/class="sc-cell"/g) ?? []).length
  check('exactly one preview cell is mounted', cells === 1, `${cells} cells`)
  check('no panel is hidden, there being one set of styles', !html.includes('hidden=""'),
    'a hidden panel survived in the row')
  check('reset is disabled at the recommendation', /class="sc-reset"[^>]*disabled=""/.test(html),
    `reset is enabled at ${FALLBACK.defaultSize}px`)

  const wanted = movedSize(FALLBACK)
  const moved = openSlot(env)
  moved.face.setSpinnerCustomSize(wanted)
  const after = render(moved.component(moved.props))
  check('the readout follows a size write', after.includes(`>${wanted} px<`), 'the readout did not move')
  check('the reset button wakes up once moved', !/class="sc-reset"[^>]*disabled/.test(after),
    'reset stayed disabled')
  check('the preview cell follows the size write',
    after.includes(`width: ${wanted}px; height: ${wanted}px`), 'the cell kept its old size')

  const other = region.artworks.find(artwork => artwork.id !== FALLBACK.id)
  const swapped = openSlot(env)
  swapped.face.setSpinnerCustomArt(other.id)
  const reselected = render(swapped.component(swapped.props))
  const nowChecked = reselected.split('<button')
    .filter(chunk => chunk.includes('class="sc-tile"') && chunk.includes('aria-checked="true"'))
  check('the tick follows a style write',
    nowChecked.length === 1 && nowChecked[0].includes(`aria-label="${other.id}"`),
    nowChecked[0]?.slice(0, 140))
}

// --- 8. the emptied region --------------------------------------------------
section('with no artwork inlined')
{
  // `--clear` is a documented state and the one to publish in, so the plugin has
  // to stand down rather than half-register: no sheet, no row, no property, and
  // one line saying why. Exercised through the real module text with the list
  // emptied — not through a second implementation of the guard, which would
  // prove nothing about the one that ships.
  const logged = []
  const realInfo = console.info
  console.info = (...args) => { logged.push(args.join(' ')) }
  let env
  try {
    env = await boot({ source: CLEARED })
    env.mod.apply(env.ctx)
  } finally {
    console.info = realInfo
  }

  check('the module still loads and applies without throwing', env !== undefined)
  check('no locale dictionary is registered', env.dictionaries.length === 0,
    `${env.dictionaries.length} registered`)
  check('no stylesheet is injected', env.styles.length === 0, `${env.styles.length} injected`)
  check('no slot wait is installed', env.waits.length === 0, `${env.waits.length} waits`)
  check('no effect is installed', env.effects.length === 0, `${env.effects.length} effects`)
  check('neither custom property is written',
    env.documentStub.documentElement.style.getPropertyValue('--spinner-custom-size') === ''
    && env.documentStub.documentElement.style.getPropertyValue('--sc-mask') === '',
    'a custom property was written with no artwork to mask with')
  check('the console hook is not published', env.sandbox.window.__spinnerCustom === undefined,
    'window.__spinnerCustom was published with no artwork to mask with')
  check('it says why, exactly once',
    logged.length === 1 && logged[0].includes('no artwork embedded')
    && logged[0].includes('embed-asset.mjs'),
    JSON.stringify(logged))
}

// --- 9. disposal ------------------------------------------------------------
section('disposal')
{
  const env = await boot()
  env.mod.apply(env.ctx)
  const applier = env.effects.find(effect => effect.label?.includes('override'))
  check('the applier is one labelled effect', applier !== undefined,
    env.effects.map(effect => effect.label).join(' | '))
  applier.dispose()
  check('the sheet is removed', env.styles.every(tag => tag.removed === true),
    env.styles.map(tag => String(tag.removed)).join(','))
  check('both custom properties are released',
    env.documentStub.documentElement.style.getPropertyValue('--spinner-custom-size') === ''
    && env.documentStub.documentElement.style.getPropertyValue('--sc-mask') === '',
    'a custom property survived disposal')
  check('the console hook is withdrawn',
    env.sandbox.window.__spinnerCustom === undefined, 'window.__spinnerCustom survived disposal')
}

console.log()
if (failures.length) {
  console.error(`FAIL (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('PASS')
}
