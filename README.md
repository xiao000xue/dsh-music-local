# dsh-music-local

DeepSeek Harness 的**本地音乐播放器**插件。把一个音乐根目录下的**每个子目录（树形，任意深度）当成一个播放列表**，直接流式播放，不改动、不转存、不读取音频文件头。

设计目标：**零 token 消耗**。

> 要求：DSH `>= 0.2.0`、Node `>= 20`。可选依赖 `ffmpeg`（仅 dts / dsd / ape 这类需要转码的格式用到）。


---

## 为什么是零 token

插件刻意**不**做下面任何一件事：

| 常见做法 | 本插件 |
| --- | --- |
| `ctx.tools.register(...)` 注册 `music_play` 之类的模型工具 | ❌ 不注册 |
| `ctx.systemPrompt.section(...)` 往系统提示里塞音乐库清单 | ❌ 不注入 |
| `inject: ['llm', 'tools', 'systemPrompt']` | ❌ 只 `inject: ['webServer']` |
| 把曲库内容塞进对话上下文 | ❌ 完全不进上下文 |

因此它**不会出现在模型的工具列表里，也不会撑大系统提示**。音乐库的浏览、搜索、播放、切歌全部发生在**浏览器半体 ↔ 宿主 HTTP 路由**之间，与 LLM 毫无关系。无论你放 38 首歌还是 3.8 万首歌，每轮对话的 token 开销都是 **0**。

---

## 安装

先在 profile 目录里把插件装成依赖（下面三种方式任选其一）。

**方式 A — 直接从 GitHub 装（推荐）**

```bash
cd "$DSH_HOME/profiles/desktop"
pnpm add github:xiao000xue/dsh-music-local
```

**方式 B — 已经有本地源码副本**

```bash
cd "$DSH_HOME/profiles/desktop"
pnpm add file:D:/dsh-plugins/dsh-music-local
```

**方式 C — 完全不用包管理器**

把本仓库整个目录复制到 `$DSH_HOME/profiles/desktop/node_modules/dsh-music-local`。
插件不依赖任何第三方运行时库，有 `lib/` 与 `cordis.patch.yml` 就能跑。

装好之后，在 profile 的 `package.json` 里把插件挂进 `bundles`，然后重启 DSH：

```jsonc
{
  "dependencies": {
    "dsh-music-local": "github:xiao000xue/dsh-music-local"   // ← ① 依赖（随安装方式而定）
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其它 bundle ...
        "dsh-music-local"                                     // ← ② 挂载
      ]
    }
  }
}
```

profile 位于 `$DSH_HOME/profiles/<profile名>/package.json`（桌面端通常是 `desktop`）。

插件自带的 `cordis.patch.yml` 会被自动读取（由 `package.json` 的 `dsh.bundle.patch` 声明），**无需手改 profile 的 patch 文件**。

> 用 `file:` 依赖时，`node_modules` 里是源目录的副本 —— 改了源码要重新 `pnpm install` 才生效。
> 想改一行看一行，直接用 `node_modules/dsh-music-local` 里那份改，或改用 junction/symlink。


---

## 使用

重启 DSH 后：

* **输入框下方**出现一条**播放条** —— 上一首 / 播放暂停 / 下一首 / 进度 / 音量 / 打开面板。
* 点右侧按钮展开**播放面板**（浮层，可拖动、可缩放，位置记在 `localStorage`）：
  * 左栏 = **树形歌单**：音乐根目录下的**每个子目录（任意深度）**都是一个歌单节点，
    ▸/▾ 逐层展开收起（展开状态记在 `localStorage`），歌单名右侧的数字是该文件夹（含子文件夹）的曲目数；
  * 右栏 = 选中歌单的曲目，支持搜索框过滤（在哪个歌单里搜就只搜它的子树）；
  * 点一行 = 播放（再点当前这首歌 = 播放/暂停），**双击 = 从头播放**；
  * 顶部 = 设置，可改音乐根目录、重扫。

面板里 `右键 / 悬停` 曲目可以看到解析出的「歌手 - 歌名」。

---

## 设置的存放位置

