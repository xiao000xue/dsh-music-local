/**
 * dsh-music-local —— 宿主端（Host half）
 *
 * 一个"零 token"的本地音乐库后端：不注册任何模型工具、不注入系统提示、
 * 不调用任何 LLM —— 因此对每次对话的 token 开销恒为 0。全部能力都通过
 * /dsh-music-local/* 这组 HTTP 路由暴露给浏览器端播放器自己使用。
 *
 * 职责：
 *   1. 扫描音乐根目录（默认 G:\music），把**每个顶层文件夹**归为一个"列表"
 *   2. 由文件名解析 歌手/歌名 —— 不打开音频文件，所以 3.8 万首也能秒级扫完
 *   3. 音频流式播放：浏览器原生格式直接吐字节（Range 支持 seek）；
 *      其余（dts/dff/dsf/ape/wma/视频容器…）交给 ffmpeg 实时转码成 PCM 流
 *   4. 配置与播放偏好落盘，重启不丢
 *
 * 扫描全程异步 + 分批，不阻塞事件循环。所有注册都是 effect，卸载时干净回收。
 */

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import os from 'node:os'

export const name = 'dsh-music-local'
// 只依赖 webServer —— 不 inject llm / tools / systemPrompt，从根上杜绝 token 消耗
export const inject = ['webServer']

// ---------------------------------------------------------------- 格式表

// 浏览器 <audio> 可直接解码（Electron/Chromium 内核）
const NATIVE = new Set([
  'mp3', 'm4a', 'm4b', 'm4r', 'aac', 'flac', 'wav', 'wave', 'ogg', 'oga', 'opus',
  'webm', 'aif', 'aiff', 'aifc', 'alac', 'mp4', 'caf', '3gp',
])
// 需要 ffmpeg 实时转码
const NEEDS_FFMPEG = new Set([
  'dts', 'dff', 'dsf', 'ape', 'wma', 'asf', 'wv', 'tta', 'mpc', 'tak', 'ofr',
  'ac3', 'eac3', 'amr', 'au', 'snd', 'mid', 'midi', 'spx', 'm4p',
  'mkv', 'avi', 'mov', 'flv', 'rm', 'rmvb', 'wmv', 'mpg', 'mpeg', 'ts', 'vob',
])
const AUDIO_EXT = new Set([...NATIVE, ...NEEDS_FFMPEG])

const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', m4r: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', wave: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
  aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff', alac: 'audio/mp4',
  mp4: 'audio/mp4', caf: 'audio/x-caf', '3gp': 'audio/3gpp',
}

// 由扩展名直接给出的「编码 / 档位」（零 IO，扫描时不做任何文件读取）
const CODEC_OF = {
  flac: ['FLAC', '无损'], wav: ['WAV', '无损'], wave: ['WAV', '无损'],
  aiff: ['AIFF', '无损'], aif: ['AIFF', '无损'], aifc: ['AIFF', '无损'],
  alac: ['ALAC', '无损'], ape: ['APE', '无损'], dff: ['DSD', '无损'],
  dsf: ['DSD', '无损'], dts: ['DTS', '无损'], wv: ['WV', '无损'], tta: ['TTA', '无损'],
  tak: ['TAK', '无损'], ofr: ['OFR', '无损'],
  mp3: ['MP3', '有损'], m4a: ['AAC', '有损'], m4b: ['AAC', '有损'], aac: ['AAC', '有损'],
  wma: ['WMA', '有损'], asf: ['WMA', '有损'], ogg: ['OGG', '有损'], oga: ['OGG', '有损'],
  opus: ['Opus', '有损'], spx: ['Speex', '有损'], m4r: ['AAC', '有损'],
  caf: ['CAF', '有损'], amr: ['AMR', '有损'], au: ['AU', '有损'], snd: ['AU', '有损'],
  ac3: ['AC3', '有损'], eac3: ['EAC3', '有损'], mpc: ['MPC', '有损'], m4p: ['AAC', '有损'],
  mp4: ['MP4', '音视频'], '3gp': ['3GP', '音视频'], avi: ['AVI', '音视频'],
  mkv: ['MKV', '音视频'], mov: ['MOV', '音视频'], flv: ['FLV', '音视频'],
  wmv: ['WMV', '音视频'], rm: ['RM', '音视频'], rmvb: ['RMVB', '音视频'],
  mpg: ['MPG', '音视频'], mpeg: ['MPG', '音视频'], ts: ['TS', '音视频'], vob: ['VOB', '音视频'],
  mid: ['MIDI', '—'], midi: ['MIDI', '—'],
}

const SCAN_MAX_DEPTH = 8
const PAGE_MAX = 1000
const STAT_BATCH = 400

// 曲目的对外表示（刻意压短键名：3.8 万条 id 列表也要保持轻量）
const toItem = (t) => {
  const c = CODEC_OF[t.ext] || [t.ext.toUpperCase() || '?', '—']
  return {
    i: t.id, f: t.file, a: t.artist, n: t.title, e: t.ext,
    c: c[0], q: c[1], s: t.size,
    x: NEEDS_FFMPEG.has(t.ext) ? 1 : 0,
  }
}

// ---------------------------------------------------------------- 纯函数

const extOf = (p) => { const i = p.lastIndexOf('.'); return i > 0 ? p.slice(i + 1).toLowerCase() : '' }

