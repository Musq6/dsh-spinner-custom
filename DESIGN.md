# 设计与实现

这份文档给要改代码、或者想深入了解为什么这样做的人。用法、安装、注意事项都在
[README.md](README.md)。

## 内嵌进 `client.js` 的那一块是怎么编排的

载荷不是随手插在文件某处，而是被限制在**一段有名字的生成区**里：

```js
// ===================== generated: the artwork ==========================
// … 这一整块由 tools/embed-asset.mjs 重建，手写的内容下次会被覆盖 …
const ARTWORKS = [
  { id: 'comet-ring', edge: 160, defaultSize: 80, art: '<base64>' },
  …
]
const FALLBACK_ART = 'comet-ring'
// ===================== end generated ===================================
```

- **两个横幅之间是工具的财产，横幅之外是人的。** 重写时只换区间内的字符，区间外的部分
  逐字节原样搬过去——工具永远不会碰它不理解的代码。
- **判据是「两个横幅之间的字符」，不是「某一行」。** 匹配某几个 `const` 再替换的写法，
  要求它们永远相邻；整块重建之后，注释、常量、顺序都由工具自己决定。
- **`edge` 和 `defaultSize` 住在里面。** 它们是素材的属性（边长、边长一半），换素材就该
  跟着变。留在生成区外，就会出现「换了图但天花板还是旧的」这种够不到的范围。
- **`MIN_SIZE` 必须住在外面。** 14px 是**宿主的**边长，是关于应用的事实。放在生成区里，
  换一张图就会把它一起改掉。
- **空列表是正常状态。** `--clear` 故意产出它，用来构建一棵不含素材的树。此时插件在
  `apply()` 开头直接退场。
- **载荷在样式表里只出现一次。** `:root` 上的 `--sc-mask`（默认样式）被图标、预览台
  两处 `var()` 引用；选择器的小图各自带一份 `--sc-art`，但那些本来就在模块里。

区域格式唯一权威是 **`tools/region.mjs`**：`renderRegion()` 写、`parseRegion()` 读，
`embed-asset.mjs` 和四个读方（`check-embed` / `check-plugin` / `build-preview` /
`verify-chromium`）共用它。**parse 之后再 render 必须逐字节等于原文**，改格式时它第一个报警。

## 为什么要放大图标

宿主原生的图标是 **14px**，而且带 `contain: strict; overflow: hidden`。默认素材是
160×160、环带约 19px 宽、软边约 2px。装进 14px 的盒子，源图要被压到 `160/14 ≈ 11.4`
分之一的线性尺度上——**一个输出像素要盖住约 130 个源像素**，19px 的环带落到不到 2 个
输出像素宽，2px 的软边直接没了。结果就是一坨色块。

| 边长 | 一个输出像素盖住多少源像素 | 结果 |
| --- | --- | --- |
| 14px（宿主原生） | ≈ 130 | 环带不到 2 个输出像素，只剩一团色块 |
| 40px | ≈ 16 | 能看出是个环，细节还不成形 |
| **80px（默认）** | 2 倍屏上 1:1 | 画成什么样就是什么样 |
| 160px | 开始放大 | 更清楚，但状态行更高，而且是在插值 |

所以推荐值是 **80**，素材是它的 2 倍图（160×160）。**这就是为什么大小是设置项而不是
常量**：这个取舍只有用的人自己知道。

## 为什么素材是调色板 PNG

遮罩只读 alpha 通道，所以灰度+Alpha 的 PNG 有一半字节花在没人看的亮度面上。改成
**索引色 + tRNS**（PNG 色彩类型 3），同一组帧（160×160 / 60 帧 / 15fps）实测：

| 编码 | 体积 |
| --- | --- |
| 灰度+Alpha 8bpp | 299,653 B |
| 调色板 8bpp（256 级 alpha） | 216,343 B |
| 调色板 4bpp（16 级 alpha） | 88,476 B |
| **调色板 2bpp（4 级 alpha）** | **40,929 B** ← 默认 |

4 级和 16 级在 80px（实际显示的尺寸）下看不出区别，所以取小的。到 160px 时台阶看得见，
但读起来像一圈刻意的分段环，不像坏了。注意 `--levels 4` 是 **4 级 alpha、2bpp**；
`16` 才是 4bpp，`256` 是 8bpp。

