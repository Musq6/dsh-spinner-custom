/**
 * Shared sandbox for the spinner-custom browser half.
 *
 * client.js cannot be exercised through the running app from here, so both
 * tools/check-plugin.mjs (assertions) and tools/build-preview.mjs (rendering)
 * drive it against the smallest environment its contract promises. Keeping that
 * environment in one file means the two tools cannot drift apart, and means the
 * preview is built from the same execution the checks passed.
 *
 * What is stubbed, and why each stub is honest:
 *
 *   react                     reduced to createElement and Fragment. The row
 *                             uses nothing else -- no hooks of its own, because
 *                             the slot's `hooks` face arrives as use<Name>
 *                             selector hooks the framework synthesizes.
 *   dsh-client-store          reimplemented to the documented persistence
 *                             contract (rehydrate at construction, write on
 *                             change, failures never break the store). Bound to
 *                             one run's storage, so a persistence assertion
 *                             means this run rather than Node's global.
 *
 * Nothing else is stubbed: the plugin requires `react` and the client store and
 * no other platform word, and the require stub throws on anything unexpected so
 * a new dependency shows up here rather than passing silently.
 *
 * Everything else -- the CSS, the selectors, the value domain, the effect graph
 * -- is the plugin's own code, unmodified.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)

/** Read one of the plugin's own files. */
export const read = (relative, from = root) => readFile(fileURLToPath(new URL(relative, from)))

/** @returns the absolute path of a plugin-relative file. */
export const fileOf = (relative, from = root) => fileURLToPath(new URL(relative, from))

// --- React, reduced to what the row uses ------------------------------------
export function createElement(type, props, ...children) {
  const flat = []
  const push = (child) => {
    if (Array.isArray(child)) { for (const item of child) push(item); return }
    flat.push(child)
  }
  for (const child of children) push(child)
  return {
    type,
    props: {
      ...(props ?? {}),
      children: flat.filter(child => child !== null && child !== undefined && child !== false),
    },
  }
}

/** Attributes React renders as `name=""` when truthy. */
const BOOLEAN_ATTRS = new Set([
  'hidden', 'disabled', 'checked', 'selected', 'readOnly', 'multiple', 'required', 'open',
])

const escapeHtml = text => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const cssText = style => Object.entries(style).map(([key, value]) => `${key}: ${value}`).join('; ')

/**
 * Serialize an element tree to HTML, for the shapes this plugin produces.
 * @param node - element, text, or function component.
 * @returns the HTML string.
 */
export function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(String(node))
  if (typeof node.type === 'function') return render(node.type(node.props))
  const { type, props } = node
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    // `children` is serialized below, `key` is a React bookkeeping field that
    // never reaches the DOM, and handlers are not attributes. Keeping all three
    // out means the markup a test reads matches what the browser would see.
    if (key === 'children' || key === 'key' || key.startsWith('on')) continue
    if (value === undefined || value === null || value === false) continue
    if (key === 'style') { attrs.push(`style="${escapeHtml(cssText(value))}"`); continue }
    if (BOOLEAN_ATTRS.has(key)) { if (value) attrs.push(`${key}=""`); continue }
    attrs.push(`${key === 'className' ? 'class' : key}="${escapeHtml(String(value))}"`)
  }
  const open = `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`
  return `${open}${props.children.map(render).join('')}</${type}>`
}

// --- environment ------------------------------------------------------------
/**
 * Load client.js and apply it against a fresh sandbox.
 *
 * `source` overrides the module text. It exists for one case:
 * `node tools/embed-asset.mjs --clear` empties the generated region, and the
 * plugin is supposed to handle that state rather than break — a claim worth
 * exercising without emptying the working tree, so the checker passes the
 * cleared text in instead. Everything else uses the file on disk.
 *
 * @param options - optional seeded localStorage contents and a source override.
 * @returns the materialized module, the recorded context calls, and the sandbox.
 */