// 稳定短 id：由"相对路径"哈希而来，重扫后不变 → "上次播放"能跨重启恢复。
// 客户端只持有这种不透明 id，真实路径不出网，天然免疫路径穿越。
function hashId(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// 去掉扩展名、开头的曲序（01. / 0001- / 【01】 / 001名字），并剥掉开头的分类标签。
function cleanBase(file) {
  let base = file.replace(/\.[^.]+$/, '')
  base = base.replace(/^\s*[\[(（【]?\d{1,3}[\])）】]?\s*[.\-_、 ]+\s*/, '')
  // 「001刘艺雯」这种序号直接贴着名字的写法：只吃 2 位以上数字，避免误伤 911 这类乐队名
  base = base.replace(/^\d{2,4}(?=[^\d\s.])/, '')
  return base.trim()
}
// 剥掉开头的分类标签（【视频MV】/ [HQ] / 「3D环绕」/ （DJ版）），但**只在标签后面还有内容时**才剥：
// 「【3D环绕 - 稻香】」这种整个歌名被括号包住的不动。
function stripTag(base) {
  return base.replace(/^(?:【[^】]{0,12}】|\[[^\]]{0,12}\]|「[^」]{0,12}」|（[^）]{0,12}）)\s*(?=\S)/, '').trim()
}
// 去掉包裹在两侧的书名号/引号，只用于展示，不用于统计比对。
// 「《加州旅馆》Hotel California」这种「书名号里是中文名、后面跟原名」的写法，
// 前半段整体去掉更像歌名。
// ⚠️ 剥括号必须判成对：否则「Ailee_I_will_show_you(给你看)」的右括号会被当尾巴切掉，
//    变成「Ailee_I_will_show_you(给你看」。只在**开闭数量不对等**时才剥。
const OPEN_CLOSE = [['《', '》'], ['「', '」'], ['『', '』'], ['【', '】'], ['（', '）'], ['(', ')'], ['[', ']']]
const cntOf = (s, ch) => s.split(ch).length - 1
function tidySide(s) {
  let t = String(s).trim()
  t = t.replace(/^《[^》]{1,30}》\s*(?=\S)/, '')
  for (let round = 0; round < 3; round++) {
    let changed = false
    for (const [a, b] of OPEN_CLOSE) {
      // 整串正好被一对括号包住 → 脱掉这层
      if (t.length > a.length + b.length && t.startsWith(a) && t.endsWith(b) && cntOf(t, a) === cntOf(t, b)) {
        t = t.slice(a.length, t.length - b.length).trim(); changed = true; continue
      }
      // 开闭数量不对等 → 开头/结尾那个是多余的，只剥它一个
      if (t.length > a.length && t.startsWith(a) && cntOf(t, a) > cntOf(t, b)) { t = t.slice(a.length).trim(); changed = true; continue }
      if (t.length > b.length && t.endsWith(b) && cntOf(t, b) > cntOf(t, a)) { t = t.slice(0, t.length - b.length).trim(); changed = true }
    }
    if (!changed) break
  }
  return t.trim()
}

// 文件名切分成 左/右 两侧（有分隔符时）；否则为 null。
// ⚠️ 分隔符要允许连着写多个：本库里「《大雨淋湿我吧》--王富贵」这种双横线很常见，
//    只吃一个横线会把剩下的那个留在右侧，变成歌手叫「-王富贵」。
//    两侧还常垫下划线（AOA_-_动摇），一并吃掉，但只吃**紧贴横线**的那些，
//    免得把 Ailee_I_will_show_you 这种名字里的下划线也切了。
const SEP = /^(.{1,40}?)[_\s]*[-–—－~～]{1,3}[_\s]*(.{1,60})$/
function parseSides(file) {
  const base = cleanBase(file)
  const core = stripTag(base)
  const m = SEP.exec(core)
  if (m === null) return { base: core, left: null, right: null }
  return { base: core, left: m[1].trim(), right: m[2].trim() }
}

// 本库的命名习惯是混的：既有「歌名-歌手」也有「歌手-歌名」（实测两种都大量存在），
// 所以不做位置假设。判据用**不同配对的数量**而不是出现次数 —— 因为这位用户的
// 多个车载合集里有大量重名文件，同一个「歌名-歌手」会整份重复出现几十次，
// 单看次数两边都"高频"，完全失效。而歌手会跟**许多不同的歌名**配对，
// 歌名基本只跟唯一一个歌手配对，于是「配对种类多的一侧 = 歌手」非常稳。
// 对于两侧都只出现一次的孤立样本，再用**全库统计出来的位置偏好**兜底。
function buildNameResolver(files) {
  const pairs = []                       // [left, right] 或 null
  const leftPartners = new Map()         // 左侧 → 它配对过的不同右侧集合
  const rightPartners = new Map()        // 右侧 → 它配对过的不同左侧集合
  const leftFreq = new Map()
  const rightFreq = new Map()
  const addTo = (m, k, v) => {
    let s = m.get(k)
    if (s === undefined) { s = new Set(); m.set(k, s) }
    s.add(v)
  }
  for (let i = 0; i < files.length; i++) {
    const p = parseSides(files[i].name)
    if (p.left === null) { pairs.push(null); continue }
    pairs.push([p.left, p.right])
    addTo(leftPartners, p.left, p.right)
    addTo(rightPartners, p.right, p.left)
    leftFreq.set(p.left, (leftFreq.get(p.left) || 0) + 1)
    rightFreq.set(p.right, (rightFreq.get(p.right) || 0) + 1)
  }
  const kinds = (m, k) => (m.has(k) ? m.get(k).size : 0)
  const freq = (m, k) => m.get(k) || 0

  // 全库位置偏好：能明确判定时投一票，看这个库整体更偏「歌名-歌手」还是「歌手-歌名」
  let leftIsTitle = 0, rightIsTitle = 0
  for (let i = 0; i < pairs.length; i++) {
    const pr = pairs[i]
    if (pr === null) continue
    const lk = kinds(leftPartners, pr[0]), rk = kinds(rightPartners, pr[1])
    if (lk === 1 && rk > 1) leftIsTitle++
    else if (rk === 1 && lk > 1) rightIsTitle++
  }
  // 偏「歌名-歌手」⇒ 右侧更可能是歌手
  const preferRightAsArtist = leftIsTitle >= rightIsTitle

  return (i) => {
    const base = parseSides(files[i].name).base
    const pr = pairs[i]
    if (pr === null) return { artist: '', title: tidySide(base) }
    const [L, R] = pr
    const lk = kinds(leftPartners, L)
    const rk = kinds(rightPartners, R)
    // 一侧只跟唯一对象配对 → 它是歌名，另一侧是歌手
    if (lk === 1 && rk > 1) return { artist: tidySide(L), title: tidySide(R) }
    if (rk === 1 && lk > 1) return { artist: tidySide(R), title: tidySide(L) }
    if (lk === 1 && rk === 1) {
      // 两边都只出现过一次 → 先看次数（重名副本会让次数拉开），再退回全库位置偏好
      const lf = freq(leftFreq, L), rf = freq(rightFreq, R)
      if (rf > lf) return { artist: tidySide(R), title: tidySide(L) }
      if (lf > rf) return { artist: tidySide(L), title: tidySide(R) }
      return preferRightAsArtist
        ? { artist: tidySide(R), title: tidySide(L) }
        : { artist: tidySide(L), title: tidySide(R) }
    }
    // 两侧都跟很多对象配对 → 真歧义，整体当歌名（仍可搜到）
    return { artist: '', title: tidySide(base) }
  }
}

