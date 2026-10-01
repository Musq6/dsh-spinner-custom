/**
 * Verify the inlined APNG with Chromium's own image pipeline, and optionally
 * capture screenshots of a page.
 *
 * The container is easy to validate from the outside (ffmpeg decodes it, the
 * chunk walk in tools/png-meta.mjs reads it), but the delivered artefact is
 * whatever Chromium does with it. WebCodecs `ImageDecoder` is Chromium's own
 * decoder, so asking it for the frame count, the repetition count and a few
 * decoded frames answers the real question: will the browser animate this 2bpp
 * palette APNG, and are the frames genuinely different?
 *
 * Every number asserted here comes from a file, never from this tool:
 *
 *   - the asset's own IHDR/acTL (via png-meta.mjs) supplies the frame count,
 *     the pixel size and whether the loop is finite;
 *   - client.js supplies MIN_SIZE / MAX_SIZE / DEFAULT_SIZE and the embedded
 *     payload, so the page's behaviour is compared against the plugin's own
 *     constants rather than against a remembered screenshot.
 *
 * That is what lets somebody drop in their own artwork and still be told the
 * truth. Whether the loop seam is tidy is deliberately advisory rather than
 * fatal: it is a property of the artwork, and a replacement has every right to
 * cut on the beat.
 *
 * This drives Chrome over the DevTools Protocol rather than `--dump-dom`,
 * because the decode is genuinely asynchronous and a DOM dump fires before it
 * settles. Note `--virtual-time-budget` does not advance APNG playback either,
 * so screenshots are taken after real wall-clock waits.
 *
 *   node tools/verify-chromium.mjs
 *   node tools/verify-chromium.mjs --shot preview.html:out.png --wait 1200
 *   node tools/verify-chromium.mjs asset/my-clip.png --shot preview.html:out.png --probe
 */
import { readFile, writeFile, rm, stat, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readPngMeta, loopSeconds } from './png-meta.mjs'
import { parseRegion, fallbackArtwork } from './region.mjs'

const root = new URL('../', import.meta.url)
const fileOf = relative => fileURLToPath(new URL(relative, root))
const fileUrl = relative => `file:///${fileOf(relative).replace(/\\/g, '/')}`

const argv = process.argv.slice(2)
const shotArg = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : undefined
const waitArg = argv.includes('--wait') ? Number(argv[argv.indexOf('--wait') + 1]) : 1500

// --- the plugin's own numbers, read back out of the built file -----------
// Hardcoding 80/14/160 here would quietly turn this probe into a test of a
// remembered build. Read them the way tools/build-preview.mjs does: MIN_SIZE as
// a literal, and the geometry from the region, parsed with the same module that
// wrote it.
const CLIENT = await readFile(fileOf('client.js'), 'utf8')
const MIN_SIZE = (() => {
  const match = CLIENT.match(/const MIN_SIZE = (\d+)/)
  if (!match) throw new Error('client.js has no `const MIN_SIZE = <number>` literal')
  return Number(match[1])
})()
const region = parseRegion(CLIENT)
const DEFAULT_ARTWORK = fallbackArtwork(region)
if (DEFAULT_ARTWORK === undefined) {
  throw new Error('client.js carries no artwork; run tools/embed-asset.mjs first')
}
// Everything the probe asserts about the page is about the style a fresh
// install shows, so these are the fallback's numbers rather than any global.
const EMBEDDED = DEFAULT_ARTWORK.art
const DEFAULT_SIZE = DEFAULT_ARTWORK.defaultSize
const MAX_SIZE = DEFAULT_ARTWORK.edge

/**
 * Which asset to decode.
 *
 * An explicit `asset/…` argument wins. Otherwise this resolves the file whose
 * bytes are inlined in client.js by matching the payload — deliberately, rather
 * than naming a file. A hardcoded name goes stale the moment somebody swaps the
 * artwork, and this tool would then report the truth about a file the plugin is
 * not actually using, which is worse than reporting nothing.
 *
 * Only the top level of asset/ is searched: `asset/local/` is the gitignored
 * tier, and a payload inlined from there would still be matched by this scan
 * only if the user asked for it by name.
 *
 * @returns a repo-relative path.
 */