调色板刻意做成**灰度**的（第 i 项颜色 `(v,v,v)`、alpha 也是 `v`）：按 alpha 遮罩和按
亮度遮罩结果完全一致，万一引擎选了另一种模式也不会坏。

## 为什么必须内联

浏览器半不能 import 也不能 fetch 同级资源，这不是偷懒：

- `/plugins` 路由只应答入口脚本和 `client.<名字>.js` 分片，PNG 之类的静态文件一律 404。
- `dsh-resource://` 是给 React 钩子读的**页内值**，浏览器根本不会去 fetch 这个 URL。

所以动画只能作为 data URI 内联进模块源码，**体积因此是硬约束**——这也是为什么默认
素材要从 299,653 B 压到 40,929 B。也因此 `asset/` 只是源料，不参与运行：装进应用的是
`client.js` 里那份内联副本，往 `asset/` 里丢一张新图不会自己生效，必须跑一次
`embed-asset.mjs`。

## 内置样式

七个，全部由 `tools/make-placeholder.py --shape <name>` 画出来（纯标准库、无随机数、
不读时钟，逐字节可复现）。文件名就是样式 id：

| 文件 | 形变 | PNG | 内联后（base64） |
| --- | --- | --- | --- |
| `comet-ring-…2bpp.png` | 拖着尾巴的环，中心随呼吸明暗 ← 默认 | 40,929 B | 54,572 字符 |
| `cross-…2bpp.png` | 两根短棒伸长融合成十字，再分开 | 28,508 B | 38,012 字符 |
| `cutout-…2bpp.png` | 实心圆盘 ⇄ 圆环 | 33,986 B | 45,316 字符 |
| `dots-…2bpp.png` | 25 个点在网格与圆环之间往返 | 49,219 B | 65,628 字符 |
| `fold-…2bpp.png` | 三角穿过自己的中心翻折 | 21,353 B | 28,472 字符 |
| `rounding-…2bpp.png` | 方块 ⇄ 圆 | 36,900 B | 49,200 字符 |
| `spiral-…2bpp.png` | 圆环解开发条，再绕回去 | 45,336 B | 60,448 字符 |

（文件名后缀一律 `-160x160-15fps-2bpp`。）合计 **341,648 字符**，占 `client.js` 的主要
部分——这是样式数量的实际上限。

**为什么配的是生成器而不是只有 PNG。** 「这张图不来自任何第三方片段」是一个关于出处的
声明，一句保证本身没有意义；换成「画它的脚本在这个仓库里」，声明就变成一条**跑得出来的
断言**：同一份 Python、同样的参数，输出逐字节相同。使用者可以自己验，不用信作者。

**两条循环约束**，每个形状都要守：phase 0 和 phase 1 必须同姿态（或差一个形状自身的
对称角），否则每圈眨一下；轮廓必须留边距（遮罩按 `center / 100% 100%` 拉伸，贴边会被
压平）。

## 校验链与各工具

改完 `client.js` 或 `tools/` 之后跑这一串，全绿才算过：

```sh
node --check client.js
node tools/check-embed.mjs      # 内联工具自身，60 条
node tools/check-plugin.mjs     # 浏览器半的行为，101 条
node tools/build-preview.mjs    # 重建 preview.html
node tools/verify-chromium.mjs --shot preview.html:preview.png --wait 2200 --probe
```

这条链是接力，不是四个独立脚本：

```
asset/*.png
    │  embed-asset.mjs          校验 + 内联 + 每个样式带自己的几何
    ▼
client.js ──────────► check-plugin.mjs       断言浏览器半的行为（离线 harness）
    │
    │  build-preview.mjs        渲染插件自己注册的组件，不是手抄标记
    ▼
preview.html ───────► verify-chromium.mjs    在真实 Chrome 里验收
```

