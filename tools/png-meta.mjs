/**
 * Read a PNG's own description of itself by walking its chunks.
 *
 * Shared by tools/embed-asset.mjs (which validates and inlines one asset) and
 * tools/build-preview.mjs (which reports the real cost of every asset in the
 * folder), so the two cannot disagree about what a file is. Keeping that in one
 * place is the same argument as tools/harness.mjs: two tools reading the same
 * bytes with two implementations is two chances to drift.
 *
 * Nothing here decodes pixels. IHDR, acTL, tRNS and the first fcTL are all this
 * project ever needs — the browser is the only thing that decodes, and
 * tools/verify-chromium.mjs is what asks it.
 *
 * @module tools/png-meta
 */

const SIGNATURE = '\x89PNG\r\n\x1a\n'

/** length(4) + type(4) + crc(4). */
const CHUNK_OVERHEAD = 12

/**
 * Collect the fields that describe the image.
 *
 * A truncated chunk ends the walk instead of throwing: a half-written asset
 * should come back with whatever was legible, and the caller's validators
 * decide whether that is enough to be useful.
 *
 * @param png - the file's bytes.
 * @returns the fields found; absent ones are `undefined`.
 */
export function readPngMeta(png) {
  const meta = {}
  if (!isPng(png)) return meta

  let at = SIGNATURE.length
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const kind = png.subarray(at + 4, at + 8).toString('latin1')
    const body = png.subarray(at + 8, at + 8 + length)
    if (body.length < length) break

    if (kind === 'IHDR') {
      meta.width = body.readUInt32BE(0)
      meta.height = body.readUInt32BE(4)
      meta.bitDepth = body[8]
      meta.colourType = body[9]
      meta.interlace = body[12]
    } else if (kind === 'acTL') {
      meta.frames = body.readUInt32BE(0)
      meta.plays = body.readUInt32BE(4)
    } else if (kind === 'tRNS') {
      meta.alphaEntries = length
    } else if (kind === 'fcTL' && meta.delayDen === undefined) {
      // seq(4) w(4) h(4) x(4) y(4) delay_num(2) delay_den(2) dispose(1) blend(1)
      meta.delayNum = body.readUInt16BE(20)
      meta.delayDen = body.readUInt16BE(22)
    }

    at += CHUNK_OVERHEAD + length
    if (kind === 'IEND') break
  }
  return meta
}

/**
 * @param png - the file's bytes.
 * @returns true when the file starts with the 8-byte PNG signature.
 */
export function isPng(png) {
  return png.length >= SIGNATURE.length && png.subarray(0, 8).toString('binary') === SIGNATURE
}

/**
 * @param meta - a {@link readPngMeta} result.
 * @returns the loop length in seconds, or `undefined` when there is no usable
 *   frame timing to derive one from.
 */
export function loopSeconds(meta) {
  if (meta.frames === undefined || !meta.delayDen) return undefined
  return meta.frames * (meta.delayNum / meta.delayDen)
}