async function resolveAsset() {
  // Any bare .png argument wins. Not just `asset/...`: the useful moment to
  // decode a candidate is *before* inlining it, and requiring it to sit in the
  // shipped tier first would mean promoting it to get it checked.
  const explicit = argv.find(a => a.endsWith('.png') && !a.includes(':') && a !== shotArg)
  if (explicit !== undefined) return explicit

  const directory = fileOf('asset')
  const entries = await readdir(directory, { withFileTypes: true })
  const names = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .map(entry => entry.name)
    .sort()
  for (const name of names) {
    if ((await readFile(`${directory}/${name}`)).toString('base64') === EMBEDDED) return `asset/${name}`
  }
  throw new Error('nothing in asset/ matches the payload inlined in client.js. '
    + 'Name the file you meant: node tools/verify-chromium.mjs asset/<file>.png')
}
const assetRel = await resolveAsset()

// Sizes the probe writes by hand, derived so they stay inside the domain and
// stay different from the default whatever the asset's edge turns out to be.
const PROBE_SIZE = Math.max(MIN_SIZE, Math.round(DEFAULT_SIZE * 0.7))
const PROBE_SIZE_2 = Math.min(MAX_SIZE, Math.round(DEFAULT_SIZE * 1.4))
const SLIDER_SIZE = Math.max(MIN_SIZE, Math.round(DEFAULT_SIZE / 2))

// The host's own icon box, read off its stylesheet. The plugin never writes it,
// so it is the thing that has to still win once the plugin is switched off.
const SHIPPED_ICON_PX = 14

// The mask is the payload plus a `url("data:…")` wrapper. The wrapper is a
// fixed handful of characters, so compare with slack far smaller than the gap
// between any two real assets — this still catches a truncated inline, a stale
// payload, or a mask pointing at some other file.
const PAYLOAD_SLACK = 64
/** @param length - a computed maskImage length. */
const carriesThePayload = length => Math.abs(length - EMBEDDED.length) <= PAYLOAD_SLACK

/** Locate a Chromium-family binary without installing anything. */
async function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]
  for (const candidate of candidates) {
    try {
      await stat(candidate)
      return candidate
    } catch {}
  }
  throw new Error('no Chrome or Edge found')
}