// ---------------------------------------------------------------- 插件

export function apply(ctx) {
  const DSH_HOME = (process.env && process.env.DSH_HOME) || join(os.homedir(), '.dsh')
  const CONFIG_FILE = join(DSH_HOME, 'music-local.json')
  const PREFS_FILE = join(DSH_HOME, 'music-local-prefs.json')

  const DEFAULT_ROOT = existsSync('G:\\music') ? 'G:\\music' : join(os.homedir(), 'Music')

  const readJson = (file, fallback) => {
    try { return { ...fallback, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { return { ...fallback } }
  }
  const writeJson = (file, data) => {
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2), 'utf8') } catch { /* 忽略 */ }
  }

  let config = readJson(CONFIG_FILE, { root: DEFAULT_ROOT, ffmpeg: '' })
  let prefs = readJson(PREFS_FILE, { volume: 0.8, mode: 'order', lastId: '', lastPos: 0, panel: null, favs: [] })

  let playlists = []          // 平铺的全部歌单节点 [{ id, name, count, bytes }]（不含根容器，供校验/查名）
  let tree = null             // 嵌套树 { id, name, count, children: [] }，根容器本身；每个子目录 = 一个节点
  let index = new Map()       // id -> track
  let folderSub = new Map()   // folderId -> 该文件夹（含全部子孙文件夹）的曲目，已按自然序
  let allTracks = []          // 全部曲目（= 树的先序遍历），对应虚拟列表 __all__
  let scannedAt = 0
  let scanMs = 0
  let scanPromise = null
  let scanDone = false

  // ---- ffmpeg 选型 ----
  //
  // 本机实测的教训：机器上装了 4 个 ffmpeg.exe，其中 3 个是**精简版**
  // （构建时 --disable-everything，只留 mp4/mp3/flv，连 wma 和 avi 都打不开），
  // 只有 1 个是完整版。所以"找到 ffmpeg.exe"毫无意义，必须**探测能力**：
  //   · 能否输出裸 PCM（s16le 复用器）        → 决定能不能做无缝 Range/seek
  //   · 是否认得 dts / dsf / dff / ape 解复用器 → 决定冷门格式能不能播
  // 探测结果异步缓存；选到最合适的那个，并把路径写回配置，下次直接命中。
  let ffmpegSel = null        // { bin, dir, probe, canPcm }
  let ffmpegSelPromise = null
  let ffmpegTried = []        // 诊断用：都试过谁、得分多少

  function runCapture(bin, args, timeoutMs) {
    return new Promise((done) => {
      let out = ''
      let child
      try { child = spawn(bin, args, { windowsHide: true }) } catch { done({ out: '', failed: true }); return }
      let settled = false
      const fin = (r) => { if (settled) return; settled = true; done(r) }
      child.stdout.on('data', (d) => { if (out.length < 400000) out += d.toString() })
      child.stderr.on('data', (d) => { if (out.length < 400000) out += d.toString() })
      child.on('error', () => fin({ out: '', failed: true }))
      child.on('close', () => fin({ out, failed: false }))
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* noop */ } fin({ out, failed: true }) }, timeoutMs || 8000)
    })
  }

  async function scoreBinary(bin) {
    const [mux, dem] = await Promise.all([
      runCapture(bin, ['-hide_banner', '-muxers']),
      runCapture(bin, ['-hide_banner', '-demuxers']),
    ])
    if (mux.failed && dem.failed) return { bin, score: -1, canPcm: false, rare: [] }
    const canPcm = /^\s*E\s+s16le\b/m.test(mux.out)
    const rare = ['dts', 'dsf', 'dff', 'ape', 'asf', 'avi']
      .filter((k) => new RegExp('^\\s*D\\s+' + k + '\\b', 'm').test(dem.out))
    // 能出裸 PCM 最重要（决定 seek），其次冷门格式覆盖度
    return { bin, score: (canPcm ? 4 : 0) + rare.length, canPcm, rare }
  }

  const existsFile = (p) => { try { return !!p && existsSync(p) } catch { return false } }

  // 兜底发现：按盘符做有界 BFS（深度 ≤ 4，跳过系统目录），找出所有 ffmpeg.exe。
  // 只在常见位置都没找到合适的时才跑，全程异步、有硬上限。
  async function discoverBinaries() {
    const SKIP = /^(windows|winsxs|driverstore|system32|syswow64|\$recycle\.bin|system volume information|node_modules|\.git|appdata|programdata|assembly|servicing|installer|winsxs)$/i
    const found = new Set()
    const roots = []
    for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const d = L + ':\\'; if (existsSync(d)) roots.push([d, 0]) }
    let level = roots
    let visited = 0
    const t0 = Date.now()
    while (level.length > 0 && visited < 8000 && Date.now() - t0 < 7000) {
      const next = []
      for (let i = 0; i < level.length; i += DIR_CONC) {
        const batch = level.slice(i, i + DIR_CONC)
        const res = await Promise.all(batch.map(async ([d, depth]) => {
          const keep = []
          let es
          try { es = await fsp.readdir(d, { withFileTypes: true }) } catch { return keep }
          visited++
          for (const e of es) {
            if (e.isDirectory()) {
              if (depth < 4 && !SKIP.test(e.name)) keep.push([join(d, e.name), depth + 1])
            } else if (/^ffmpeg\.exe$/i.test(e.name)) {
              found.add(join(d, e.name))
            }
          }
          return keep
        }))
        for (const r of res) for (const x of r) next.push(x)
      }
      level = next
    }
    return Array.from(found)
  }

  async function pickFfmpeg() {
    // 上次已经探明白了 → 只要那份 ffmpeg 还在，就只复核它一个（约 2 秒），
    // 不再去遍历所有盘符找 ffmpeg、也不再逐个评估五份二进制（那是 30 秒的代价）。
    // 复核是必要的：用户可能把那份 ffmpeg 换成了精简版，能力会变。
    const cache = config.ffmpegCache
    if (!config.ffmpeg && cache && typeof cache.bin === 'string' && existsFile(cache.bin)) {
      const s = await scoreBinary(cache.bin)
      if (s.score >= 8) {                     // 仍能出裸 PCM 且冷门格式覆盖够广 → 直接沿用
        ffmpegTried = [{ bin: s.bin, score: s.score, canPcm: s.canPcm, rare: s.rare }]
        console.info('[music-local] ffmpeg 复用上次结果：' + s.bin + '(' + s.score + ')')
        return selOf(s)
      }
    }

    const quick = []
    if (config.ffmpeg) quick.push(config.ffmpeg)          // 用户显式指定 → 无条件优先
    if (process.env.FFMPEG_PATH) quick.push(process.env.FFMPEG_PATH)
    const exts = (process.env.PATHEXT || '.EXE').split(';').map((s) => s.toLowerCase())
    for (const dir of (process.env.PATH || '').split(';')) {
      if (!dir) continue
      for (const e of exts) quick.push(join(dir, 'ffmpeg' + e))
    }
    const explicit = config.ffmpeg && existsFile(config.ffmpeg) ? config.ffmpeg : null

    const candidates = []
    for (const c of quick) if (existsFile(c)) candidates.push(c)
    let scored = await Promise.all(candidates.map((c) => scoreBinary(c)))

    // 常见位置里没有"够格"的才去盘上翻。够格 = 既能出裸 PCM（决定能否 seek），
    // 冷门格式（dts/dsd/ape…）也覆盖了至少 4 种；只有裸 PCM 但解不了 dts 的不算。
    const good = (s) => s.canPcm && s.rare.length >= 4
    if (scored.length === 0 || !scored.some(good)) {
      const found = await discoverBinaries()
      const extra = found.filter((p) => candidates.indexOf(p) === -1)
      // 这里也并行评估：10 个 ffmpeg 进程同时跑，比串行快得多
      scored = scored.concat(await Promise.all(extra.map((c) => scoreBinary(c))))
    }
    if (scored.length === 0) return null
    scored.sort((a, b) => b.score - a.score)
    ffmpegTried = scored.slice(0, 8).map((s) => ({ bin: s.bin, score: s.score, canPcm: s.canPcm, rare: s.rare }))
    const best = scored[0]
    if (best.score < 0) return null
    const chosen = explicit && scored.some((s) => s.bin === explicit) ? explicit : best.bin
    const rec = scored.find((s) => s.bin === chosen) || best
    if (ffmpegTried.length > 1) {
      console.info('[music-local] ffmpeg 选型：' + ffmpegTried.map((t) => t.bin + '(' + t.score + ')').join(' > '))
    }
    return selOf(rec)
  }

  // 把评估结果整理成运行期要用的形状（顺带找同目录的 ffprobe）
  function selOf(rec) {
    const dir = dirname(rec.bin)
    const probe = existsFile(join(dir, 'ffprobe.exe')) ? join(dir, 'ffprobe.exe') : null
    return { bin: rec.bin, dir, probe, canPcm: rec.canPcm, score: rec.score, rare: rec.rare }
  }

  function ensureFfmpeg() {
    if (ffmpegSelPromise === null) {
      ffmpegSelPromise = pickFfmpeg()
        .then((sel) => {
          ffmpegSel = sel
          if (sel !== null) {
            // ★ 结果必须落盘：否则每次启动 DSH 都要重新遍历所有盘符找 ffmpeg
            //   再逐个评估（实测 30 秒+），而这份结论基本不会变。
            const prev = config.ffmpegCache
            const same = prev && prev.bin === sel.bin && prev.canPcm === sel.canPcm
            config.ffmpegAuto = sel.bin
            config.ffmpegCache = { bin: sel.bin, score: sel.score, canPcm: sel.canPcm, rare: sel.rare, at: Date.now() }
            if (!same) writeJson(CONFIG_FILE, config)
          }
          return sel
        })
        .catch(() => { ffmpegSel = null; return null })
    }
    return ffmpegSelPromise
  }
  // 当前已知的最佳二进制（可能还没探测完）
  const ffmpegNow = () => (ffmpegSel !== null ? ffmpegSel.bin : (existsFile(config.ffmpeg) ? config.ffmpeg : null))

  // 配置里如果记过自动选中的路径，直接拿来当首选候选
  if (typeof config.ffmpegAuto === 'string' && config.ffmpegAuto !== '' && existsFile(config.ffmpegAuto)) {
    if (!config.ffmpeg) config.ffmpeg = config.ffmpegAuto
  }

  // ---- 扫描 ----
  // 分层 BFS + 有界并发：一次最多同时打开 DIR_CONC 个目录。
  // 不用无界递归 Promise.all —— 3.8 万文件会产生几千个并发 readdir，
  // 内存与句柄都会瞬间飙高。
  const DIR_CONC = 32

  async function walkAll(root) {
    const files = []
    let level = [[root, 0]]
    while (level.length > 0) {
      const next = []
      for (let i = 0; i < level.length; i += DIR_CONC) {
        const batch = level.slice(i, i + DIR_CONC)
        const results = await Promise.all(batch.map(async ([dir, depth]) => {
          const keep = []
          let entries
          try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return keep }
          for (const e of entries) {
            if (e.name.charCodeAt(0) === 46) continue // '.' 开头
            const full = join(dir, e.name)
            let isDir = e.isDirectory()
            let isFile = e.isFile()
            if (!isDir && !isFile && e.isSymbolicLink()) {
              try { const st = await fsp.stat(full); isDir = st.isDirectory(); isFile = st.isFile() } catch { continue }
            }
            if (isDir) { if (depth < SCAN_MAX_DEPTH) keep.push([full, depth + 1]); continue }
            if (isFile && AUDIO_EXT.has(extOf(e.name))) files.push({ abs: full, name: e.name })
          }
          return keep
        }))
        for (const r of results) for (const d of r) next.push(d)
      }
      level = next
    }
    return files
  }

  async function scan() {
    const t0 = Date.now()
    const root = config.root
    if (!root || !existsSync(root)) {
      playlists = []; tree = null; index = new Map(); folderSub = new Map()
      scannedAt = Date.now(); scanMs = Date.now() - t0
      return
    }
    const files = await walkAll(root)

    const norm = root.replace(/[\\/]+$/, '')
    const used = new Set()
    const resolve = buildNameResolver(files)

    // ---- 文件夹树：**每个子目录（任意深度）**都是一个歌单节点，按树形组织 ----
    // relDir 用 '\' 统一分隔，'' 代表根目录（纯容器，本身不作为歌单出现）。
    // 文件夹 id = 'g' + hash(相对路径)，与旧版顶层分组的 id 完全兼容（顶层目录的
    // relDir 恰好就是它原来的 groupName），所以升级后「上次播放的歌单」不会失效。
    const folders = new Map()
    const nextIndex = new Map()
    function ensureFolder(relDir) {
      let n = folders.get(relDir)
      if (n !== undefined) return n
      const segs = relDir === '' ? [] : relDir.split('\\')
      n = { id: 'g' + hashId(relDir), rel: relDir, name: segs.length > 0 ? segs[segs.length - 1] : '(根目录)', tracks: [], children: [] }
      folders.set(relDir, n)
      if (segs.length > 0) ensureFolder(segs.slice(0, -1).join('\\')).children.push(n)
      return n
    }
    const rootNode = ensureFolder('')
    const pending = []   // 全部曲目引用，稍后并行 stat 文件大小

    for (let fi = 0; fi < files.length; fi++) {
      const abs = files[fi].abs
      const file = files[fi].name
      const rel = abs.slice(norm.length + 1)
      const segs = rel.split(/[\\/]/)
      const dirRel = segs.length > 1 ? segs.slice(0, -1).join('\\') : ''

      let id = 't' + hashId(rel)
      while (used.has(id)) id += 'x'
      used.add(id)

      const nm = resolve(fi)
      const track = {
        id, rel, abs, ext: extOf(file), file,
        artist: nm.artist,
        title: nm.title || cleanBase(file) || file,
        size: 0,
      }
      nextIndex.set(id, track)
      ensureFolder(dirRel).tracks.push(track)
      pending.push(track)
    }

    // 并行取文件大小（最终结果存在 local reference，避免扫描期间读半成品）
    // ⚠️ 这里必须叫 pending，不能叫 allTracks —— 那是模块级的累加变量，
    //    用同名 const 遮蔽它会让下面的赋值抛 TypeError，
    //    而异常被 ensureScan 吞掉后表现为"每次都重扫 + __all__ 恒空"。
    for (let i = 0; i < pending.length; i += STAT_BATCH) {
      const batch = pending.slice(i, i + STAT_BATCH)
      await Promise.all(batch.map(async (t) => {
        try { t.size = (await fsp.stat(t.abs)).size } catch { t.size = 0 }
      }))
    }

    // 直接落在根目录的文件 → 挂一个「(根目录)」伪子节点，保持"根 = 纯容器"的树形语义
    if (rootNode.tracks.length > 0) {
      const pseudo = { id: 'g' + hashId('\u0000root-files'), rel: '', name: '(根目录)', tracks: rootNode.tracks, children: [] }
      rootNode.tracks = []
      rootNode.children.push(pseudo)
    }

    // 后序整理：排序、汇总每个节点"含子孙"的曲目表 / 字节数 / 数量。
    // folderSub 是 /tracks 的数据源：点任何一个文件夹 = 播放它整棵子树的歌。
    const foldersById = new Map()
    const flat = []
    const NATURAL = { numeric: true }
    const finishNode = (n) => {
      foldersById.set(n.id, n)
      n.tracks.sort((a, b) => a.file.localeCompare(b.file, 'zh-Hans-CN', NATURAL))
      n.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', NATURAL))
      const sub = n.tracks.slice()
      let bytes = 0
      for (const t of n.tracks) bytes += t.size
      for (const c of n.children) {
        const r = finishNode(c)
        for (const t of r.list) sub.push(t)
        bytes += r.bytes
      }
      folderSub.set(n.id, sub)
      if (n !== rootNode) flat.push({ id: n.id, name: n.name, count: sub.length, bytes })
      return { list: sub, bytes }
    }
    finishNode(rootNode)

    const toNodeJson = (n) => ({
      id: n.id, name: n.name, count: folderSub.get(n.id).length,
      children: n.children.map(toNodeJson),
    })

    // 原子替换
    playlists = flat.sort((a, b) => b.count - a.count)
    tree = toNodeJson(rootNode)
    index = nextIndex
    // __all__ 的顺序 = 树的先序遍历，这样"全部曲目"里上一首/下一首也自然
    allTracks = folderSub.get(rootNode.id)
    scannedAt = Date.now()
    scanMs = Date.now() - t0
  }

  // 扫描只做一次：结果缓存在内存里，之后所有请求直接命中。
  // ⚠️ 早先的写法在 finally 里把 scanPromise 置空，等于"每次请求都重扫全库"——
  // 每次点一首歌都要先等 3 秒重新遍历 3.8 万个文件。必须用独立的 done 标记。
  // ⚠️ 失败时一定要把原因打出来：这里曾经静默吞掉 scan() 里的 TypeError，
  //    表现为"页面能用但每次都卡 3 秒 + 全部曲目是空的"，极难定位。
  function ensureScan() {
    if (scanDone) return Promise.resolve()
    if (scanPromise === null) {
      scanPromise = scan()
        .then(() => { scanDone = true })
        .catch((e) => {
          console.error('[music-local] 扫描失败（下次请求会重试）:', e && e.stack ? e.stack : e)
        })
        .finally(() => { scanPromise = null })
    }
    return scanPromise
  }
  async function rescan() {
    scanDone = false
    scanPromise = null
    await ensureScan()
  }

  // ---- 时长探测（ffprobe 优先，回退 ffmpeg 打印的流信息）----
  function probeDuration(bin, probeBin, abs) {
    return new Promise((done) => {
      let out = ''
      let child = null
      let settled = false
      const fin = (v) => {
        if (settled) return
        settled = true
        try { if (child !== null) child.kill('SIGKILL') } catch { /* noop */ }
        done(v)
      }
      try {
        if (probeBin !== null) {
          child = spawn(probeBin,
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', abs],
            { windowsHide: true })
          child.stdout.on('data', (d) => { out += d.toString() })
        } else {
          // 不给输出参数：ffmpeg 打印完流信息会立即以 "At least one output file must be specified" 退出
          child = spawn(bin, ['-hide_banner', '-nostdin', '-i', abs], { windowsHide: true })
          child.stderr.on('data', (d) => { out += d.toString() })
        }
      } catch { done(0); return }
      child.on('error', () => fin(0))
      child.on('close', () => {
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out)
        if (m !== null) { fin((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])); return }
        const n = parseFloat(out.trim())
        fin(Number.isFinite(n) && n > 0 ? n : 0)
      })
      setTimeout(() => fin(0), 15000)
    })
  }

  // ---- HTTP 小工具 ----
  const json = (res, data, code = 200) => {
    const body = Buffer.from(JSON.stringify(data), 'utf8')
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }
  const readBody = (req) => new Promise((done) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { done(JSON.parse(raw || '{}')) } catch { done({}) } })
    req.on('error', () => done({}))
  })

  // ---- 原生格式：直传 + Range ----
  async function streamNative(req, res, track, range) {
    let size
    try { size = (await fsp.stat(track.abs)).size } catch { json(res, { ok: false, error: 'unreadable' }, 404); return }
    let start = 0, end = size - 1, status = 200
    if (typeof range === 'string') {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (m !== null && (m[1] !== '' || m[2] !== '')) {
        if (m[1] !== '') {
          start = parseInt(m[1], 10)
          end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
        } else {
          start = Math.max(size - parseInt(m[2], 10), 0)
        }
        if (!Number.isFinite(start) || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + size }); res.end(); return
        }
        status = 206
      }
    }
    const headers = {
      'Content-Type': MIME[track.ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'no-store',
    }
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
    res.writeHead(status, headers)
    if (req.method === 'HEAD') { res.end(); return }
    const rs = createReadStream(track.abs, { start, end })
    rs.on('error', () => { try { res.destroy() } catch { /* noop */ } })
    res.on('close', () => rs.destroy())
    rs.pipe(res)
  }

  // ---- 非原生格式：ffmpeg 实时解码成 PCM/WAV ----
  //
  // 两条路径，取决于客户端是否告知时长：
  //  · 未知时长 → 输出"长度未知"的 WAV 流（能播，但拖进度要重新起流）
  //  · 已知时长 → 按"一个定长 WAV 文件"来服务：正确的 Content-Length + Range，
  //    因此进度条能精确拖动（把字节偏移换算回时间轴，用 -ss 重新定位 ffmpeg）
  const PCM_BYTES_PER_SEC = 44100 * 2 * 2 // 16bit / 立体声 / 44.1kHz
  const PCM_RATE = 44100

  function wavHeader(dataLen) {
    const unknown = !(dataLen >= 0)
    const h = Buffer.alloc(44)
    h.write('RIFF', 0)
    h.writeUInt32LE(unknown ? 0xffffffff : 36 + dataLen, 4)
    h.write('WAVE', 8)
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20)
    h.writeUInt16LE(2, 22); h.writeUInt32LE(PCM_RATE, 24)
    h.writeUInt32LE(PCM_BYTES_PER_SEC, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34)
    h.write('data', 36)
    h.writeUInt32LE(unknown ? 0xffffffff : dataLen, 40)
    return h
  }

  // 裸 PCM 管道（完整版 ffmpeg 才有 s16le 复用器）
  function spawnPcm(bin, file, seekSec) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
    if (seekSec > 0) args.push('-ss', String(seekSec))
    args.push('-i', file, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(PCM_RATE), '-ac', '2', 'pipe:1')
    return spawn(bin, args, { windowsHide: true })
  }
  // 精简版 ffmpeg 没有 s16le 复用器时的退路：让它自己吐带头的 WAV 流。
  // 代价是无法做精确 Range（进度条拖动会从新位置重新起流），但至少能播。
  function spawnWav(bin, file, seekSec, dur) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
    if (seekSec > 0) args.push('-ss', String(seekSec))
    args.push('-i', file, '-vn', '-map', 'a:0?', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', String(PCM_RATE), '-ac', '2')
    if (Number.isFinite(dur) && dur > 0 && seekSec > 0) args.push('-t', String(Math.max(0.5, dur - seekSec)))
    args.push('pipe:1')
    return spawn(bin, args, { windowsHide: true })
  }

  async function streamTranscode(req, res, track, startSec, dur, codec) {
    const sel = await ensureFfmpeg().catch(() => null)
    if (sel === null) {
      json(res, {
        ok: false, error: 'need-ffmpeg',
        message: '该格式需要 ffmpeg 转码：请在播放面板「设置」里指定一个**完整版** ffmpeg.exe 路径',
      }, 501)
      return
    }
    const bin = sel.bin
    let child = null
    let responded = false
    let stderr = ''
    let wrote = 0
    let limit = -1
    const finish = () => { try { res.end() } catch { /* noop */ } }
    const fail = () => {
      if (responded) { finish(); return }
      responded = true
      json(res, { ok: false, error: 'ffmpeg-failed', detail: String(stderr).slice(-500) }, 500)
    }
    res.on('close', () => { try { if (child !== null) child.kill('SIGKILL') } catch { /* noop */ } })

    // ---------- 精简版 ffmpeg：让它自己出 WAV 流，不做精确 Range ----------
    if (!sel.canPcm) {
      try { child = spawnWav(bin, track.abs, startSec, dur) } catch { json(res, { ok: false, error: 'ffmpeg-spawn-failed' }, 500); return }
      child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString() })
      child.stdout.once('data', (chunk) => {
        if (responded) return
        responded = true
        res.writeHead(200, {
          'Content-Type': 'audio/wav', 'Cache-Control': 'no-store',
          'X-DML-Transcode': '1', 'X-DML-WavMode': '1',
          'X-DML-Codec': codec || track.ext.toUpperCase(),
        })
        res.write(chunk)
        child.stdout.pipe(res)
      })
      child.on('error', fail)
      child.on('close', () => { if (!responded) fail(); else finish() })
      return
    }

    // ---------- 路径二：已知时长 → 当成定长 WAV 文件，支持 Range ----------
    if (Number.isFinite(dur) && dur > 0) {
      const dataLen = Math.max(0, Math.round(dur * PCM_BYTES_PER_SEC))
      const total = 44 + dataLen
      let start = 0, end = total - 1, status = 200
      const range = req.headers.range
      if (typeof range === 'string') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        if (m !== null && (m[1] !== '' || m[2] !== '')) {
          if (m[1] !== '') {
            start = parseInt(m[1], 10)
            end = m[2] !== '' ? Math.min(parseInt(m[2], 10), total - 1) : total - 1
          } else {
            start = Math.max(total - parseInt(m[2], 10), 0)
          }
          if (!Number.isFinite(start) || start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return
          }
          status = 206
        }
      }
      const headers = {
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-store',
        'X-DML-Transcode': '1',
        'X-DML-Codec': codec || track.ext.toUpperCase(),
      }
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total
      res.writeHead(status, headers)
      if (req.method === 'HEAD') { res.end(); return }

      // 要产出的 PCM 区间（相对 data 段）
      const pcmFrom = Math.max(0, start - 44)
      const pcmTo = end - 44
      limit = pcmTo >= pcmFrom ? (pcmTo - pcmFrom + 1) : 0
      // Range 起点落在文件头 44 字节内时，先把头部对应片段补出去
      if (start < 44) res.write(wavHeader(dataLen).slice(start, Math.min(44, end + 1)))

      if (limit === 0) { res.end(); return }
      try { child = spawnPcm(bin, track.abs, startSec + pcmFrom / PCM_BYTES_PER_SEC) } catch { json(res, { ok: false, error: 'ffmpeg-spawn-failed' }, 500); return }
      responded = true
      child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString() })
      child.stdout.on('data', (chunk) => {
        const left = limit - wrote
        if (left <= 0) return
        if (chunk.length >= left) { res.write(chunk.subarray(0, left)); wrote = limit; finish(); child.kill('SIGKILL') }
        else { res.write(chunk); wrote += chunk.length }
      })
      child.on('error', fail)
      child.on('close', () => finish())
      return
    }

    // ---------- 路径一：未知时长 → 长度未知的 WAV 流 ----------
    try { child = spawnPcm(bin, track.abs, startSec) } catch { json(res, { ok: false, error: 'ffmpeg-spawn-failed' }, 500); return }
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString() })
    child.stdout.once('data', (chunk) => {
      if (responded) return
      responded = true
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
        'X-DML-Transcode': '1',
        'X-DML-Codec': codec || track.ext.toUpperCase(),
      })
      res.write(wavHeader(-1))
      res.write(chunk)
      child.stdout.pipe(res)
    })
    child.on('error', fail)
    child.on('close', () => { if (!responded) fail(); else finish() })
  }

  // ---- 路由总入口 ----
  const PREFIX = '/dsh-music-local'
  const serve = async (req, res) => {
    let url
    try { url = new URL(req.url || '/', 'http://localhost') } catch { res.writeHead(400); res.end(); return }
    const p = url.pathname
    const q = url.searchParams
    try {
      // ---------- 目录浏览（自建选择器；浏览器无法直接读盘）----------
      if (p === PREFIX + '/browse') {
        const raw = (q.get('path') || '').trim()
        if (!raw) {
          const drives = []
          for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
            const d = letter + ':\\'
            if (existsSync(d)) drives.push({ name: d, path: d, items: -1 })
          }
          json(res, { ok: true, path: '', parent: '', dirs: drives })
          return
        }
        if (!existsSync(raw)) { json(res, { ok: false, error: '目录不存在' }, 404); return }
        let cur = raw
        try { if (!(await fsp.stat(cur)).isDirectory()) cur = dirname(cur) } catch { json(res, { ok: false, error: '无法读取' }, 403); return }
        let entries = []
        try { entries = await fsp.readdir(cur, { withFileTypes: true }) } catch { json(res, { ok: false, error: '无访问权限' }, 403); return }
        const dirs = []
        let audio = 0
        for (const e of entries) {
          if (e.name.startsWith('.')) continue
          const full = join(cur, e.name)
          let isDir = e.isDirectory()
          if (!isDir && e.isSymbolicLink()) { try { isDir = (await fsp.stat(full)).isDirectory() } catch { /* skip */ } }
          if (isDir) {
            let n = -1
            try { n = (await fsp.readdir(full)).length } catch { /* skip */ }
            dirs.push({ name: e.name, path: full, items: n })
          } else if (e.isFile() && AUDIO_EXT.has(extOf(e.name))) audio++
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        const parent = dirname(cur)
        json(res, { ok: true, path: cur, parent: parent === cur ? '' : parent, dirs, audio })
        return
      }

      // ---------- 配置 ----------
      if (p === PREFIX + '/config' && req.method === 'GET') {
        const sel = ffmpegSel
        json(res, {
          ok: true,
          config,
          ffmpegOk: sel !== null,
          ffmpegPath: sel !== null ? sel.bin : (existsFile(config.ffmpeg) ? config.ffmpeg : ''),
          ffmpegProbing: sel === null,
          ffmpegCanPcm: sel === null ? null : sel.canPcm,
          ffmpegRare: sel === null ? [] : sel.rare,
          ffmpegTried,
          playlistCount: playlists.length, trackCount: index.size,
          scannedAt, scanMs, scanning: scanPromise !== null,
        })
        return
      }
      if (p === PREFIX + '/config' && req.method === 'POST') {
        const body = await readBody(req)
        let dirty = false
        let reprobe = false
        if (typeof body.root === 'string' && body.root.trim() && body.root.trim() !== config.root) {
          config.root = body.root.trim(); dirty = true
        }
        if (typeof body.ffmpeg === 'string') {
          const v = body.ffmpeg.trim()
          if (v !== config.ffmpeg) { config.ffmpeg = v; reprobe = true }
          if (v !== '') delete config.ffmpegAuto
        }
        if (dirty || reprobe) writeJson(CONFIG_FILE, config)
        if (reprobe) { ffmpegSel = null; ffmpegSelPromise = null; await ensureFfmpeg().catch(() => null) }
        if (dirty) await rescan()
        const sel = ffmpegSel
        json(res, {
          ok: true, config,
          ffmpegOk: sel !== null,
          ffmpegPath: sel !== null ? sel.bin : '',
          ffmpegProbing: false,          // 这里已经 await 过 ensureFfmpeg，探测必然结束
          ffmpegCanPcm: sel === null ? null : sel.canPcm,
          ffmpegRare: sel === null ? [] : sel.rare,
          scanMs, playlistCount: playlists.length, trackCount: index.size,
        })
        return
      }
      if (p === PREFIX + '/rescan') {
        await rescan()
        json(res, { ok: true, scanMs, playlistCount: playlists.length, trackCount: index.size })
        return
      }

      // ---------- 列表（= 每个子目录一个歌单，tree 为嵌套结构）----------
      if (p === PREFIX + '/manifest') {
        await ensureScan()
        json(res, { ok: true, root: config.root, scannedAt, scanMs, total: index.size, playlists, tree })
        return
      }

      // ---------- 某列表的曲目（分页 / 关键词 / 纯 id 列表）----------
      if (p === PREFIX + '/tracks') {
        await ensureScan()
        const plId = q.get('pl') || ''
        const base = plId === '__all__' ? allTracks : (folderSub.get(plId) || [])
        const kw = (q.get('q') || '').trim().toLowerCase()
        const src = kw === '' ? base : base.filter((t) =>
          t.file.toLowerCase().includes(kw) || t.artist.toLowerCase().includes(kw) || t.title.toLowerCase().includes(kw))
        // ids=1：只回 id 数组，供播放器建立"整列表顺序"（上一首/下一首/随机都靠它）
        if (q.get('ids') === '1') {
          json(res, { ok: true, total: src.length, all: base.length, ids: src.map((t) => t.id) })
          return
        }
        const off = Math.max(0, parseInt(q.get('off') || '0', 10) || 0)
        const lim = Math.min(PAGE_MAX, Math.max(1, parseInt(q.get('lim') || '300', 10) || 300))
        json(res, { ok: true, total: src.length, all: base.length, off, lim, items: src.slice(off, off + lim).map(toItem) })
        return
      }

      // ---------- 单条曲目（不在当前分页里的曲目，恢复播放/跳转时用）----------
      if (p === PREFIX + '/track') {
        await ensureScan()
        const t = index.get(q.get('id') || '')
        if (t === undefined) { json(res, { ok: false }, 404); return }
        json(res, { ok: true, track: toItem(t) })
        return
      }

      // ---------- 时长探测（原生格式由 <audio> 自己给，这里只服务转码格式）----------
      if (p === PREFIX + '/probe') {
        await ensureScan()
        const t = index.get(q.get('id') || '')
        if (t === undefined) { json(res, { ok: false }, 404); return }
        const sel = await ensureFfmpeg().catch(() => null)
        if (sel === null) { json(res, { ok: false, error: 'need-ffmpeg' }, 501); return }
        json(res, { ok: true, duration: await probeDuration(sel.bin, sel.probe, t.abs) })
        return
      }

      // ---------- 音频流 ----------
      if (p.startsWith(PREFIX + '/stream/')) {
        await ensureScan()
        const id = decodeURIComponent(p.slice((PREFIX + '/stream/').length))
        const t = index.get(id)
        if (t === undefined) { json(res, { ok: false, error: 'not-found' }, 404); return }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
        if (NEEDS_FFMPEG.has(t.ext)) {
          const c = CODEC_OF[t.ext]
          const dRaw = parseFloat(q.get('d') || '')
          streamTranscode(
            req, res, t,
            Math.max(0, parseFloat(q.get('t') || '0') || 0),
            Number.isFinite(dRaw) && dRaw > 0 ? dRaw : NaN,
            c ? c[0] : t.ext.toUpperCase(),
          )
        } else {
          await streamNative(req, res, t, req.headers.range)
        }
        return
      }

      // ---------- 播放偏好 ----------
      if (p === PREFIX + '/prefs' && req.method === 'GET') { json(res, { ok: true, prefs }); return }
      if (p === PREFIX + '/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        if (body && typeof body.prefs === 'object' && body.prefs !== null) prefs = { ...prefs, ...body.prefs }
        writeJson(PREFS_FILE, prefs)
        json(res, { ok: true })
        return
      }

      res.writeHead(404); res.end()
    } catch (err) {
      try { json(res, { ok: false, error: String((err && err.message) || err) }, 500) } catch { /* noop */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: serve }), 'music-local: routes')

  // 后台预热：曲库扫描 + ffmpeg 选型，都不阻塞事件循环
  void ensureScan()
  void ensureFfmpeg()

  // 这行是排障用的路标：DSH 启动日志里看到它，就说明插件确实挂上了。
  console.info('[music-local] 已挂载，音乐根目录 ' + config.root + '，路由 ' + PREFIX)
}