| 文件 | 内容 |
| --- | --- |
| `$DSH_HOME/music-local.json` | 音乐根目录、扫描开关等 |
| `$DSH_HOME/music-local-prefs.json` | 上次播放曲目、播放模式、音量 |

`$DSH_HOME` 即 DSH 的数据目录（桌面端由机器级环境变量 `DSH_HOME` 指定）。

---

## 格式支持

分成两条路：

**① 浏览器原生可播**（直接给出 `206 Partial Content` + `Range`，秒开、可任意拖动）

```
mp3  m4a  m4b  m4r  aac  flac  wav  ogg  oga  opus  webm
aif  aiff aifc alac  mp4  caf  3gp
```

**② 需要 ffmpeg 实时转码**（dts / dsd / ape 这类浏览器不认的格式）

```
dts  dff  dsf  ape  wma  asf  wv   tta  mpc  tak  ofr
ac3  eac3 amr  au   snd  mid  midi spx  m4p
mkv  avi  mov  flv  rm   rmvb wmv  mpg  mpeg ts  vob
```

转码走**管道**，不落盘：`ffmpeg -i <文件> -f s16le -`，边解边送。
已探到时长时会在上方拼一个**定长 WAV 头**，于是 `Range` 请求能换算成 `-ss 秒数`，**拖动进度条可用**；探不到时长则回退为流式 WAV（能播，但不能精确拖动）。

### ffmpeg 自动挑选

机器上可能装了好几份 `ffmpeg.exe`，其中不少是**精简版**（`--disable-everything`，只认识 mp4/mp3/flv），拿它转 dts 会直接 `Invalid data found when processing input`。

插件启动后会在常见位置搜 ffmpeg 并**打分**：

* `-muxers` 里有 `E s16le` → +4（能输出裸 PCM，转码才可用）
* `-demuxers` 里有 `dts` / `dsf` / `dff` / `ape` / `asf` / `avi` → 每项 +1

得分最高的那份才会被用来转码，且会被**真实解码验证**。找不到或只有精简版时，面板「设置」里会明确标注是 `完整版` / `精简版` / `未找到 ffmpeg`，第 ① 类格式依旧正常播放。

---

## 性能

* **扫描**：只解析文件名，**不读文件头**。3.8 万个文件约 **3 秒**。
* **缓存**：扫描结果常驻内存，只做一次；之后所有请求都是内存命中（`/manifest`、`/tracks` 从 ~3.2 s 降到个位数毫秒）。
* **列表渲染**：15k 行用原生 DOM + 分页（默认 300 条一页），不走 React 重渲染，滚动不掉帧。
* **曲名解析**：文件名里 `歌名-歌手` 与 `歌手-歌名` 混着来。用「**配对对象去重计数**」判定 —— 歌名只会配对到一个歌手，歌手会配对到很多歌名。比纯词频稳，能扛住「车载合辑里大量重名文件」这种脏数据。

---

## HTTP 路由一览

宿主半体注册在前缀 `/dsh-music-local` 下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/config` | 根目录、曲库统计、ffmpeg 探测状态 |
| POST | `/config` | 改根目录并重扫 |
| GET | `/manifest` | 播放列表 + 曲目清单（紧凑编码） |
| POST | `/rescan` | 强制重扫 |
| GET | `/tracks` | 分页取曲目（`?ids=1` 取 id 列表，`?q=` 过滤） |
| GET | `/track` | 单曲详情 |
| GET | `/browse` | 浏览目录（用于设置里选根目录） |
| GET | `/probe` | 探测时长 |
| GET | `/stream/<id>` | 音频流（支持 `Range`；转码轨用 `?t=<秒>&d=<时长>`） |
| GET/POST | `/prefs` | 播放偏好读写 |

---

## 已知限制

* 转码轨的精确拖动依赖「能探到时长」，个别损坏文件的时长探测会失败，此时该曲不能精确 seek。
* 精简版 ffmpeg 只能转 mp4/mp3 类，第 ② 类格式会播不了 —— 面板会提示，放一份完整版 ffmpeg 到常见路径即可。
* 播放器不使用音频可视化（`createMediaElementSource` 在 DSH 里会导致静音），这是有意的取舍。

---

MIT