| 文件 | 作用 |
| --- | --- |
| `tools/png-meta.mjs` | 走一遍 PNG 的 chunk，读出 IHDR / acTL / tRNS / 首个 fcTL；不碰像素 |
| `tools/region.mjs` | **生成区的格式权威**：写与读共用，两边不会各读各的 |
| `tools/embed-asset.mjs` | **校验并把素材内联进生成区**，每个样式带自己的几何 |
| `tools/check-embed.mjs` | 断言内联工具自己（60 条，素材在内存里现造） |
| `tools/harness.mjs` | `check-plugin` 与 `build-preview` 共用的 sandbox：最小 React 与 store 替身 |
| `tools/check-plugin.mjs` | 断言浏览器半的行为（101 条） |
| `tools/verify-chromium.mjs` | 用 Chromium 自己的解码器验收，可选截图与样式探针 |
| `tools/build-preview.mjs` | 由 `client.js` 生成 `preview.html` |
| `tools/make-placeholder.py` | 画样式的原始灰度帧，`--shape` 选形状 |
| `tools/build-spinners.sh` | 重建整套内置样式：上面那个 + `apng-palette.py` |
| `tools/apng-palette.py` | 由裸灰度帧组装调色板 APNG；也能 `info` / `dump` 单帧 |
| `tools/build-asset.sh` | 视频 → 素材的完整管线（ffmpeg + 上面那个） |

几个值得知道的点：

- **`png-meta.mjs` 单独一个文件**：`embed-asset`（判断能不能内联）和 `build-preview`
  （报告每个样式的代价）都要读同一批字段，两份实现就是两次机会对「这个文件是什么」产生
  分歧。
- **`check-embed` 在内存里现造 PNG**（自己算 CRC），所以不需要往仓库塞十几个坏文件。
  跑之前把 `client.js` 备份到 `client.js.check-embed-backup`，`finally` 里还原。
- **`check-plugin` 断言可观测行为**，不比对源码文本。尺寸域是从 `client.js` 读出来的，
  不是写死的。替身只有两个：React 缩到 `createElement`；store 按文档化契约重写（其中
  `update` 是 **void draft mutator**，返回值会被丢弃——写 `update(state => ({...state, x}))`
  是无声的空操作，这条曾经是个真 bug）。
- **`verify-chromium` 里没有一个关于素材的数字是写死的**：帧数、边长、循环来自素材自己的
  `acTL`/`IHDR`，尺寸域来自 `client.js` 的区域。连要解码哪个文件都是算出来的——扫
  `asset/` 顶层找 base64 与内联载荷逐字符相同的那张。
- **静图伪装成动图会被抓住**：所有帧都一样的 APNG 会在 `frames are pixel-identical`
  上失败，截图看不出这个差别。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | 组合包清单：`dsh.bundle.patch` + `dsh.client`（web 半） |
| `cordis.patch.yml` | 把本包插入 profile 的 Loader 树 |
| `index.js` | 宿主半，空实现 |
| `client.js` | 浏览器半：内联样式 + 覆盖样式 + 设置行（改这里） |
| `asset/*.png` | 素材源料；文件名决定样式 id（**不随安装分发**） |
| `asset/README.md` | 素材这一层的规矩：什么能放、怎么命名 |
| `tools/*` | 生成、校验、内联、验收、预览 |
| `preview.html` / `preview.png` | 预览页（生成物，勿手改，不进版本库） |
| `locale/*.json` | 插件页显示用的标题与描述 |

`preview.html` / `preview.png` 是本地构建的产物，`.gitignore` 里已经排掉——它们可能带着
隔壁 harness 检出的字节，不该进公开仓库。

`package.json` 的 `files` 只列 `index.js`、`client.js`、`cordis.patch.yml`、
`locale/*.json`——安装进 profile 的就是这四样，`asset/`、`tools/` 留在仓库里。

## 想改名 / fork

`@local/spinner-custom` 这个名字在五个地方出现，改名要一起改，否则装上去会对不上：

| 位置 | 是什么 |
| --- | --- |
| `package.json` → `name` | 包名 |
| `cordis.patch.yml` → `name` | 同一个名字，安装器按它解析 |
| `client.js` → `load({ id })` | 运行时模块 id |
| `client.js` → `data-spinner-custom` | 样式表标签，探针靠它认人 |
| `client.js` → `NS` / `SETTINGS_KEY` / `--spinner-custom-size` | 文案命名空间、存储键、CSS 变量 |
