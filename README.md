# @dsh/spinner-custom

## 这是什么

一个 DeepSeek Harness UI 插件：把「深度求索中，用时 xx 秒」那一行里的小图标换成会动的样式，并可在「设置 → 通用」里随时换样式、调大小。支持导入文件自定义。

<img width="872" height="481" alt="preview" src="https://github.com/user-attachments/assets/a43c203c-d82c-48a8-8e5f-3f68fe961873" />


- **8 个内置样式**：拖尾环、十字、圆环、点阵、折纸、圆角、发条，外加一个方块⇄圆的动画 ，设置里一键切换
- **换成你自己的动画**：丢一张动画 SVG 或 APNG 进 `asset/`，跑一条命令；也能从视频转
- **大小可调**：14px ～ 样式上限，默认 80px（2 倍图下一比一，最清楚）
- **即改即存**：改完立即生效，记在本机，重启还在
- **卸载即还原**：样式表一撤，宿主的图标和动画原样回来

想先看实物：`node tools/build-preview.mjs` 生成 `preview.html`（设置行真身、尺寸阶梯、体积对照）。

## 怎么使用

### 安装

1. 拿到本目录的**绝对路径**（安装器只认绝对路径）
2. 「插件 / Plugins」→「添加插件」填入路径；或让 Agent 调
   `plugin_manager { action: "install_bundle", target: "<绝对目录>" }`
3. 返回 `applied` 即生效；`restart-required` 就重启进程
4. 设置 → 通用 → 最下面的「运行图标」

只装不换素材的话什么都不用装（`client.js` 里已经内联好了）；换素材需要 Node 18+，从视频转还要 ffmpeg 和 Python 3。

> 替换已装版本后**必须重启进程**，否则浏览器继续用旧的 JS 模块，表现是「改了没反应」。

### 设置行

| 控件     | 说明                   |
| ------ | -------------------- |
| 预览台（左） | 当前样式按当前尺寸的真实像素       |
| 样式选择器  | 一排缩略图，点一下切换          |
| 大小滑块   | 14px ～ 该样式素材的边长，步长 1 |
| 恢复默认   | 回到该样式自己的推荐值（素材边长的一半） |

默认 80px。范围跟着所选样式走：上限是它自己素材的边长，推荐值是边长的一半。「恢复默认」之后换样式，每个样式给出它自己的默认值。

也可以用控制台钩子临时试：

```js
__spinnerCustom.state()          // { art, size, px }
__spinnerCustom.style('spiral')  // 按 id 选样式
__spinnerCustom.size(56)         // 夹住范围并写入
__spinnerCustom.reset()          // 回到当前样式的推荐值
```

### 换成你自己的动画

**最省事的一条路：动画 SVG。** 把文件丢进 `asset/`，内联一次：

```sh
cp 你的动画.svg asset/
node tools/embed-asset.mjs
```

要求：正方形 `viewBox`、自带动画（SMIL 或 SVG 内的 CSS 动画）、不引用外部文件、不带脚本。不达标会被拒绝并逐条说明原因。

APNG 的路：把文件放进 `asset/`，然后内联一次：

```sh
node tools/embed-asset.mjs        # 内联 asset/ 里的全部样式
```

样式 id 取自文件名（`-160x160` 之前那段），文件叫什么，选择器里就叫什么。

素材不是这种格式时，三条路：

```sh
# 已经是调色板 APNG（色彩类型 3）—— 内联指定的这一个
node tools/embed-asset.mjs asset/你的图.png --default=56

# 一张普通 APNG —— 抽出 alpha，再装进调色板
ffmpeg -v error -i 你的图.png -vf "format=rgba,alphaextract" -f rawvideo -pix_fmt gray frames.raw
python tools/apng-palette.py build --raw frames.raw --w 160 --h 160 --fps 10 --levels 4 --out asset/你的图.png
node tools/embed-asset.mjs

# 一段视频 —— 增益和裁剪要为自己的片子调
bash tools/build-asset.sh 你的视频.mp4 160 10 5.0 4 asset/你的图.png
node tools/embed-asset.mjs
```

内联是**声明式**的：给路径就是恰好这些样式（替换整个列表），不给路径就是 `asset/` 里的全部。**加样式**就丢进 `asset/` 再跑无参命令；**只留自己那个**就直接写它的路径。

改完跑一遍校验：

```sh
node tools/check-embed.mjs && node tools/check-plugin.mjs && node tools/build-preview.mjs
```

重建内置样式：`bash tools/build-spinners.sh`（可传形状子集，如 `fold spiral`）。

## 注意细节

**素材要求**（`embed-asset.mjs` 逐条检查，不合格直接拒绝）：

| 要求                                    | 为什么                 |
| ------------------------------------- | ------------------- |
| PNG 且是 APNG（有 `acTL`）                 | 静图就是宿主已有的东西         |
| 色彩类型 3（索引色）、位深 2 或 4                  | 遮罩只读 alpha，位深越高越浪费  |
| 正方形                                   | 图标盒是方的，非方会变形        |
| 边长 32–512px                           | 再小没东西可采样，再大就不是状态栏图标 |
| 内联后 < 500,000 字符（提示）/ < 2,000,000（拒绝） | 模块每次开页都要解析          |

**其它要知道的**：

- 从没装进过真实 profile，全部验证是离线 harness + 无头 Chromium；装进应用之后的表现只能真的装一次才知道
- 图标那一半不是官方扩展点，靠样式覆盖实现——宿主改 DOM 就可能失效，表现是没变化、不报错
- 开了**减弱动效**或**高对比模式**的用户看到的是宿主原生 14px 图标，这是有意保留
- 那一行会被撑高（图标盒 80px），设置里改小即可
- 设置只在 zh / en 有文案，其它语言显示键名但不报错
- 设置**按 origin 存**：换域名回到默认；卸载后 localStorage 里的值会留下
- 不方便公开的素材放 `asset/local/`（已被 gitignore），规矩写在 `asset/README.md`
- 许可是 **MIT**（见 `LICENSE`）；内置素材同为该许可，换成你自己的素材由你决定

设计取舍、实现细节与各工具说明见 **[DESIGN.md](DESIGN.md)**。