export async function bootClient({ stored, source } = {}) {
  const storage = new Map(Object.entries(stored ?? {}))
  const styles = []
  const documentStub = {
    createElement() {
      const tag = { dataset: {}, textContent: '', removed: false, remove() { this.removed = true } }
      return tag
    },
    head: { append: (...tags) => { styles.push(...tags) } },
    documentElement: {
      dataset: {},
      style: {
        value: new Map(),
        setProperty(name, next) { this.value.set(name, next) },
        removeProperty(name) { this.value.delete(name) },
        getPropertyValue(name) { return this.value.get(name) ?? '' },
      },
    },
    querySelector() { return null },
  }

  // Bound to this run's storage; see the module comment for why.
  const createSnapshotStore = (init, opts) => {
    const key = opts?.persist?.name
    const listeners = new Set()
    let value = init
    if (key !== undefined) {
      try {
        const raw = storage.get(key)
        if (raw !== undefined) value = JSON.parse(raw)
      } catch (error) { console.error(`rehydration failed: ${String(error)}`) }
    }
    const set = (next) => {
      value = next
      for (const listener of listeners) listener()
      if (key === undefined) return
      try { storage.set(key, JSON.stringify(value)) } catch (error) { console.error(`persistence failed: ${String(error)}`) }
    }
    return {
      getSnapshot: () => value,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      set,
      /**
       * The real engine's `update` is a **void draft mutator**: the mutator is
       * handed a draft, may mutate it, and its return value is DISCARDED
       * (`@deepseek-ai/dsh-client-store` runs `produce(state, draft => {
       * mutator(draft) })` — a wrapper with no return). That detail is
       * load-bearing: client.js once wrote `update(state => ({ ...state, x }))`
       * and every write silently did nothing, because immer saw a recipe that
       * changed nothing and returned undefined, so it handed back the original.
       *
       * This stub has to reproduce that trap rather than paper over it, which is
       * why the return value is thrown away here too. Without immer there is no
       * structural sharing, so the draft is a JSON clone, and a mutator that
       * changes nothing keeps the old reference the way immer's bail-out does.
       */
      update(mutator) {
        const draft = JSON.parse(JSON.stringify(value))
        mutator(draft)
        if (JSON.stringify(draft) !== JSON.stringify(value)) set(draft)
      },
    }
  }

  const requireStub = (spec) => {
    if (spec === 'react') return { createElement, Fragment: 'Fragment' }
    if (spec === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
    throw new Error(`harness: unexpected require(${JSON.stringify(spec)})`)
  }

  const localStorageStub = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, value) },
    removeItem: (key) => { storage.delete(key) },
  }

  const sandbox = {
    window: {},
    document: documentStub,
    localStorage: localStorageStub,
    console,
    Math,
    Number,
    JSON,
    Object,
    Array,
    String,
    encodeURIComponent,
    setTimeout,
  }
  sandbox.window.document = documentStub
  sandbox.window.localStorage = localStorageStub

  let registration
  sandbox.window.__ModuleLoader__ = { load(row) { registration = row } }
  vm.createContext(sandbox)
  // The bundle is plain script text, so it runs in the context directly. It only
  // registers a factory; every side effect lives inside that closure and fires
  // at materialization, which is exactly what the loader promises.
  vm.runInContext(source ?? (await read('client.js')).toString('utf8'), sandbox)
  if (!registration) throw new Error('client.js did not call __ModuleLoader__.load')

  const mod = registration.factory(requireStub)
  const effects = []
  const dictionaries = []
  const waits = []
  const registrations = []
  const ctx = {
    effect(fn, label) { const dispose = fn(); effects.push({ label, dispose }); return () => { dispose() } },
    locale: { register(ns, dicts) { dictionaries.push({ ns, dicts }); return () => {} } },
    slots: {
      inject(key, callback) { waits.push({ key, callback }); return () => {} },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  return {
    mod, ctx, documentStub, styles, effects, dictionaries, waits, registrations, storage, sandbox, registration,
  }
}

/**
 * Open the settings section by running every pending slot wait, then render the
 * row the plugin registered with a face the framework would have composed.
 *
 * @param env - the boot result.
 * @param index - which recorded registration to render; the last is default.
 * @param translate - the `t` seat; defaults to the identity, which makes an
 *   assertion about a copy key name rather than about a sentence.
 * @returns the registration, the face, the composed props, and the row's HTML.
 */
export function openSlot(env, index, translate) {
  for (const wait of env.waits) wait.callback()
  // Resolved after the waits run: a default argument would be evaluated before
  // the registration the waits produce exists.
  const { options, component } = env.registrations[index ?? env.registrations.length - 1]
  const face = options.inject()
  // The slot turns the face's `hooks` compartment into use<Name> selector hooks;
  // a stub has to do the same projection or the row would be handed raw stores
  // where it expects hooks. Derived from the keys rather than written out, so
  // renaming a hook in client.js cannot leave a stale projection here that
  // silently hands the row `undefined`.
  const hooks = Object.fromEntries(Object.entries(face.hooks ?? {}).map(([name, store]) => [
    `use${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    selector => selector(store.getSnapshot()),
  ]))
  const props = {
    ...face,
    ...hooks,
    t: translate ?? (key => key),
  }
  return { options, component, face, props, html: render(component(props)) }
}

/**
 * A `t` seat backed by one of the plugin's own registered dictionaries, for
 * surfaces that should read as the user sees them (the preview page) rather
 * than as the keys a test asserts on.
 *
 * @param env - a boot result whose apply() already ran.
 * @param locale - dictionary id, e.g. `zh`.
 * @returns a translate function with the framework's key fallback.
 */
export function translator(env, locale) {
  const dict = env.dictionaries[0]?.dicts[locale] ?? {}
  return key => dict[key] ?? key
}
