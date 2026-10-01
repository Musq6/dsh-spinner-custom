/**
 * Build preview.html.
 *
 * The page is not an approximation. It runs the real client.js in the sandbox
 * from tools/harness.mjs, captures the CSS the plugin actually injects, and
 * renders the settings row from the very component the plugin registered: same
 * markup, same classes, same inline sizes. The running row below it is a mock
 * whose class-level specificity mirrors the host 1:1, so if the override did not
 * out-specify the shipped rules the native whale would show up here rather than
 * in the app.
 *
 * One thing is a stand-in, and it is marked as such on the page: the two sliders
 * are wired by hand, so the page reacts the way React would rather than by
 * re-rendering.
 *
 * Nothing on the page is restated from memory. The styles, their edges and their
 * recommended sizes are read back out of client.js with the same module that
 * wrote them, the size ladder spans the plugin's own range, and each inlined
 * style is matched back to the file it came from for its frame count — so
 * swapping the artwork updates the page rather than making it lie.
 *
 *   node tools/build-preview.mjs
 */
import { writeFile, readFile, readdir } from 'node:fs/promises'
import { bootClient, openSlot, translator, fileOf, read } from './harness.mjs'
import { readPngMeta, loopSeconds } from './png-meta.mjs'
import { parseRegion, fallbackArtwork } from './region.mjs'

// The styles belong to client.js, not to this page — tools/embed-asset.mjs
// rewrites the whole region from the artwork it is handed. Read it back rather
// than restating it, so the preview cannot advertise a range the plugin lacks.
const CLIENT = await readFile(fileOf('client.js'), 'utf8')
const MIN_SIZE = (() => {
  const match = CLIENT.match(/const MIN_SIZE = (\d+)/)
  if (!match) throw new Error('client.js has no `const MIN_SIZE = <number>` literal')
  return Number(match[1])
})()
const region = parseRegion(CLIENT)
const FALLBACK = fallbackArtwork(region)