/** Minimal CDP client: one page target, request/response by id. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      if (frame.id && this.pending.has(frame.id)) {
        const { resolve, reject } = this.pending.get(frame.id)
        this.pending.delete(frame.id)
        if (frame.error) reject(new Error(`${frame.error.message} (${frame.error.code})`))
        else resolve(frame.result)
      }
    })
  }

  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an expression in the page and return its value by value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
    }
    return result.result.value
  }
}

const profile = fileOf('.verify-profile')
await rm(profile, { recursive: true, force: true })

const chrome = spawn(await findChrome(), [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  // Viewport width decides the page's layout; screenshots capture full height.
  '--window-size=1100,1200',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

let cdp
try {
  // Chrome writes the chosen port once the DevTools endpoint is listening.
  let port
  for (let attempt = 0; attempt < 100 && port === undefined; attempt++) {
    await sleep(100)
    try {
      const text = (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')
      port = Number(text[0]) || undefined
    } catch {}
  }
  if (!port) throw new Error('Chrome never opened a DevTools port')

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find(t => t.type === 'page')
  if (!page) throw new Error('no page target')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
  })
  cdp = new Cdp(socket)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // --- 1. Chromium decodes the animation ------------------------------
  const assetBytes = await readFile(fileOf(assetRel))
  const asset = readPngMeta(assetBytes)
  const loops = loopSeconds(asset)
  if (asset.frames === undefined) {
    throw new Error(`${assetRel} has no acTL chunk, so it is a still PNG rather than an APNG`)
  }
  // Nine samples spread across the clip, whatever its length is — so a 60-frame
  // replacement is judged on its own nine frames rather than on a 90-frame
  // expectation.
  const sampleCount = Math.min(9, asset.frames)
  const sampleIndices = sampleCount < 2
    ? [0]
    : [...new Set(Array.from({ length: sampleCount },
      (_, k) => Math.round(k * (asset.frames - 1) / (sampleCount - 1))))]

  // WebCodecs needs a secure context, and `about:blank` is not one, so park on
  // a real file:// document first (file:// is trustworthy to Chrome).
  const blankRel = '.verify-blank.html'
  await writeFile(fileOf(blankRel), '<!doctype html><meta charset="utf-8"><title>probe</title>', 'utf8')
  await cdp.send('Page.navigate', { url: fileUrl(blankRel) })
  await sleep(400)

  const base64 = assetBytes.toString('base64')
  const probe = `(async () => {
    const out = {};
    try {
      const bin = Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0));
      const dec = new ImageDecoder({ data: bin, type: 'image/png' });
      // The track list is empty until tracks.ready settles; reading
      // selectedTrack before that yields null rather than throwing.
      await dec.tracks.ready;
      await dec.completed;
      const track = dec.tracks.selectedTrack || dec.tracks[0];
      if (!track) throw new Error('decoder reported no image tracks');
      out.animated = track.animated;
      out.frameCount = track.frameCount;
      out.repetitionCount = String(track.repetitionCount);
      out.sampled = [];
      for (const index of ${JSON.stringify(sampleIndices)}) {
        const decoded = await dec.decode({ frameIndex: index });
        const image = decoded.image;
        if (out.size === undefined) out.size = image.displayWidth + 'x' + image.displayHeight;
        const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const px = ctx.getImageData(0, 0, image.displayWidth, image.displayHeight).data;
        let total = 0;
        for (let k = 3; k < px.length; k += 4) total += px[k];
        const cov = total / (px.length / 4) / 255;
        // Occupancy above a mid alpha level, so "lit" traces the particle
        // cloud rather than the faint anti-aliasing skirt.
        let lit = 0;
        for (let k = 3; k < px.length; k += 4) if (px[k] > 127) lit++;
        // Coverage alone cannot tell "animated" from "static": a rotating shape
        // keeps a constant mean alpha while its pixels move all over. Hash the
        // channel (every 17th byte is plenty) so two frames are compared as
        // images rather than as statistics.
        let hash = 2166136261;
        for (let k = 3; k < px.length; k += 17) { hash ^= px[k]; hash = Math.imul(hash, 16777619); }
        out.sampled.push({
          i: index,
          mean: Number(cov.toFixed(4)),
          lit: Number((lit / (px.length / 4)).toFixed(4)),
          hash: (hash >>> 0).toString(16),
        });
        image.close();
      }
    } catch (e) { out.error = e.name + ': ' + e.message; }
    return out;
  })()`

  const result = await cdp.evaluate(probe)
  console.log(`asset: ${assetRel}`)
  console.log(`  ${asset.width}x${asset.height}, ${asset.bitDepth}bpp palette, ${asset.frames} frames, `
    + `${loops === undefined ? 'unknown' : loops.toFixed(2)}s loop, plays=${asset.plays} `
    + `(${asset.plays === 0 ? '0 = forever' : 'finite'}), ${assetBytes.length} B`)
  console.log(JSON.stringify(result, null, 2))

  const failures = []
  const advisories = []
  if (result.error) failures.push(`decoder error: ${result.error}`)
  if (result.animated !== true) failures.push('Chromium does not treat it as animated')
  if (result.frameCount !== asset.frames) {
    failures.push(`the browser sees ${result.frameCount} frames, the file declares ${asset.frames}`)
  }
  if (result.size !== `${asset.width}x${asset.height}`) {
    failures.push(`decoded at ${result.size}, the file declares ${asset.width}x${asset.height}`)
  }
  if (asset.plays === 0) {
    if (result.repetitionCount !== 'Infinity') {
      failures.push(`the file declares plays=0 (forever), Chromium reports ${result.repetitionCount}`)
    }
  } else if (!Number.isFinite(Number(result.repetitionCount))) {
    failures.push(`the file declares plays=${asset.plays}, Chromium reports ${result.repetitionCount}`)
  } else {
    advisories.push(`plays=${asset.plays}, so the animation stops after ${asset.plays} loops`)
  }

  const coverage = (result.sampled ?? []).map(s => s.mean)
  const hashes = new Set((result.sampled ?? []).map(s => s.hash))
  // If every sampled frame decodes to the same pixels, this is a still image
  // wearing an animation's clothes — which a screenshot cannot tell you. Scale
  // the bar with how many frames could be sampled, so a two-frame replacement
  // is judged on two frames rather than on ninety.
  if (hashes.size < Math.min(2, sampleIndices.length)) {
    failures.push(`frames are pixel-identical: ${sampleIndices.length} sampled frames hash to ${hashes.size} value(s)`)
  }
  // The check below says something worth hearing about a replacement loop, so it
  // is printed as an advisory and never fails the run. A coverage-delta check
  // used to sit here too, asking whether the middle frame dispersed; it was
  // dropped because a rotation or a pulse holds its coverage steady by design,
  // and an advisory that fires on the shipped default on every single run is an
  // advisory nobody reads.
  const first = coverage[0] ?? 0
  const last = coverage[coverage.length - 1] ?? 0
  if (!(Math.abs(last - first) / Math.max(first, 1e-6) < 0.08)) {
    advisories.push(`the loop seam is visible (first ${first} vs last ${last}); `
      + `a seamless loop wants its last frame close to its first`)
  }

  // --- 2. Optional probe + screenshot of a page ------------------------
  if (shotArg) {
    const [pageRel, outRel] = shotArg.split(':')
    await cdp.send('Page.navigate', { url: fileUrl(pageRel) })
    await sleep(waitArg)

    if (argv.includes('--probe')) {
      // The whole override rests on beating the shipped single-class rules on
      // specificity, and on the mask span swapping image. Read the computed
      // style rather than trusting the cascade by inspection. "Plugin off"
      // means disabling the stylesheet by flipping its media — hiding a
      // <style> with display:none does not disable it, which is an easy trap.
      const probe = `(() => {
        const out = {};

        // --- the icon override ---
        const icon = document.querySelector('[data-chat-running] span[aria-hidden="true"]:has(> svg)');
        if (!icon) return { error: 'icon box not found' };
        const mask = icon.querySelector('span');
        const cs = el => getComputedStyle(el);
        // The mask is compared in full, not by prefix: the shipped artwork is
        // itself a PNG data URI, so both begin url("data:image/png;base64,iVB
        // and a prefix test would pass whether or not the swap happened.
        const read = () => {
          const image = cs(mask).maskImage || '';
          return {
            width: cs(icon).width,
            height: cs(icon).height,
            maskImage: image,
            maskKind: image.slice(0, 26),
            maskLength: image.length,
            maskMode: cs(mask).maskMode,
          };
        };
        // One sheet carries the artwork, the override and the row's own CSS, so
        // disabling it is exactly what "plugin off" means.
        const pluginSheet = document.querySelector('style[data-spinner-custom]');
        if (!pluginSheet) return { error: 'no style[data-spinner-custom] in the page' };
        const originalMedia = pluginSheet.media;
        // The plugin's contract is that the sheet carries no motion: the
        // animation is the APNG. Re-checked here, in the browser, so a stray
        // @keyframes or a second payload declared later cannot hide from the
        // offline harness.
        const sheetText = pluginSheet.textContent;
        out.sheet = {
          length: sheetText.length,
          keyframes: (sheetText.match(/@keyframes/g) || []).length,
          svgMasks: (sheetText.match(/data:image\\/svg\\+xml,/g) || []).length,
          payloads: (sheetText.match(/base64,/g) || []).length,
          references: (sheetText.match(/var\\(--sc-mask\\)/g) || []).length,
        };
        out.withPlugin = read();
        pluginSheet.media = 'not all';
        out.withoutPlugin = read();
        pluginSheet.media = originalMedia;
        out.iconMedia = originalMedia || '(all)';
        // The real proof of the swap: the two images differ, and the lengths
        // match the two assets rather than the same one read twice.
        out.maskSwapped = out.withPlugin.maskImage !== out.withoutPlugin.maskImage;

        // The setting writes --spinner-custom-size on the document element; the
        // built-in 80px is only the CSS fallback. Prove the live path works by
        // writing that property the way the row does.
        const before = read().width;
        document.documentElement.style.setProperty('--spinner-custom-size', '${PROBE_SIZE}px');
        out.afterResize = read().width;
        document.documentElement.style.setProperty('--spinner-custom-size', '${PROBE_SIZE_2}px');
        out.afterResize2 = read().width;
        document.documentElement.style.removeProperty('--spinner-custom-size');
        out.afterRelease = read().width;
        out.beforeResize = before;

        // --- the settings row ---
        const row = document.querySelector('[data-spinner-custom-row]');
        const tiles = row ? Array.from(row.querySelectorAll('.sc-tile')) : [];
        out.row = row
          ? {
            present: true,
            // The picker is a radiogroup, not a tab strip: these are mutually
            // exclusive choices, not panels, and the difference is not cosmetic
            // — screen readers announce them differently.
            tablists: row.querySelectorAll('[role="tablist"]').length,
            radios: row.querySelectorAll('[role="radio"]').length,
            checked: tiles.filter(tile => tile.getAttribute('aria-checked') === 'true').length,
            checkedName: (tiles.find(tile => tile.getAttribute('aria-checked') === 'true') || {})
              .getAttribute('aria-label'),
            tileMasks: tiles.filter(tile => (getComputedStyle(tile.querySelector('.sc-mark')).maskImage || '')
              .startsWith('url("data:image/png;base64')).length,
            readout: row.querySelector('.sc-readout')?.textContent ?? null,
            rangeMin: row.querySelector('input[type=range]')?.min ?? null,
            rangeMax: row.querySelector('input[type=range]')?.max ?? null,
            resetDisabled: row.querySelector('.sc-reset')?.disabled ?? null,
          }
          : { present: false };

        // Clicking a tile is the whole feature, so do it for real rather than
        // trusting the markup: pick the first style that is not the chosen one
        // and read back what changed.
        //
        // Compared by length rather than by value: the masks are 50 KB data
        // URIs and echoing two of them into the report would bury everything
        // else in it. Lengths differ between these styles, and the default's own
        // payload is matched exactly further down.
        if (tiles.length > 1) {
          const other = tiles.find(tile => tile.getAttribute('aria-checked') !== 'true');
          out.beforeSwitch = { maskLength: (cs(mask).maskImage || '').length };
          other.click();
          out.afterSwitch = {
            label: other.getAttribute('aria-label'),
            checked: tiles.filter(tile => tile.getAttribute('aria-checked') === 'true')
              .map(tile => tile.getAttribute('aria-label')),
            readout: row.querySelector('.sc-readout')?.textContent ?? null,
            rangeMax: row.querySelector('input[type=range]')?.max ?? null,
            iconMaskLength: (cs(mask).maskImage || '').length,
          };
          out.switchChangedTheIcon = out.afterSwitch.iconMaskLength !== out.beforeSwitch.maskLength;
          // Put it back, so a later screenshot shows the shipped default.
          tiles.find(tile => tile.getAttribute('aria-label') === '${DEFAULT_ARTWORK.id}')?.click();
          out.restoredMaskLength = (cs(mask).maskImage || '').length;
        }

        const cell = row?.querySelector('.sc-cell');
        out.cell = cell
          ? {
            width: cs(cell).width,
            height: cs(cell).height,
            maskKind: (cs(cell).maskImage || '').slice(0, 26),
            maskLength: (cs(cell).maskImage || '').length,
            maskMode: cs(cell).maskMode,
          }
          : { present: false };

        // The page-level slider is wired to the same property the row writes,
        // so driving it exercises the row's own preview sizing too.
        const pageRange = document.getElementById('size');
        if (pageRange && cell) {
          pageRange.value = '${SLIDER_SIZE}';
          pageRange.dispatchEvent(new Event('input', { bubbles: true }));
          out.cellAfterSlider = { width: cs(cell).width, readout: row.querySelector('.sc-readout')?.textContent ?? null };
          out.iconAfterSlider = read().width;
        }

        // There is no artwork switch to exercise any more: the sheet is fixed
        // and the only thing that moves is the size.
        return out;
      })()`
      const report = await cdp.evaluate(probe)
      console.log('\ncomputed style of the icon box and the settings row:')
      // The full mask strings are hundreds of KB; the lengths and kinds are the
      // evidence, so the report is redacted before it reaches the log.
      const redact = ({ maskImage, ...rest }) => rest
      console.log(JSON.stringify({
        ...report,
        withPlugin: report.withPlugin && redact(report.withPlugin),
        withoutPlugin: report.withoutPlugin && redact(report.withoutPlugin),
        cell: report.cell && redact(report.cell),
      }, null, 2))
      if (report.error) {
        failures.push(`probe: ${report.error}`)
      } else {
        if (report.withPlugin.width !== `${DEFAULT_SIZE}px`) {
          failures.push(`override lost the cascade: icon is ${report.withPlugin.width}, expected ${DEFAULT_SIZE}px`)
        }
        if (report.withoutPlugin.width !== `${SHIPPED_ICON_PX}px`) {
          failures.push(`the shipped ${SHIPPED_ICON_PX}px rule should still win with the plugin off, got ${report.withoutPlugin.width}`)
        }
        if (!report.maskSwapped) {
          failures.push('the mask image is the shipped artwork; the override did not swap it')
        }
        if (!carriesThePayload(report.withPlugin?.maskLength)) {
          failures.push(`the running-row mask should be the ${EMBEDDED.length}-char inlined payload, got ${report.withPlugin?.maskLength}`)
        }
        if (report.withPlugin?.maskMode !== 'alpha') {
          failures.push(`expected mask-mode alpha, got ${report.withPlugin?.maskMode}`)
        }
        // The archive is inert: one payload, no procedural artwork, no motion.
        if (report.sheet?.keyframes !== 0) {
          failures.push(`the sheet should carry no @keyframes, found ${report.sheet?.keyframes}`)
        }
        if (report.sheet?.svgMasks !== 0) {
          failures.push(`the sheet should carry no SVG mask, found ${report.sheet?.svgMasks}`)
        }
        if (report.sheet?.payloads !== 1) {
          failures.push(`the payload should be declared once, found ${report.sheet?.payloads}`)
        }
        if (report.sheet?.references !== 4) {
          failures.push(`the payload should be referenced 4x (two rules x the -webkit- pair), found ${report.sheet?.references}`)
        }
        // The setting is only real if the property it writes moves the box.
        if (report.afterResize !== `${PROBE_SIZE}px`) failures.push(`size setting did not resize the icon: ${report.afterResize}`)
        if (report.afterResize2 !== `${PROBE_SIZE_2}px`) failures.push(`second size write ignored: ${report.afterResize2}`)
        if (report.afterRelease !== `${DEFAULT_SIZE}px`) failures.push(`releasing the property did not fall back to ${DEFAULT_SIZE}px: ${report.afterRelease}`)
        if (report.beforeResize !== `${DEFAULT_SIZE}px`) failures.push(`default should be ${DEFAULT_SIZE}px, got ${report.beforeResize}`)

        if (!report.row?.present) {
          failures.push('the settings row is not in the page')
        } else {
          // The picker is a radiogroup: mutually exclusive choices, no panels.
          // A tab strip here would be announcing the wrong thing to a screen
          // reader, which is why the shape of it is asserted and not just the
          // presence of buttons.
          if (report.row.tablists !== 0) {
            failures.push(`the picker should not be a tab strip, found ${report.row.tablists} tablists`)
          }
          if (report.row.radios !== region.artworks.length) {
            failures.push(`the picker should offer ${region.artworks.length} styles, found ${report.row.radios}`)
          }
          if (report.row.checked !== 1) {
            failures.push(`exactly one style should be marked chosen, found ${report.row.checked}`)
          }
          if (report.row.checkedName !== DEFAULT_ARTWORK.id) {
            failures.push(`the chosen style should be ${DEFAULT_ARTWORK.id}, got ${report.row.checkedName}`)
          }
          if (report.row.tileMasks !== region.artworks.length) {
            failures.push(`every tile should be masked by its own artwork, ${report.row.tileMasks} of ${region.artworks.length} are`)
          }
          if (report.row.readout !== `${DEFAULT_SIZE} px`) failures.push(`readout should read ${DEFAULT_SIZE} px, got ${report.row.readout}`)
          if (report.row.rangeMin !== String(MIN_SIZE) || report.row.rangeMax !== String(MAX_SIZE)) {
            failures.push(`range should be ${MIN_SIZE}..${MAX_SIZE}, got ${report.row.rangeMin}..${report.row.rangeMax}`)
          }

          // The harness can prove the store changes; only the browser can prove
          // that changing it re-masks the icon. That is the whole feature, so it
          // is clicked for real and read back off the computed style.
          if (report.switchChangedTheIcon !== true) {
            failures.push(`choosing another style did not change the running icon: ${report.beforeSwitch?.maskLength} chars stayed ${report.afterSwitch?.iconMaskLength}`)
          }
          if (!report.afterSwitch?.checked?.includes(report.afterSwitch?.label ?? '')) {
            failures.push(`the tick did not move to ${report.afterSwitch?.label}`)
          }
          if (!carriesThePayload(report.restoredMaskLength ?? -1)) {
            failures.push(`choosing the default again did not restore its ${EMBEDDED.length}-char artwork, got ${report.restoredMaskLength}`)
          }
          if (report.row.resetDisabled !== true) failures.push('reset should be inert at the default size')
        }
        if (report.cell?.present === false) failures.push('the preview cell is missing')
        else {
          if (report.cell.width !== `${DEFAULT_SIZE}px` || report.cell.height !== `${DEFAULT_SIZE}px`) {
            failures.push(`preview cell should be ${DEFAULT_SIZE}px, got ${report.cell.width}x${report.cell.height}`)
          }
          if (report.cell.maskKind !== 'url("data:image/png;base64') {
            failures.push(`the preview cell is not masked with the inlined APNG: ${report.cell.maskKind}`)
          }
          if (!carriesThePayload(report.cell.maskLength)) {
            failures.push(`the preview cell mask should be the ${EMBEDDED.length}-char inlined payload, got ${report.cell.maskLength}`)
          }
          if (report.cell.maskMode !== 'alpha') {
            failures.push(`the preview cell should mask by alpha, got ${report.cell.maskMode}`)
          }
        }
        if (report.cellAfterSlider?.width !== `${SLIDER_SIZE}px`) {
          failures.push(`the preview cell did not follow the slider: ${report.cellAfterSlider?.width}`)
        }
        if (report.cellAfterSlider?.readout !== `${SLIDER_SIZE} px`) {
          failures.push(`the readout did not follow the slider: ${report.cellAfterSlider?.readout}`)
        }
        if (report.iconAfterSlider !== `${SLIDER_SIZE}px`) {
          failures.push(`the running-row icon did not follow the slider: ${report.iconAfterSlider}`)
        }
      }
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await writeFile(fileOf(outRel), Buffer.from(shot.data, 'base64'))
    console.log(`\nscreenshot: ${outRel}`)
  }

  if (advisories.length) {
    console.log('\nADVISORY (a property of the artwork, not of the contract)')
    for (const advisory of advisories) console.log(`  - ${advisory}`)
  }

  if (failures.length) {
    console.error('\nFAIL')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('\nPASS')
  }
} finally {
  try { cdp?.socket.close() } catch {}
  chrome.kill()
  await sleep(200)
  await rm(profile, { recursive: true, force: true })
  await rm(fileOf('.verify-blank.html'), { force: true })
}
