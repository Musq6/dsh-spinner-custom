/**
 * Read an SVG's own description of itself, by reading the text.
 *
 * The SVG counterpart of tools/png-meta.mjs. Same argument as there: two tools
 * reading the same bytes with two implementations is two chances to disagree
 * about what a file is.
 *
 * What this project needs from an SVG is narrow, so the parser is narrow — a
 * handful of targeted reads over the text rather than a DOM. That keeps the
 * zero-dependency posture of the rest of `tools/`, at the cost of not being a
 * general XML parser: a file that is subtly malformed XML can still pass here
 * and simply render as nothing, which the preview page makes visible.
 *
 * Everything a caller needs to decide "can this be a style":
 *
 *   - `width` / `height`  the drawing's own size, from `viewBox` when present
 *                         and from `width`/`height` otherwise (numbers only;
 *                         unitless or `px` are accepted, anything else is not)
 *   - `animated`          whether the file animates at all — SMIL elements or a
 *                         CSS animation declared inside the SVG
 *   - `animationKind`     `'smil'` or `'css'`, for the report
 *   - `infinite`          whether an endless repeat is spelled out anywhere
 *   - `issues`            what a caller should refuse on, each with the reason
 *
 * `issues` is deliberately not an exception: the caller owns the wording and the
 * file name, and several checks are worth reporting together rather than one at
 * a time.
 *
 * @module tools/svg-meta
 */

/** Opening-tag reads. Attribute values are quoted; order does not matter. */
const ATTR = (name) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`)

/** A number, optionally with a unit this project accepts (`px` or nothing). */
const LENGTH = /^(\d+(?:\.\d+)?)(?:px)?\s*$/

/** SMIL animation elements. `<animate` also prefixes animateTransform/Motion. */
const SMIL = /<animate(?:Transform|Motion)?[\s>/]|<set[\s>]/

/** A CSS animation declared inside the SVG (its own <style> block). */
const CSS_ANIMATION = /@keyframes[\s{]|animation\s*:[^;]*;/i

/** An endless repeat, SMIL or CSS. */
const INFINITE = /repeatCount\s*=\s*["']indefinite["']|infinite/i

/** Things a mask must not carry. Each is a hard refusal, with the reason. */
const HARD_ISSUES = [
  ['<script', 'a <script> element. An SVG used as a CSS image must not carry code, '
    + 'and a spinner has no use for one.'],
  ['<!DOCTYPE', 'a DOCTYPE. Nothing in a spinner needs it, and entity tricks live there.'],
  ['<!ENTITY', 'an entity declaration. Nothing in a spinner needs it.'],
  ['<foreignObject', 'a <foreignObject>. HTML inside an SVG cannot be relied on to '
    + 'render as a mask.'],
  ['<image', 'an embedded raster (<image>). It would be inlined too, and it is the '
    + 'one thing that makes an SVG stop being small.'],
]

/** Event-handler attributes (`onclick=`, …) — attribute boundary anchored. */
const HANDLER = /\son[a-z]+\s*=\s*["']/i

/** An href that leaves the file: absolute, protocol-relative, or javascript:. */
const EXTERNAL = /(?:xlink:)?href\s*=\s*["']\s*(?:(?:https?:)?\/\/|javascript:)/i

/**
 * Read one number out of an attribute value, accepting unitless and `px`.
 * @param value - the raw attribute text, or undefined.
 * @returns the number, or undefined.
 */
function length(value) {
  if (value === undefined) return undefined
  const match = LENGTH.exec(value.trim())
  return match === null ? undefined : Number(match[1])
}

/**
 * Parse the four numbers of a `viewBox`, if it is present and well formed.
 * @param value - the raw attribute text, or undefined.
 * @returns `{ width, height }`, or undefined.
 */
function viewBox(value) {
  if (value === undefined) return undefined
  const parts = value.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return undefined
  const [, , width, height] = parts
  if (width <= 0 || height <= 0) return undefined
  return { width, height }
}

/**
 * Read an SVG's geometry, animation and safety posture.
 *
 * `viewBox` is read in both spellings, but the lowercase one is reported as a
 * hard issue rather than quietly used: SVG attributes are case-sensitive, so a
 * renderer ignores `viewbox` and the drawing is not sized as its author
 * intended. Accepting the number while the browser throws it away would be
 * vouching for a file this project cannot vouch for.
 *
 * @param text - the whole SVG file, decoded as text.
 * @returns the fields described at module level; `width`/`height` are undefined
 *   when the file states no usable size.
 */
export function readSvgMeta(text) {
  // Groups: 1 is the quoted value, 2/3 are the inside of the double/single
  // quoted form. Only the inner captures are numbers — the quotes are not.
  const correct = ATTR('viewBox').exec(text)
  const wrong = ATTR('viewbox').exec(text)
  const fromViewBox = viewBox(correct?.[2] ?? correct?.[3])
  const wrongCaseViewBox = fromViewBox === undefined
    ? viewBox(wrong?.[2] ?? wrong?.[3])
    : undefined

  const rawWidth = ATTR('width').exec(text)
  const rawHeight = ATTR('height').exec(text)
  const fromAttrs = {
    width: length(rawWidth?.[2] ?? rawWidth?.[3]),
    height: length(rawHeight?.[2] ?? rawHeight?.[3]),
  }

  // viewBox wins: it is the coordinate system the drawing is actually authored
  // against, and width/height may legitimately be "100%" (no number to take).
  const width = fromViewBox?.width ?? wrongCaseViewBox?.width ?? fromAttrs.width
  const height = fromViewBox?.height ?? wrongCaseViewBox?.height ?? fromAttrs.height

  const isSmil = SMIL.test(text)
  const isCss = CSS_ANIMATION.test(text)
  const issues = []

  for (const [needle, reason] of HARD_ISSUES) {
    if (text.includes(needle)) issues.push(`it contains ${reason}`)
  }
  if (HANDLER.test(text)) {
    issues.push('it carries an event-handler attribute (on…=). An SVG used as a CSS '
      + 'image must not carry code.')
  }
  if (EXTERNAL.test(text)) {
    issues.push('it references something outside the file (href to another origin, or '
      + 'javascript:). An inlined asset has to be self-contained: a reference that '
      + 'cannot load renders as nothing.')
  }
  if (wrongCaseViewBox !== undefined) {
    issues.push('it spells the attribute as `viewbox` (lowercase). SVG attribute names '
      + 'are case-sensitive, so renderers ignore it and the artwork is not sized as '
      + 'authored — rename it to `viewBox`.')
  }

  return {
    width,
    height,
    animated: isSmil || isCss,
    animationKind: isSmil ? 'smil' : isCss ? 'css' : undefined,
    infinite: INFINITE.test(text),
    issues,
  }
}