// `--clear` is a documented state and a publishable one, so this tool has to
// survive it rather than throwing on an empty stylesheet three lines later.
if (FALLBACK === undefined) {
  await writeFile(fileOf('preview.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>没有内联素材</title>
<style>body{margin:0;padding:60px 24px;background:#fff;color:#2C2C2A;
font:400 14px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:640px;margin:0 auto}h1{font-size:18px;margin:0 0 12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;
background:#F7F7F5;border:1px solid #E4E2DB;border-radius:4px;padding:1px 5px}
p{color:#5F5E5A}pre{background:#F7F7F5;border:1px solid #E4E2DB;border-radius:10px;
padding:14px 16px;font-size:13px;overflow-x:auto}</style></head>
<body><main>
<h1>这个构建没有内联素材</h1>
<p><code>client.js</code> 的生成区现在是空的（<code>--clear</code> 之后的正常状态）。
在那种状态下插件不覆盖任何东西，也没有设置行可渲染，所以这个预览页没有内容可展示。</p>
<p>内联之后重新生成本页：</p>
<pre>node tools/embed-asset.mjs          # asset/ 里的全部
node tools/embed-asset.mjs a.png    # 或者指定
node tools/build-preview.mjs</pre>
<p>想要仓库自带的整套风格：<code>bash tools/build-spinners.sh &amp;&amp; node tools/embed-asset.mjs</code></p>
</main></body></html>
`, 'utf8')
  console.log('client.js has no artwork embedded, so there is nothing to preview.')
  console.log('preview.html written: a notice saying exactly that.')
  console.log('Inline some first:  node tools/embed-asset.mjs')
  process.exit(0)
}

/**
 * The inlined styles, in picker order, each matched back to the file it came
 * from so the table can report the frame count and loop length that the region
 * itself does not carry.
 *
 * The match is by the file-name convention `<id>-<edge>x<edge>-...` that
 * tools/build-spinners.sh writes. It is a convenience, not a contract: a style
 * whose source file cannot be found is still listed, with dashes where the
 * timing would be. Guessing, or omitting the row entirely, would both be worse
 * than admitting the page does not know.
 *
 * Only the top level of asset/ is read, on purpose: `asset/local/` is the
 * gitignored tier for artwork that may not be redistributed, and this page is a
 * build artifact that could be handed to somebody.
 */
async function describeStyles() {
  const directory = fileOf('asset')
  const names = (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .map(entry => entry.name)
    .sort()

  return Promise.all(region.artworks.map(async (artwork) => {
    const file = names.find(name => name.startsWith(`${artwork.id}-`))
    if (file === undefined) return { ...artwork, file: undefined }

    const bytes = await readFile(`${directory}/${file}`)
    const meta = readPngMeta(bytes)
    return {
      ...artwork,
      file,
      frames: meta.frames,
      loop: loopSeconds(meta),
      bytes: bytes.byteLength,
    }
  }))
}
const STYLES = await describeStyles()

const MAX_SIZE = FALLBACK.edge
const DEFAULT_SIZE = FALLBACK.defaultSize

const booted = await bootClient()
booted.mod.apply(booted.ctx)
// The page should read the way the user sees it, so the row is rendered with
// the plugin's own Chinese dictionary rather than with the identity seat a
// test would use.
const slot = openSlot(booted, undefined, translator(booted, 'zh'))

const pluginCss = booted.styles[0].textContent
const rowHtml = slot.html

const SHIPPED_REL = '../deepseek-harness/packages/client/ui-chat/src/client/chat/running-whale@2x.png'
/**
 * The host's own animated icon, for the "plugin off" comparison.
 *
 * Optional on purpose. This plugin is its own repository and a clone of it
 * stands alone, with no harness checkout next door — so the comparison is worth
 * having when it is there and worth losing quietly when it is not. A miss
 * degrades the page rather than failing the build.
 *
 * Nothing of the host's is redistributed either way: preview.html is generated
 * and gitignored.
 */
const shippedRaw = await read(SHIPPED_REL, new URL('../', import.meta.url)).catch(() => undefined)
const shipped = shippedRaw?.toString('base64')
const shippedBytes = shippedRaw?.byteLength
/** Read rather than restated: the contrast row is a claim about the host. */
const shippedMeta = shippedRaw === undefined ? undefined : readPngMeta(shippedRaw)

/** The shipped static fallback path, so the mock is faithful under reduced motion. */
const REST_PATH = 'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742'

/**
 * The ladder spans the plugin's own range, so it stays honest for any asset:
 * the host floor, the default, the ceiling, and steps in between.
 */
const LADDER = [...new Set([
  MIN_SIZE, 20, 28, 40, 56, DEFAULT_SIZE,
  Math.round((DEFAULT_SIZE + MAX_SIZE) / 2), MAX_SIZE,
].filter(px => px >= MIN_SIZE && px <= MAX_SIZE))].sort((a, b) => a - b)

/** Displayed CSS: the base64 is enormous, so show its shape not its bytes. */
const shrink = css => css
  .replace(/url\("data:image\/png;base64,[^"]+"\)/g,
    `url("data:image/png;base64,…${(FALLBACK.chars / 1000).toFixed(0)} K chars…")`)
const dump = (label, css) => `/* ======== ${label} ======== */\n${shrink(css)}`

const fmt = n => n.toLocaleString('en-US')

/**
 * When the harness checkout is not next door there is nothing to compare
 * against, so the mock falls back to the host's static SVG — which is what the
 * host itself shows under reduced motion, so the page degrades into a state
 * that genuinely exists rather than into a broken one.
 *
 * The fallback has to `display: none` the masked element as well as swap the
 * SVG in. `--shipped` is what the mask reads, and with the variable undefined
 * the mask declaration is simply invalid at computed-value time — which leaves
 * `.apng` as a solid `currentColor` block, not as nothing. Hiding it is the
 * only honest way to say "there is no image here".
 */
const SHIPPED_FALLBACK = shipped === undefined
  ? `
  .apng { display: none !important; }
  .still { display: initial !important; }`
  : ''

/** The declaration, or a comment where the variable cannot be defined. */
const shippedVar = shipped === undefined
  ? '/* 没有找到隔壁的 harness 检出，所以没有宿主素材可供对照 */'
  : `--shipped: url("data:image/png;base64,${shipped}");`

const shippedNote = shipped === undefined
  ? '<p class="note">没有找到隔壁的 harness 检出，所以「关掉插件」看到的是宿主在减弱动效下用的那张静态 SVG，而不是它的动图。对照行和相关的体积比较也一并略去。</p>'
  : ''

/** `frames` is absent on a still, so say 静态 rather than "undefined 帧". */
const describe = meta => meta.frames === undefined
  ? `${meta.width}px · 静态`
  : `${meta.width}px · ${meta.frames} 帧`

/** PNG colour type numbers -> the name a reader knows. */
const COLOUR_NAMES = {
  0: '灰度', 2: '真彩', 3: '调色板', 4: '灰度+Alpha', 6: 'RGBA',
}

/** Read rather than assumed: the host's file decides how it is described. */
const describeHost = meta =>
  `${meta.width}×${meta.height} 的${COLOUR_NAMES[meta.colourType] ?? `色彩类型 ${meta.colourType}`} APNG`

/**
 * Where the host's own file differs from this plugin's choice — quoted from that
 * file rather than restated, so it disappears along with the comparison row when
 * the file is absent, instead of turning into a claim about a file nobody in
 * this clone can open.
 */
const hostNote = shippedMeta === undefined ? '' : `<p class="prose">注意宿主的对照行也是<strong>2 倍图</strong> —— 它是一张 ${describeHost(shippedMeta)}，显示在 14px 的盒子里。这个插件沿用了同一条约定，所以默认边长是素材边长的一半。</p>`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>运行图标 · 尺寸、观感与设置</title>
<style>
  :root {
    --bg: #ffffff;
    --panel: #F7F7F5;
    --text: #2C2C2A;
    --muted: #5F5E5A;
    --faint: #8A8880;
    --border: #E4E2DB;
    --rule: #EDEBE4;
    /* The host's own --dsw-alias-label-deep-diving, light and dark. */
    --deep-diving: color-mix(in srgb, rgb(65, 118, 230) 70%, rgb(23, 37, 84));
    /* 宿主自带那张 APNG，「原生」档用它，保证对比是真的 */
    ${shippedVar}
    /* The plugin's --dsw-* tokens only exist inside the app; map them onto this
       page's palette so the captured CSS renders as it does in situ. */
    --dsw-alias-label-primary: #2C2C2A;
    --dsw-alias-label-secondary: #5F5E5A;
    --dsw-alias-label-tertiary: #8A8880;
    --dsw-alias-border-l2: #E4E2DB;
    --dsw-alias-interactive-bg-hover: #F1F1EE;
    --dsw-alias-bg-module-platform: #F7F7F5;
    --dsw-alias-label-deep-diving: color-mix(in srgb, rgb(65, 118, 230) 70%, rgb(23, 37, 84));
    --dsw-radius-md: 8px;
    --dsw-radius-sm: 6px;
  }
  body[data-dark] {
    --bg: #1B1B1A; --panel: #242423; --text: #ECEAE4; --muted: #A8A6A0;
    --faint: #7C7A74; --border: #3A3A38; --rule: #2E2E2C;
    --deep-diving: color-mix(in srgb, rgb(86, 134, 254) 55%, rgb(173, 178, 184));
    --dsw-alias-label-primary: #ECEAE4;
    --dsw-alias-label-secondary: #A8A6A0;
    --dsw-alias-label-tertiary: #7C7A74;
    --dsw-alias-border-l2: #3A3A38;
    --dsw-alias-interactive-bg-hover: #2E2E2C;
    --dsw-alias-bg-module-platform: #242423;
    --dsw-alias-label-deep-diving: color-mix(in srgb, rgb(86, 134, 254) 55%, rgb(173, 178, 184));
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 30px 24px 56px;
    background: var(--bg); color: var(--text);
    font: 400 14px/1.65 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; font-weight: 600; margin: 34px 0 12px; color: var(--muted);
       text-transform: uppercase; letter-spacing: 0.06em; }
  p.lead { margin: 0 0 8px; color: var(--muted); }
  p.lead strong { color: var(--text); font-weight: 600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
         background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin: 22px 0 14px; }
  .switch { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); cursor: pointer; user-select: none; }
  .stage { border: 1px solid var(--border); border-radius: 14px; background: var(--bg); padding: 20px 22px 24px; }
  .stage + .stage { margin-top: 14px; }
  .note { margin: 14px 0 0; padding: 10px 13px; border-left: 2px solid var(--border);
          color: var(--faint); font-size: 12px; line-height: 1.7; }
  .prose { color: var(--muted); margin: 0 0 14px; }

  /* ---- Mock of the real running row ---------------------------------- */
  /* Class-level specificity only, mirroring ChatView.module.css, so the
     plugin's override has to actually win the cascade. */
  .mock { display: flex; flex-direction: column; align-items: flex-start;
          color: var(--deep-diving);
          font-size: calc(14px - 2px); line-height: calc(22px + 0px); }
  .divider { display: block; width: 100%; height: .5px; margin: 8px 0 10px;
             background: var(--rule); }
  .content { display: inline-flex; align-items: center; min-width: 0; gap: 6px; }
  .text { min-width: 0; font-variant-numeric: tabular-nums; }
  .icon { position: relative; display: inline-flex; flex: none;
          width: calc(14px + 0px); height: calc(14px + 0px);
          contain: strict; overflow: hidden; }
  .apng { display: none; position: absolute; inset: 0; }
  .still { display: initial; }
  @supports (mask-mode: alpha) and (mask-image: url('')) {
    @media (prefers-reduced-motion: no-preference) and (forced-colors: none) {
      .apng { display: block; background: currentColor;
              -webkit-mask: var(--shipped) center / 100% 100% no-repeat;
              mask: var(--shipped) center / 100% 100% no-repeat;
              -webkit-mask-mode: alpha; mask-mode: alpha; }
      .still { display: none; }
    }
  }${SHIPPED_FALLBACK}

  /* ---- The settings panel wrapper ------------------------------------ */
  /* Mirrors ui-settings-general's General column: a bordered panel of rows. */
  .panel { border: 1px solid var(--border); border-radius: 14px; padding: 4px 20px 8px; background: var(--bg); }
  .panel-title { font-size: 15px; font-weight: 600; padding: 16px 0 2px; }
  .host-row { display: flex; align-items: center; gap: 8px; padding: 16px 0 18px;
              border-bottom: 0.5px solid var(--rule); }
  .host-row .label { flex: 1; min-width: 0; font-size: 14px; line-height: 22px; }
  .host-row .label small { display: block; font-size: 12px; line-height: 18px; color: var(--faint); font-weight: 400; }
  .fake-pill { display: inline-flex; align-items: center; height: 36px; padding: 0 14px;
               border-radius: 8px; background: var(--panel); font-size: 14px; }
  .fake-switch { width: 34px; height: 20px; border-radius: 10px; background: var(--deep-diving); flex: none; }

  /* ---- Size ladder ---------------------------------------------------- */
  .ladder { display: flex; align-items: flex-end; gap: 26px; flex-wrap: wrap; padding: 4px 0 2px; }
  .ladder .cell { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .ladder .cap { font-size: 11px; color: var(--faint);
                 font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .ladder .box { display: flex; align-items: flex-end; }

  /* ---- Table ---------------------------------------------------------- */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--border); }
  th { color: var(--faint); font-weight: 600; font-size: 11px;
       text-transform: uppercase; letter-spacing: 0.06em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums;
           font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  tr[data-current] td { color: var(--text); font-weight: 600; }
  .slider { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .slider input[type=range] { width: 300px; accent-color: var(--deep-diving); }
  .slider .read { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                  font-size: 12px; color: var(--muted); min-width: 92px; }
  .slider .hintline { color: var(--faint); font-size: 13px; }
  pre { margin: 0; padding: 15px 17px; overflow-x: auto; max-height: 360px;
        background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px; line-height: 1.7; color: var(--text); }
</style>
<!-- Captured from client.js: the one sheet the plugin injects, carrying the
     same owner marker the plugin stamps on the real tag. -->
<style id="plugin" data-spinner-custom="@local/spinner-custom">${pluginCss}</style>
</head>
<body>
<main>
  <h1>运行图标 · 样式、尺寸与设置</h1>
  <p class="lead">内置 <strong>${STYLES.length} 个样式</strong>，全部由 <code>tools/make-placeholder.py</code> 当场画出来（纯标准库、不摇随机数、逐字节可复现），<strong>不含任何外部片段</strong>。每个样式是一组周期函数的点测试，所以循环是数学上精确闭合的，不是"看起来接得上"。</p>
  <p class="lead">设置行是<strong>插件注册的那个组件渲染出来的真实标记</strong>；注入的 CSS 也是在 sandbox 里跑 <code>client.js</code> 抓的，不是抄的。下面那一排选择器是真实尺寸的按钮，点一下就能换样式。</p>

  <div class="toolbar">
    <label class="switch"><input type="checkbox" id="dark"> 暗色主题</label>
    <label class="switch"><input type="checkbox" id="native"> 关掉插件（看宿主原生）</label>
  </div>
  ${shippedNote}

  <h2>设置 → 通用 里的那一行</h2>
  <div class="stage">
    <p class="prose">插件把一行注册进 <code>settings.general.item</code> —— 宿主给「通用」声明的一个 list 槽位（<code>replaceRisk: none</code>），别的插件也是这样加行的。左边是实时预览台，右边是样式选择器和大小滑块；改完立刻作用于下面的运行行，并写进 localStorage。</p>
    <p class="prose">注意<strong>大小范围跟着所选样式走</strong>：滑块的上限是该样式素材的边长，默认值是一半（2 倍图规则）。这不是过度设计 —— 一个 160px 的栅格和一个 96px 的没法共用一个天花板，要么浪费一个、要么放大另一个。</p>
    <div class="panel">
      <div class="panel-title">通用</div>
      <div class="host-row">
        <span class="label">外观<small>跟随系统或手动指定</small></span>
        <span class="fake-pill">跟随系统</span>
      </div>
      <div id="rowHost">${rowHtml}</div>
      <div class="host-row" style="border-bottom:0">
        <span class="label">检查更新<small>自动检查新版本</small></span>
        <span class="fake-switch"></span>
      </div>
    </div>
    <p class="note">上下两行是宿主自己的行（示意），中间那行才是插件加的。滑块的行为由本页脚本手工接线，效果与 React 里一致，只是重渲染是替身。</p>
  </div>

  <h2>放进真实的那一行</h2>
  <div class="stage">
    <p class="prose">下面是运行状态行的复刻：上面一行是正文，分隔线以下是「深度求索中，用时 12 秒」。拖上面的滑块，这里会跟着变。</p>
    <div class="mock" data-chat-running>
      <p style="margin:0 0 4px;color:var(--text)">我来把这个函数改成流式解析，顺便补上错误分支。</p>
      <span class="divider" aria-hidden="true"></span>
      <span class="content">
        <span class="icon" aria-hidden="true">
          <span class="apng"></span>
          <svg class="still" viewBox="0 0 16 16" fill="none"><path d="${REST_PATH}" stroke="currentColor" stroke-width="1"/></svg>
        </span>
        <span class="text">深度求索中，用时 12 秒</span>
      </span>
    </div>
    <div class="slider" style="margin-top:22px">
      <span class="read" id="sizeRead">80 px</span>
      <input type="range" id="size" min="${MIN_SIZE}" max="${MAX_SIZE}" step="1" value="${DEFAULT_SIZE}">
      <span class="hintline">两个滑块同源，都写 <code>--spinner-custom-size</code></span>
    </div>
  </div>

  <h2>尺寸阶梯</h2>
  <div class="stage">
    <p class="prose">同一张素材在不同边长下的真实像素。最左边是宿主原生的 14px —— 素材在那个边长上被重采样，比一团色块更细的结构就没了，这就是要把盒子放大的原因。</p>
    <div class="ladder">
      ${LADDER.map(px => `<div class="cell" style="--spinner-custom-size:${px}px">
        <div class="box" style="height:168px">
          <div class="mock" data-chat-running>
            <span class="content">
              <span class="icon" aria-hidden="true">
                <span class="apng"></span>
                <svg class="still" viewBox="0 0 16 16" fill="none"><path d="${REST_PATH}" stroke="currentColor" stroke-width="1"/></svg>
              </span>
            </span>
          </div>
        </div>
        <span class="cap">${px}px${px === MIN_SIZE ? ' 原生' : ''}${px === DEFAULT_SIZE ? ' 默认' : ''}</span>
      </div>`).join('\n      ')}
    </div>
  </div>

  <h2>体积</h2>
  <p class="prose">浏览器里不能 <code>import</code> 或 <code>fetch</code> 同级资源：<code>/plugins</code> 只应答入口脚本和 <code>client.&lt;名字&gt;.js</code> 分片，别的一律 404；<code>dsh-resource://</code> 又是 React 钩子读的页内值，浏览器根本不会去取。所以每个样式都只能作为 data URI 内联，体积因此是硬的 —— 这也是为什么样式表里那份载荷只声明一次（<code>--sc-mask</code>），图标和预览台共用；选择器的小图各自带一份 <code>--sc-art</code>，但它们本来就在模块里，没有多花字节。</p>
  <table>
    <thead><tr><th>样式</th><th>规格</th><th class="num">图标边长</th><th class="num">PNG</th><th class="num">内联后</th></tr></thead>
    <tbody>
      ${STYLES.map(style => `<tr${style.id === FALLBACK.id ? ' data-current' : ''}>
        <td><code>${style.id}</code>${style.id === FALLBACK.id ? ' <strong>← 默认</strong>' : ''}</td>
        <td class="num">${style.edge}px · ${style.frames === undefined ? '静态'
          : `${style.frames} 帧 · ${style.loop === undefined ? '?' : `${style.loop.toFixed(2)}s`}`}</td>
        <td class="num">${style.defaultSize}px</td>
        <td class="num">${style.bytes === undefined ? '—' : `${fmt(style.bytes)} B`}</td>
        <td class="num">${fmt(style.chars)} B</td>
      </tr>`).join('\n      ')}${shippedMeta === undefined ? '' : `
      <tr><td>宿主原生（对照）</td>
        <td class="num">${describe(shippedMeta)}</td>
        <td class="num">14px</td>
        <td class="num">${fmt(shippedBytes)} B</td><td class="num">—</td></tr>`}
    </tbody>
  </table>
  <p class="prose" style="margin-top:14px">同样是 160×160 / 60 帧，编码方式决定体积。默认那个样式实测：8 位灰度+Alpha <strong>299,653 B</strong>、8 位调色板 216,343 B、4 位 88,476 B、2 位 <strong>40,929 B</strong>。省下来的不是压缩率，而是<strong>每像素的位数</strong>：遮罩只读 alpha，灰度+Alpha 却要为每个像素写两个通道，其中一个谁也不看；调色板把「值」和「透明度」合成一个索引，4 级就是 2 位。整个仓库的样式合计 ${fmt(STYLES.reduce((sum, style) => sum + style.chars, 0))} 字符 —— 模块每次开页都要解析它，这就是样式数量的实际上限。</p>
  ${hostNote}

  <h2>插件注入的 CSS</h2>
  <p class="prose">只有一张，随插件载入常驻：<code>:root</code> 上的遮罩源、被 <code>@media</code> 门控的图标覆盖，以及设置行自己的样式。运行时要动的只有两个自定义属性 —— <code>--spinner-custom-size</code> 和 <code>--sc-mask</code>，后者只在切换样式时写一次，所以拖动滑块不会重复写 55 KB。</p>
  <pre id="out"></pre>
</main>

<script>
  var DEFAULT_SIZE = ${DEFAULT_SIZE}

  document.getElementById('out').textContent = ${JSON.stringify(
    dump('client.js 注入的那一张', pluginCss),
  )}

  // Per-style geometry, so the page can demonstrate the one behaviour that is
  // genuinely easy to get wrong: the size range belongs to the selected style.
  // Taken from the same region the plugin reads, not restated.
  var GEOMETRY = ${JSON.stringify(Object.fromEntries(
    region.artworks.map(artwork => [artwork.id, { edge: artwork.edge, defaultSize: artwork.defaultSize }]),
  ))}
  var DEFAULT_STYLE = ${JSON.stringify(FALLBACK.id)}
  var current = DEFAULT_STYLE
  function geom() { return GEOMETRY[current] || GEOMETRY[DEFAULT_STYLE] }

  var pluginRange = document.querySelector('.sc-range')
  var pageRange = document.getElementById('size')
  var reset = document.querySelector('.sc-reset')

  function setSize(px) {
    var g = geom()
    px = Math.min(g.edge, Math.max(${MIN_SIZE}, Math.round(px)))
    document.documentElement.style.setProperty('--spinner-custom-size', px + 'px')
    var readout = document.querySelector('.sc-readout')
    if (readout) readout.textContent = px + ' px'
    document.querySelectorAll('.sc-cell').forEach(function (el) {
      el.style.width = px + 'px'
      el.style.height = px + 'px'
    })
    if (pluginRange) pluginRange.value = String(px)
    if (reset) reset.disabled = px === g.defaultSize
    pageRange.value = String(px)
    document.getElementById('sizeRead').textContent = px + ' px'
  }

  // The picker in the captured row is static markup, so it is wired by hand —
  // the second thing on this page that imitates behaviour rather than running
  // it. Each tile already carries its own payload in --sc-art.
  var tiles = Array.prototype.slice.call(document.querySelectorAll('.sc-tile'))
  tiles.forEach(function (tile) {
    tile.addEventListener('click', function () {
      var id = tile.getAttribute('aria-label')
      if (id === current || !GEOMETRY[id]) return
      current = id
      tiles.forEach(function (other) {
        other.setAttribute('aria-checked', String(other.getAttribute('aria-label') === id))
      })
      var art = tile.style.getPropertyValue('--sc-art')
      if (art) document.documentElement.style.setProperty('--sc-mask', art)
      // Re-range before resizing: a size that was legal for the previous style
      // may not be for this one.
      var g = geom()
      if (pluginRange) pluginRange.max = String(g.edge)
      pageRange.max = String(g.edge)
      setSize(Math.min(pluginRange ? Number(pluginRange.value) : g.defaultSize, g.edge))
    })
  })

  pluginRange.addEventListener('input', function (event) {
    setSize(Number(event.target.value))
  })
  reset.addEventListener('click', function () { setSize(geom().defaultSize) })
  pageRange.addEventListener('input', function (event) {
    setSize(Number(event.target.value))
  })

  setSize(geom().defaultSize)

  document.getElementById('dark').addEventListener('change', function (event) {
    if (event.target.checked) document.body.setAttribute('data-dark', '')
    else document.body.removeAttribute('data-dark')
  })

  // Disabling a stylesheet means flipping its media, not hiding its element:
  // a <style> with display:none keeps applying. The probe in
  // tools/verify-chromium.mjs does the same thing to test the cascade.
  var pluginStyle = document.getElementById('plugin')
  document.getElementById('native').addEventListener('change', function (event) {
    pluginStyle.media = event.target.checked ? 'not all' : ''
  })
</script>
</body>
</html>
`

await writeFile(fileOf('preview.html'), html, 'utf8')
console.log(`row rendered from the plugin's own component (${rowHtml.length} chars of markup)`)
console.log(`captured ${pluginCss.length.toLocaleString()} chars of CSS in 1 sheet`)
console.log(`preview.html written: ${fmt(Buffer.byteLength(html))} bytes`)
