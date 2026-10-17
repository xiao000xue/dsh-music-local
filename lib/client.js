/**
 * dsh-music-local —— 浏览器端（Client half）
 *
 * 被 Web ModuleLoader 当作普通 React 插件加载，向 DSH 界面注入两处 UI：
 *   1. 输入框上方的紧凑播放条（conversation.input.dock）
 *   2. 悬浮播放面板（shell.overlay）—— 左侧「列表」= 音乐根目录下的每个文件夹，
 *      右侧是该列表的曲目，支持搜索与分页
 *
 * 音频就是一个原生 <audio>，直连宿主端 /dsh-music-local/stream/<id>：
 *  · 浏览器原生格式（mp3/flac/wav/m4a…）→ 直传 + Range，拖动进度条即跳转
 *  · 非原生格式（dts/dff/dsf/ape/wma/视频容器）→ 宿主端 ffmpeg 实时转码成 WAV；
 *    播放器会先把时长问出来，再带 d=<秒> 重新请求，于是它同样变成一个"定长文件"，
 *    进度条可以精确拖动
 *
 * 全程不经过任何模型调用 —— 使用期间 token 消耗为 0。
 * UI 用原生 DOM 手写，只有挂载点是 React 组件，1.5 万行的列表也不会引发重渲染开销。
 */

window.__ModuleLoader__.load({
  id: 'dsh-music-local',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const API = '/dsh-music-local'
    const ALL = '__all__'

    // ------------------------------------------------------------ DOM / 格式化工具

    function h(tag, props, ...kids) {
      const e = document.createElement(tag)
      if (props) {
        for (const k of Object.keys(props)) {
          const v = props[k]
          if (v === undefined || v === null || v === false) continue
          if (k === 'class') e.className = v
          else if (k === 'text') e.textContent = String(v)
          else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v)
          else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v)
          else e.setAttribute(k, v === true ? '' : String(v))
        }
      }
      const flat = []
      for (const c of kids) { if (Array.isArray(c)) flat.push(...c); else flat.push(c) }
      for (const c of flat) {
        if (c === null || c === undefined || c === false) continue
        e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)))
      }
      return e
    }

    const fmtTime = (s) => {
      if (!Number.isFinite(s) || s < 0) s = 0
      return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')
    }
    const fmtSize = (b) => {
      if (!b) return ''
      const u = ['B', 'KB', 'MB', 'GB']
      let i = 0, v = b
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
      return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i]
    }
    const ignored = () => {}

    async function getJson(path) {
      const r = await fetch(API + path)
      const d = await r.json().catch(() => null)
      if (d === null) throw new Error('HTTP ' + r.status)
      return d
    }
    async function postJson(path, body) {
      const r = await fetch(API + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      })
      return r.json().catch(() => null)
    }

    // ------------------------------------------------------------ 播放引擎（模块级单例）

    const audio = document.createElement('audio')
    audio.preload = 'metadata'

    const S = {
      ready: false, scanning: false,
      root: '', ffmpegOk: false, ffmpegPath: '',
      ffmpegCapable: false, ffmpegRare: [], ffmpegProbing: false,
      playlists: [],     // 平铺的全部歌单节点（含每个子目录）
      tree: null,        // 嵌套树（根容器）；没有它就退回平铺渲染
      totalTracks: 0,
      plId: ALL, plName: '全部曲目',
      order: [],        // 当前作用域的曲目 id 顺序（受搜索影响）
      rows: [],         // 已加载进列表的曲目
      total: 0, all: 0, off: 0, lim: 300, q: '',
      cur: null,        // 当前曲目
      knownDur: 0,      // /probe 拿到的真实时长（转码格式用）
      playing: false, loading: false,
      mode: 'order',    // order | one | shuffle
      volume: 0.8,
      pos: 0, dur: 0,
      err: '', busy: '', restore: null,
    }

    const subs = new Set()
    const DBG = (typeof window !== 'undefined') ? (window.__dmlDbg = window.__dmlDbg || { emit: 0, subs: 0 }) : { emit: 0, subs: 0 }
    const emit = () => {
      DBG.emit++
      DBG.subs = subs.size
      for (const f of Array.from(subs)) { try { f() } catch (e) { ignored(e) } }
    }
    const onChange = (f) => { subs.add(f); return () => subs.delete(f) }

    let prefsTimer = null
    function savePrefs() {
      if (prefsTimer !== null) clearTimeout(prefsTimer)
      const payload = {
        volume: S.volume, mode: S.mode, scope: S.plId,
        lastId: S.cur === null ? '' : S.cur.i,
        lastPos: S.pos,
      }
      prefsTimer = setTimeout(() => {
        prefsTimer = null
        postJson('/prefs', { prefs: payload }).catch(ignored)
      }, 800)
    }

    // ---- 数据 ----

    async function loadManifest() {
      const d = await getJson('/manifest')
      if (!d.ok) return
      S.root = d.root
      S.playlists = d.playlists || []
      S.tree = d.tree || null
      S.totalTracks = d.total || 0
    }

    function plNameOf(id) {
      if (id === ALL) return '全部曲目'
      const p = S.playlists.find((x) => x.id === id)
      return p === undefined ? id : p.name
    }

    async function loadScope(plId) {
      S.plId = plId
      S.plName = plNameOf(plId)
      S.q = ''
      await reload()
      savePrefs()
    }

    // ⚠️ 顺序（ids）与条目（items）必须分两次请求：
    //    宿主端 ids=1 只回 id 数组不回 items，曾把两者混在一个请求里发，
    //    结果 rows 永远是空数组 —— 界面上就是「歌单点开一片空白」。
    async function loadOrder() {
      const qs = '/tracks?pl=' + encodeURIComponent(S.plId) + '&ids=1' +
        (S.q === '' ? '' : '&q=' + encodeURIComponent(S.q))
      const d = await getJson(qs)
      if (d.ok) {
        S.total = d.total
        S.all = d.all
        S.order = d.ids || []
      }
    }

    async function loadPage(reset) {
      if (reset === true) { S.rows = []; S.off = 0 }
      S.busy = 'load'
      emit()
      try {
        const qs = '/tracks?pl=' + encodeURIComponent(S.plId) + '&off=' + S.off + '&lim=' + S.lim +
          (S.q === '' ? '' : '&q=' + encodeURIComponent(S.q))
        const d = await getJson(qs)
        if (d.ok) {
          S.total = d.total
          S.all = d.all
          S.rows = S.rows.concat(d.items || [])
          S.off = S.rows.length
        }
      } catch (e) { S.err = String((e && e.message) || e) }
      S.busy = ''
      emit()
    }

    // 换作用域 / 换关键词时走这里：先刷新整表顺序，再取第一页条目
    async function reload() {
      S.rows = []
      S.off = 0
      await loadOrder()
      await loadPage()
    }

    async function runSearch(kw) {
      S.q = kw
      S.rows = []
      S.off = 0
      await reload()
    }

    // ---- 播放 ----

    const srcOf = (track, fromSec, dur) => {
      let u = API + '/stream/' + encodeURIComponent(track.i)
      const qs = []
      if (track.x === 1) {
        if (fromSec > 0) qs.push('t=' + Math.floor(fromSec))
        if (dur > 0) qs.push('d=' + dur.toFixed(3))
      }
      return qs.length === 0 ? u : u + '?' + qs.join('&')
    }

    const curIndex = () => (S.cur === null ? -1 : S.order.indexOf(S.cur.i))

    function startPlayback(track, fromSec) {
      audio.src = srcOf(track, fromSec, track.x === 1 ? S.knownDur : 0)
      audio.load()
      const p = audio.play()
      if (p && typeof p.catch === 'function') {
        p.catch((e) => {
          if (String(e && e.name) === 'AbortError') return
          S.err = '浏览器拦截了自动播放，点一下 ▶ 即可'
          S.loading = false
          emit()
        })
      }
    }

    function playTrack(track, fromSec) {
      if (track === null || track === undefined) return
      const from = fromSec > 0 ? fromSec : 0
      S.cur = track
      S.pos = from
      S.err = ''
      S.loading = true
      S.knownDur = 0
      // 转码格式：先问出真实时长，再带 d= 重新请求 —— 这样它就是一个"定长 WAV 文件"，
      // 进度条可以精确拖动，而不是只能重头起流。
      if (track.x === 1) {
        S.dur = 0
        emit()
        getJson('/probe?id=' + encodeURIComponent(track.i)).then((d) => {
          if (S.cur === null || S.cur.i !== track.i) return
          S.knownDur = d && d.ok && d.duration > 0 ? d.duration : 0
          S.dur = S.knownDur
          startPlayback(track, from)
        }).catch(() => {
          if (S.cur !== null && S.cur.i === track.i) startPlayback(track, from)
        })
      } else {
        S.dur = 0
        startPlayback(track, from)
      }
      savePrefs()
      emit()
    }

    function playIndex(i) {
      const n = S.order.length
      if (n === 0) return
      let k = i
      if (k < 0) k = n - 1
      if (k >= n) k = 0
      const id = S.order[k]
      const row = S.rows.find((r) => r.i === id)
      if (row !== undefined) { playTrack(row, 0); return }
      getJson('/track?id=' + encodeURIComponent(id))
        .then((d) => { if (d.ok && d.track) playTrack(d.track, 0) })
        .catch(ignored)
    }

    function step(delta) {
      if (S.order.length === 0) return
      if (S.mode === 'shuffle' && S.order.length > 1) {
        let k = Math.floor(Math.random() * S.order.length)
        if (k === curIndex()) k = (k + 1) % S.order.length
        playIndex(k)
        return
      }
      const i = curIndex()
      playIndex(i < 0 ? 0 : i + delta)
    }

    function toggle() {
      if (S.cur === null) { playIndex(0); return }
      if (audio.paused) { const p = audio.play(); if (p && p.catch) p.catch(ignored) }
      else audio.pause()
    }

    function seekTo(sec) {
      if (S.cur === null) return
      const d = S.dur > 0 ? S.dur : 0
      const target = Math.max(0, Math.min(d > 0 ? d - 0.5 : sec, sec))
      if (S.cur.x === 1) {
        // 转码流：重新请求一段从该时刻开始的流
        S.loading = true
        startPlayback(S.cur, target)
        S.pos = target
        emit()
        return
      }
      try { audio.currentTime = target } catch (e) { ignored(e) }
    }

    // ---- audio 事件 ----
    audio.addEventListener('timeupdate', () => { S.pos = audio.currentTime; emit() })
    const syncDur = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) { S.dur = audio.duration; emit() }
    }
    audio.addEventListener('durationchange', syncDur)
    audio.addEventListener('loadedmetadata', () => { S.loading = false; syncDur(); emit() })
    audio.addEventListener('play', () => { S.playing = true; S.loading = false; S.err = ''; emit() })
    audio.addEventListener('pause', () => { S.playing = false; emit() })
    audio.addEventListener('waiting', () => { S.loading = true; emit() })
    audio.addEventListener('playing', () => { S.loading = false; emit() })
    audio.addEventListener('ended', () => {
      if (S.mode === 'one') { try { audio.currentTime = 0 } catch (e) { ignored(e) } ; const p = audio.play(); if (p && p.catch) p.catch(ignored); return }
      step(1)
    })
    audio.addEventListener('error', () => {
      S.loading = false
      S.playing = false
      S.err = (S.cur !== null && S.cur.x === 1)
        ? '该格式需要 ffmpeg 转码：请在面板「设置」里指定 ffmpeg.exe'
        : '无法播放该文件'
      emit()
    })

    const applyVolume = () => { audio.volume = Math.max(0, Math.min(1, S.volume)) }

    // ---- 初始化 ----
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    function applyConfig(c) {
      S.root = c.config.root
      S.ffmpegOk = !!c.ffmpegOk
      S.ffmpegPath = c.ffmpegPath || ''
      S.ffmpegCapable = c.ffmpegCanPcm === true
      S.ffmpegRare = c.ffmpegRare || []
      S.ffmpegProbing = !!c.ffmpegProbing
    }

    // 宿主端在后台探测 ffmpeg 能力（机器上可能装了好几个，得挑完整版那个）。
    // 探测期间不阻塞界面，完成后自动刷新状态。
    async function pollConfig(times) {
      for (let i = 0; i < times; i++) {
        await sleep(2000)
        try {
          const c = await getJson('/config')
          if (!c.ok) continue
          applyConfig(c)
          emit()
          if (!c.ffmpegProbing) return
        } catch (e) { ignored(e) }
      }
    }

    let booted = false
    async function boot() {
      if (booted) return
      booted = true
      if (!document.body.contains(audio)) document.body.appendChild(audio)
      applyVolume()
      try {
        const c = await getJson('/config')
        if (c.ok) applyConfig(c)
      } catch (e) { ignored(e) }
      try {
        const p = await getJson('/prefs')
        if (p.ok && p.prefs) {
          if (typeof p.prefs.volume === 'number') S.volume = p.prefs.volume
          if (typeof p.prefs.mode === 'string') S.mode = p.prefs.mode
          if (typeof p.prefs.scope === 'string') S.plId = p.prefs.scope
          S.restore = { id: p.prefs.lastId || '', pos: p.prefs.lastPos || 0 }
        }
      } catch (e) { ignored(e) }
      applyVolume()
      emit()
      if (S.ffmpegProbing) void pollConfig(20)
      await loadManifest().catch(ignored)
      if (S.plId !== ALL && !S.playlists.some((p) => p.id === S.plId)) S.plId = ALL
      await loadScope(S.plId)
      if (S.restore !== null && S.restore.id) {
        try {
          const d = await getJson('/track?id=' + encodeURIComponent(S.restore.id))
          if (d.ok && d.track) {
            S.cur = d.track
            S.pos = S.restore.pos || 0
            if (d.track.x !== 1) { audio.src = srcOf(d.track, 0, 0); audio.load() }
          }
        } catch (e) { ignored(e) }
      }
      S.ready = true
      emit()
    }

    // ------------------------------------------------------------ React 挂载点

    function Mount({ which }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const host = ref.current
        if (host === null) return undefined
        return which === 'bar' ? mountBar(host) : mountPanel(host)
      }, [which])
      return React.createElement('div', { ref, className: 'dml-mount dml-mount-' + which })
    }

    // ------------------------------------------------------------ 播放条

    const MODE_ICON = { order: '➡', one: '🔂', shuffle: '🔀' }
    const MODE_NAME = { order: '顺序播放', one: '单曲循环', shuffle: '随机播放' }

    function mountBar(host) {
      const root = h('div', { class: 'dml-bar-wrap' })
      host.appendChild(root)

      const dot = h('div', { class: 'dml-bar-dot', text: '♪' })
      const title = h('div', { class: 'dml-bar-title' })
      const sub = h('div', { class: 'dml-bar-sub' })
      const fill = h('div', { class: 'dml-seek-fill' })
      const knob = h('div', { class: 'dml-seek-knob' })
      const seek = h('div', { class: 'dml-seek', title: '拖动跳转' }, fill, knob)
      const clock = h('div', { class: 'dml-time' })
      const bPrev = h('button', { class: 'dml-btn', title: '上一首', onclick: () => step(-1) }, '⏮')
      const bPlay = h('button', { class: 'dml-btn dml-btn-play', title: '播放 / 暂停', onclick: () => toggle() }, '▶')
      const bNext = h('button', { class: 'dml-btn', title: '下一首', onclick: () => step(1) }, '⏭')
      const bMode = h('button', {
        class: 'dml-btn', title: '播放模式',
        onclick: () => {
          S.mode = S.mode === 'order' ? 'one' : (S.mode === 'one' ? 'shuffle' : 'order')
          savePrefs(); emit()
        },
      }, '➡')
      const vol = h('input', { class: 'dml-vol', type: 'range', min: '0', max: '100', step: '1', title: '音量' })
      vol.addEventListener('input', () => { S.volume = Number(vol.value) / 100; applyVolume(); savePrefs() })
      const bOpen = h('button', { class: 'dml-btn', title: '打开本地音乐库', onclick: () => togglePanel() }, '☰')

      root.appendChild(h('div', { class: 'dml-bar' },
        dot,
        h('div', { class: 'dml-bar-info' }, title, sub),
        h('div', { class: 'dml-bar-center' }, seek, clock),
        h('div', { class: 'dml-bar-ctrl' }, bPrev, bPlay, bNext, bMode, vol, bOpen),
      ))

      let dragging = false
      const seekAt = (ev) => {
        const r = seek.getBoundingClientRect()
        const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)))
        if (S.dur > 0) seekTo(ratio * S.dur)
      }
      seek.addEventListener('pointerdown', (ev) => {
        dragging = true
        try { seek.setPointerCapture(ev.pointerId) } catch (e) { ignored(e) }
        seekAt(ev)
      })
      seek.addEventListener('pointermove', (ev) => { if (dragging) seekAt(ev) })
      seek.addEventListener('pointerup', () => { dragging = false })
      seek.addEventListener('pointercancel', () => { dragging = false })

      function sync() {
        const c = S.cur
        if (c === null) {
          title.textContent = S.playlists.length === 0 ? '本地音乐：正在扫描曲库…' : '本地音乐：点 ☰ 打开曲库'
          sub.textContent = S.root || ''
        } else {
          title.textContent = c.n || c.f
          sub.textContent = (c.a ? c.a + ' · ' : '') + c.c + (c.q ? ' · ' + c.q : '') + (c.x === 1 ? ' · 转码' : '')
        }
        title.title = c === null ? '' : c.f
        dot.classList.toggle('on', S.playing)
        bPlay.textContent = S.playing ? '❚❚' : '▶'
        bMode.textContent = MODE_ICON[S.mode]
        bMode.title = MODE_NAME[S.mode]
        const ratio = S.dur > 0 ? Math.max(0, Math.min(1, S.pos / S.dur)) : 0
        fill.style.width = (ratio * 100) + '%'
        knob.style.left = (ratio * 100) + '%'
        clock.textContent = fmtTime(S.pos) + ' / ' + (S.dur > 0 ? fmtTime(S.dur) : '--:--')
        if (document.activeElement !== vol) vol.value = String(Math.round(S.volume * 100))
        root.classList.toggle('dml-err', S.err !== '')
        root.title = S.err
      }
      sync()
      const off = onChange(sync)
      return () => { off(); if (root.parentNode) root.remove() }
    }

    // ------------------------------------------------------------ 面板 显隐（模块级，播放条与面板共享）

    let panelOpen = false
    const panelWatchers = new Set()
    function togglePanel() {
      panelOpen = !panelOpen
      for (const f of Array.from(panelWatchers)) { try { f(panelOpen) } catch (e) { ignored(e) } }
    }

    // ------------------------------------------------------------ 播放面板

    function mountPanel(host) {
      const root = h('div', { class: 'dml-panel' })
      host.appendChild(root)

      // 位置与尺寸（记在浏览器本地 —— 与 DSH 宿主无关，不产生任何请求）
      let rect = { x: 0, y: 0, w: 0, h: 0 }
      try {
        const saved = JSON.parse(localStorage.getItem('dml-panel-rect') || 'null')
        if (saved && typeof saved.w === 'number' && saved.w > 0) rect = saved
      } catch (e) { ignored(e) }
      if (rect.w === 0) {
        rect.w = Math.min(780, window.innerWidth - 48)
        rect.h = Math.min(560, window.innerHeight - 96)
        rect.x = window.innerWidth - rect.w - 28
        rect.y = window.innerHeight - rect.h - 88
      }
      const place = () => {
        rect.w = Math.max(420, Math.min(rect.w, window.innerWidth - 16))
        rect.h = Math.max(300, Math.min(rect.h, window.innerHeight - 16))
        rect.x = Math.max(8, Math.min(rect.x, window.innerWidth - rect.w - 8))
        rect.y = Math.max(8, Math.min(rect.y, window.innerHeight - rect.h - 8))
        Object.assign(root.style, {
          left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px',
        })
      }
      place()
      const persistRect = () => { try { localStorage.setItem('dml-panel-rect', JSON.stringify(rect)) } catch (e) { ignored(e) } }

      // ---- 视图状态 ----
      let view = 'main' // main | set

      // ---- 标题栏 ----
      const titleEl = h('div', { class: 'dml-panel-title', text: '本地音乐库' })
      const head = h('div', { class: 'dml-panel-head' },
        h('span', { class: 'dml-logo', text: '♪' }),
        titleEl,
        h('div', { class: 'dml-panel-head-right' },
          h('button', { class: 'dml-btn', title: '重新扫描曲库', onclick: () => { safe(reroll()) } }, '刷新'),
          h('button', { class: 'dml-btn', title: '设置', onclick: () => { view = view === 'set' ? 'main' : 'set'; render() } }, '设置'),
          h('button', { class: 'dml-btn', title: '收起（音乐不会停）', onclick: () => togglePanel() }, '✕'),
        ),
      )
      // 拖动（标题栏）
      let drag = null
      head.addEventListener('pointerdown', (ev) => {
        if (ev.target.closest('button')) return
        drag = { dx: ev.clientX - rect.x, dy: ev.clientY - rect.y }
        try { head.setPointerCapture(ev.pointerId) } catch (e) { ignored(e) }
      })
      head.addEventListener('pointermove', (ev) => {
        if (drag === null) return
        rect.x = ev.clientX - drag.dx
        rect.y = ev.clientY - drag.dy
        place()
      })
      head.addEventListener('pointerup', () => { if (drag !== null) { drag = null; persistRect() } })
      head.addEventListener('pointercancel', () => { drag = null })

      // ---- 主视图：左侧列表 + 右侧曲目 ----
      const sideEl = h('div', { class: 'dml-side' })
      const searchEl = h('input', { class: 'dml-search', type: 'search', placeholder: '搜索歌名 / 歌手 / 文件名…' })
      const countEl = h('div', { class: 'dml-count' })
      const listEl = h('div', { class: 'dml-list' })
      const moreBtn = h('button', { class: 'dml-btn dml-more', onclick: () => { safe(loadPage(false)) } })
      const moreWrap = h('div', { class: 'dml-more-wrap' }, moreBtn)
      const mainView = h('div', { class: 'dml-body' },
        sideEl,
        h('div', { class: 'dml-main' },
          h('div', { class: 'dml-toolbar' }, searchEl, countEl),
          listEl, moreWrap,
        ),
      )

      // ---- 设置视图 ----
      const setRootPath = h('div', { class: 'dml-set-path' })
      const curRootPath = h('div', { class: 'dml-set-path' })
      const navPath = h('div', { class: 'dml-set-path' })
      const dirList = h('div', { class: 'dml-dirlist' })
      const ffInput = h('input', { class: 'dml-search', type: 'text', placeholder: 'ffmpeg.exe 完整路径（留空 = 自动在 PATH 中查找）' })
      const ffState = h('div', { class: 'dml-count' })
      const scanState = h('div', { class: 'dml-count' })

      const browseTo = async (p) => {
        dirList.textContent = ''
        navPath.textContent = '读取中…'
        try {
          const d = await getJson('/browse' + (p ? '?path=' + encodeURIComponent(p) : ''))
          navPath.textContent = d.path || '（选择一个盘符）'
          if (d.parent) dirList.appendChild(h('button', { class: 'dml-dir', onclick: () => { safe(browseTo(d.parent)) } }, '⬆ 上一级'))
          if (p) dirList.appendChild(h('button', { class: 'dml-dir dml-dir-pick', onclick: () => { safe(applyRoot(d.path)) } }, '✓ 把这里设为音乐根目录'))
          for (const it of d.dirs) {
            dirList.appendChild(h('button', { class: 'dml-dir', onclick: () => { safe(browseTo(it.path)) } },
              h('span', { class: 'dml-dir-name', text: it.name }),
              h('span', { class: 'dml-dir-meta', text: it.items >= 0 ? it.items + ' 项' : '' }),
            ))
          }
          if (d.dirs.length === 0) dirList.appendChild(h('div', { class: 'dml-dir-meta', text: '（这里没有子文件夹）' }))
        } catch (e) { navPath.textContent = '读取失败：' + ((e && e.message) || e) }
      }

      const applyRoot = async (p) => {
        const r = await postJson('/config', { root: p })
        if (r && r.ok) {
          S.root = r.config.root
          await loadManifest().catch(ignored)
          if (S.plId !== ALL && !S.playlists.some((x) => x.id === S.plId)) S.plId = ALL
          await loadScope(S.plId)
          refreshSet()
          view = 'main'
          render()
        }
      }

      const refreshSet = () => {
        curRootPath.textContent = '当前根目录：' + (S.root || '(未设置)')
        if (S.ffmpegProbing) ffState.textContent = '正在探测 ffmpeg 能力…'
        else if (!S.ffmpegOk) ffState.textContent = '✗ 未找到可用的 ffmpeg —— dts / dff / dsd / ape / 视频等格式将无法播放'
        else if (!S.ffmpegCapable) ffState.textContent = '△ ' + S.ffmpegPath + '（精简版，只能处理 mp4/mp3 一类，dts/dsd/ape 仍播不了）'
        else ffState.textContent = '✓ ' + S.ffmpegPath + '（完整版，认得 ' + (S.ffmpegRare.join('/') || '常见冷门格式') + '）'
        // S.playlists 的 count 是"含子孙文件夹"的口径，直接求和会重复计数，用曲库总数
        scanState.textContent = '曲库：' + S.playlists.length + ' 个文件夹歌单 · 共 ' + (S.totalTracks || 0) + ' 首'
        if (document.activeElement !== ffInput) ffInput.value = S.ffmpegPath || ''
      }

      const setView = h('div', { class: 'dml-set' },
        h('div', { class: 'dml-set-title', text: '1 · 音乐根目录（每个子文件夹 = 左侧的一个列表）' }),
        curRootPath,
        h('div', { class: 'dml-set-row' },
          h('button', { class: 'dml-btn dml-btn-primary', onclick: () => { safe(browseTo('')) } }, '浏览磁盘…'),
          h('button', { class: 'dml-btn', onclick: () => { safe(reroll()) } }, '重新扫描'),
        ),
        navPath, dirList,
        h('div', { class: 'dml-set-title', text: '2 · ffmpeg（非原生格式实时转码）' }),
        ffInput,
        h('div', { class: 'dml-set-row' },
          h('button', {
            class: 'dml-btn dml-btn-primary',
            onclick: () => {
              safe((async () => {
                const r = await postJson('/config', { ffmpeg: ffInput.value.trim() })
                if (r) {
                  S.ffmpegOk = !!r.ffmpegOk
                  S.ffmpegPath = r.ffmpegPath || ''
                  S.ffmpegCapable = r.ffmpegCanPcm === true
                  S.ffmpegRare = r.ffmpegRare || []
                  refreshSet()
                }
              })())
            },
          }, '验证并保存'),
        ),
        ffState,
        h('div', { class: 'dml-set-title', text: '3 · 状态' }),
        scanState,
        h('div', { class: 'dml-set-note', text:
          '支持格式：mp3 / flac / wav / m4a / aac / ogg / opus / aiff 等由浏览器直接解码；'
          + 'dts / dff / dsf / ape / wma / wv / tta / mp4 / avi / mkv 等由 ffmpeg 实时转码播放。'
          + '播放期间不涉及任何 AI 调用，token 消耗为 0。' }),
      )

      // ★★★ 这三行绝对不能漏 ★★★
      // 上面只是把 head / mainView / setView 建出来了，但从未 append 到 root 上。
      // 少了它们，面板就是一个尺寸正确、内容为空的黑色空框 —— 而且因为 render()
      // 操作的都是内存里的游离节点，不会抛任何异常，静默失败。
      root.appendChild(head)
      root.appendChild(mainView)
      root.appendChild(setView)

      const reroll = async () => {
        S.busy = 'scan'
        emit()
        await getJson('/rescan').catch(ignored)
        await loadManifest().catch(ignored)
        if (S.plId !== ALL && !S.playlists.some((x) => x.id === S.plId)) S.plId = ALL
        await loadScope(S.plId)
        refreshSet()
      }

      // ---- 渲染 ----

      // 树的展开状态记在浏览器本地，重开面板后保持
      const persistExpanded = () => {
        try { localStorage.setItem('dml-tree-expanded', JSON.stringify(Array.from(expanded))) } catch (e) { ignored(e) }
      }
      let expanded = new Set()
      try {
        const raw = localStorage.getItem('dml-tree-expanded')
        if (raw !== null) {
          const arr = JSON.parse(raw)
          if (Array.isArray(arr)) expanded = new Set(arr)
        }
      } catch (e) { ignored(e) }
      // 第一次使用：默认展开顶层文件夹（再往下的层级收起，点 ▸ 逐层展开）
      if (!localStorage.getItem('dml-tree-expanded') && S.tree && Array.isArray(S.tree.children)) {
        for (const c of S.tree.children) expanded.add(c.id)
        persistExpanded()
      }

      function renderSide() {
        sideEl.textContent = ''
        sideEl.appendChild(h('div', { class: 'dml-side-title', text: '列表' }))
        let total = S.totalTracks
        if (!(total > 0)) { for (const p of S.playlists) total += p.count }
        sideEl.appendChild(h('button', {
          class: 'dml-pl' + (S.plId === ALL ? ' on' : ''),
          title: '全部曲目',
          onclick: () => { safe((async () => { if (S.plId !== ALL) { await loadScope(ALL); searchEl.value = '' } })()) },
        },
          h('span', { class: 'dml-pl-name', text: '全部曲目' }),
          h('span', { class: 'dml-pl-count', text: total }),
        ))
        if (S.tree !== null && Array.isArray(S.tree.children)) {
          const box = h('div', { class: 'dml-tree' })
          for (const c of S.tree.children) renderTreeNode(c, 0, box)
          sideEl.appendChild(box)
        } else {
          // 旧宿主（无 tree）→ 平铺兜底
          for (const p of S.playlists) renderFlatRow(p, sideEl)
        }
        if (S.playlists.length === 0) {
          sideEl.appendChild(h('div', { class: 'dml-dir-meta', text: '（还没有扫描到曲目，去「设置」看看根目录）' }))
        }
      }

      const pickPl = (id) => () => {
        safe((async () => {
          if (S.plId === id) return
          await loadScope(id)
          searchEl.value = ''
        })())
      }

      function renderFlatRow(p, container) {
        container.appendChild(h('button', { class: 'dml-pl' + (S.plId === p.id ? ' on' : ''), title: p.name, onclick: pickPl(p.id) },
          h('span', { class: 'dml-pl-name', text: p.name }),
          h('span', { class: 'dml-pl-count', text: p.count }),
        ))
      }

      function renderTreeNode(node, depth, container) {
        const hasKids = Array.isArray(node.children) && node.children.length > 0
        const isOpen = expanded.has(node.id)
        const wrap = h('div', { class: 'dml-pl-wrap' })
        const twist = h('span', {
          class: 'dml-twist' + (hasKids ? '' : ' dml-twist-leaf'),
          title: hasKids ? (isOpen ? '收起' : '展开') : '',
          onclick: (ev) => {
            ev.stopPropagation()
            if (!hasKids) return
            if (expanded.has(node.id)) expanded.delete(node.id)
            else expanded.add(node.id)
            persistExpanded()
            renderSide()
          },
        }, hasKids ? (isOpen ? '▾' : '▸') : '·')
        wrap.appendChild(h('div', { class: 'dml-pl-row' },
          h('div', { class: 'dml-pl-indent', style: { width: (depth * 14) + 'px' } }),
          twist,
          h('button', { class: 'dml-pl' + (S.plId === node.id ? ' on' : ''), title: node.name, onclick: pickPl(node.id) },
            h('span', { class: 'dml-pl-name', text: node.name }),
            h('span', { class: 'dml-pl-count', text: node.count }),
          ),
        ))
        container.appendChild(wrap)
        if (hasKids && isOpen) {
          const kids = h('div', { class: 'dml-tree-kids' })
          for (const c of node.children) renderTreeNode(c, depth + 1, kids)
          container.appendChild(kids)
        }
      }

      function renderList() {
        countEl.textContent = S.total + ' 首' + (S.total !== S.all ? ' / 共 ' + S.all : '') + (S.q ? ' · 已筛选' : '')
        const more = S.rows.length < S.total
        moreWrap.style.display = more ? '' : 'none'
        moreBtn.textContent = '加载更多（还有 ' + (S.total - S.rows.length) + ' 首）'
        listEl.textContent = ''
        const frag = document.createDocumentFragment()
        for (let k = 0; k < S.rows.length; k++) {
          const it = S.rows[k]
          const isCur = S.cur !== null && S.cur.i === it.i
          frag.appendChild(h('div', {
            class: 'dml-row' + (isCur ? ' on' : ''),
            title: it.f + '\n' + it.c + ' · ' + fmtSize(it.s) + (it.x === 1 ? ' · 播放时实时转码' : ''),
            // 单击：点别的歌 = 播放；点当前这首歌 = 播放/暂停
            // 双击：始终从头播放（双击别的歌时，中间那次"点当前歌→暂停"会被这里纠正）
            onclick: () => {
              if (isCur) { toggle(); return }
              playTrack(it, 0)
            },
            ondblclick: () => playTrack(it, 0),
          },
            h('span', { class: 'dml-idx', text: isCur && S.playing ? '♪' : String(k + 1) }),
            h('span', { class: 'dml-name' },
              h('span', { class: 'dml-name-main', text: it.n || it.f }),
              it.a ? h('span', { class: 'dml-name-artist', text: it.a }) : null,
            ),
            h('span', { class: 'dml-tag' + (it.q === '无损' ? ' dml-tag-hi' : ''), text: it.c }),
            it.x === 1 ? h('span', { class: 'dml-tag dml-tag-tc', text: '转码' }) : null,
            h('span', { class: 'dml-size', text: fmtSize(it.s) }),
          ))
        }
        listEl.appendChild(frag)
      }

      let searchTimer = null
      searchEl.addEventListener('input', () => {
        if (searchTimer !== null) clearTimeout(searchTimer)
        searchTimer = setTimeout(() => { searchTimer = null; safe(runSearch(searchEl.value.trim())) }, 260)
      })

      function render() {
        if (typeof window !== 'undefined' && window.__dmlDbg) {
          window.__dmlDbg.render = (window.__dmlDbg.render || 0) + 1
          window.__dmlDbg.renderView = view
          window.__dmlDbg.renderPlName = S.plName
        }
        titleEl.textContent = view === 'set' ? '本地音乐库 · 设置' : '本地音乐库 · ' + S.plName
        setView.style.display = view === 'set' ? '' : 'none'
        mainView.style.display = view === 'set' ? 'none' : ''
        if (view === 'set') { refreshSet(); return }
        renderSide()
        renderList()
      }

      const syncVisible = (open) => {
        root.style.display = open ? '' : 'none'
        if (open) render()
      }
      panelWatchers.add(syncVisible)
      syncVisible(panelOpen)
      refreshSet()
      render()

      const off = onChange(() => {
        if (typeof window !== 'undefined' && window.__dmlDbg) window.__dmlDbg.panelOnChange = (window.__dmlDbg.panelOnChange || 0) + 1
        if (panelOpen && view !== 'set') render()
      })
      const onResize = () => place()
      window.addEventListener('resize', onResize)

      return () => {
        off()
        panelWatchers.delete(syncVisible)
        window.removeEventListener('resize', onResize)
        if (root.parentNode) root.remove()
      }
    }

    // 把所有异步点击处理包起来，避免未捕获的 Promise 拒绝冒到控制台
    function safe(p) { if (p && typeof p.catch === 'function') p.catch(ignored); return p }

    // ------------------------------------------------------------ 样式

    const CSS = `
body { --dml-accent: var(--dsw-alias-brand-primary, #4c8dff); --dml-fg: var(--dsw-alias-label-primary, #e8eaed); --dml-fg2: var(--dsw-alias-label-secondary, #9aa0a6); --dml-bg: var(--dsw-alias-bg-layer-1, #1e1f22); --dml-bg2: var(--dsw-alias-bg-layer-2, #26282c); --dml-line: var(--dsw-alias-border-l1, rgba(138,144,153,.28)); }
.dml-mount-bar { width: 100%; }
.dml-mount-panel { width: 0; height: 0; }
.dml-bar-wrap { box-sizing: border-box; width: 100%; max-width: 780px; margin: 0 auto; }
.dml-bar { box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 5px 10px; border: 1px solid var(--dml-line); border-radius: 10px; background: var(--dml-bg2); color: var(--dml-fg2); font-size: 12px; line-height: 1.35; user-select: none; }
.dml-bar-wrap.dml-err .dml-bar { border-color: #d9534f; }
.dml-bar-dot { width: 22px; height: 22px; flex: 0 0 22px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(128,128,128,.18); color: var(--dml-fg2); }
.dml-bar-dot.on { background: var(--dml-accent); color: #fff; }
.dml-bar-info { min-width: 0; flex: 0 1 260px; }
.dml-bar-title { color: var(--dml-fg); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dml-bar-sub { font-size: 11px; opacity: .72; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dml-bar-center { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; min-width: 70px; }
.dml-seek { position: relative; flex: 1 1 auto; height: 14px; cursor: pointer; touch-action: none; }
.dml-seek::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 3px; border-radius: 2px; background: rgba(128,128,128,.32); }
.dml-seek-fill { position: absolute; left: 0; top: 6px; height: 3px; border-radius: 2px; background: var(--dml-accent); width: 0; pointer-events: none; }
.dml-seek-knob { position: absolute; top: 3px; width: 9px; height: 9px; margin-left: -4.5px; border-radius: 50%; background: var(--dml-accent); left: 0; pointer-events: none; }
.dml-time { font-variant-numeric: tabular-nums; font-size: 11px; opacity: .8; white-space: nowrap; }
.dml-bar-ctrl { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.dml-btn { display: inline-flex; align-items: center; justify-content: center; height: 24px; min-width: 24px; padding: 0 7px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dml-fg2); font-size: 12px; cursor: pointer; font-family: inherit; }
.dml-btn:hover { background: rgba(128,128,128,.18); color: var(--dml-fg); }
.dml-btn-play { background: var(--dml-accent); color: #fff; }
.dml-btn-play:hover { filter: brightness(1.12); color: #fff; }
.dml-btn-primary { background: var(--dml-accent); color: #fff; border-color: var(--dml-accent); }
.dml-btn-primary:hover { color: #fff; filter: brightness(1.12); }
.dml-vol { width: 64px; height: 16px; accent-color: var(--dml-accent); cursor: pointer; }
@media (max-width: 760px) { .dml-vol { display: none; } .dml-bar-center { display: none; } }

.dml-panel { position: fixed; z-index: 2147483000; display: flex; flex-direction: column; background: var(--dml-bg); color: var(--dml-fg); border: 1px solid var(--dml-line); border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.45); overflow: hidden; font-size: 12px; }
.dml-panel-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--dml-bg2); border-bottom: 1px solid var(--dml-line); cursor: move; user-select: none; flex: 0 0 auto; }
.dml-logo { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 5px; background: var(--dml-accent); color: #fff; }
.dml-panel-title { flex: 1 1 auto; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dml-panel-head-right { display: flex; gap: 4px; }
.dml-body { flex: 1 1 auto; display: flex; min-height: 0; }
.dml-side { width: 190px; flex: 0 0 190px; border-right: 1px solid var(--dml-line); overflow-y: auto; padding: 6px; }
.dml-side-title { font-size: 11px; opacity: .6; padding: 4px 6px; }
.dml-pl { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; margin-bottom: 2px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--dml-fg); text-align: left; cursor: pointer; font-size: 12px; font-family: inherit; }
.dml-pl:hover { background: rgba(128,128,128,.16); }
.dml-pl.on { background: rgba(76,141,255,.22); border-color: var(--dml-accent); }
.dml-pl-name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dml-pl-count { flex: 0 0 auto; font-size: 10px; opacity: .6; font-variant-numeric: tabular-nums; }
/* 树形歌单：每个子目录一个节点，▸/▾ 展开收起 */
.dml-pl-wrap { margin-bottom: 2px; }
.dml-pl-row { display: flex; align-items: center; }
.dml-pl-row .dml-pl { margin-bottom: 0; flex: 1 1 auto; width: auto; }
.dml-twist { flex: 0 0 16px; width: 16px; height: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--dml-fg2); opacity: .75; user-select: none; font-size: 10px; }
.dml-twist:hover { opacity: 1; }
.dml-twist-leaf { cursor: default; opacity: .25; }
.dml-tree-kids { margin-left: 12px; border-left: 1px solid rgba(128,128,128,.18); padding-left: 2px; }
.dml-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.dml-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dml-line); flex: 0 0 auto; }
.dml-search { flex: 1 1 auto; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--dml-line); border-radius: 7px; background: var(--dml-bg2); color: var(--dml-fg); font-size: 12px; outline: none; font-family: inherit; }
.dml-search:focus { border-color: var(--dml-accent); }
.dml-count { font-size: 11px; opacity: .7; white-space: nowrap; }
.dml-list { flex: 1 1 auto; overflow-y: auto; }
.dml-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px; cursor: pointer; border-bottom: 1px solid rgba(128,128,128,.09); }
.dml-row:hover { background: rgba(128,128,128,.13); }
.dml-row.on { background: rgba(76,141,255,.18); }
.dml-idx { flex: 0 0 32px; text-align: right; font-size: 11px; opacity: .55; font-variant-numeric: tabular-nums; }
.dml-row.on .dml-idx { color: var(--dml-accent); opacity: 1; }
.dml-name { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dml-name-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dml-name-artist { font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dml-tag { flex: 0 0 auto; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(128,128,128,.2); opacity: .9; }
.dml-tag-hi { background: rgba(76,141,255,.28); }
.dml-tag-tc { background: rgba(217,131,79,.3); }
.dml-size { flex: 0 0 auto; font-size: 10px; opacity: .5; font-variant-numeric: tabular-nums; min-width: 48px; text-align: right; }
.dml-more-wrap { padding: 8px; text-align: center; border-top: 1px solid var(--dml-line); flex: 0 0 auto; }
.dml-more { border-color: var(--dml-line); }
.dml-set { display: flex; flex: 1 1 auto; overflow-y: auto; padding: 12px; flex-direction: column; gap: 8px; }
.dml-set-title { font-weight: 600; margin-top: 6px; }
.dml-set-path { font-size: 11px; opacity: .82; word-break: break-all; padding: 3px 0; }
.dml-set-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dml-set-note { font-size: 11px; opacity: .62; margin-top: 10px; line-height: 1.7; }
.dml-dirlist { max-height: 240px; overflow-y: auto; border: 1px solid var(--dml-line); border-radius: 8px; }
.dml-dir { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 10px; background: transparent; border: 0; border-bottom: 1px solid rgba(128,128,128,.11); color: var(--dml-fg); text-align: left; cursor: pointer; font-size: 12px; font-family: inherit; }
.dml-dir:hover { background: rgba(128,128,128,.16); }
.dml-dir-name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dml-dir-meta { font-size: 10px; opacity: .55; padding: 4px 10px; }
.dml-dir-pick { color: var(--dml-accent); font-weight: 600; }
`

    // ------------------------------------------------------------ 插件入口

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => {
        void boot()
        applyVolume()
        return () => {
          booted = false
          try { audio.pause() } catch (e) { ignored(e) }
          if (audio.parentNode) audio.remove()
        }
      }, 'music-local: audio engine')

      ctx.effect(() => {
        const styleEl = document.createElement('style')
        styleEl.setAttribute('data-plugin', 'dsh-music-local')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl) }
      }, 'music-local: styles')

      ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'music-local-bar', order: 41 },
        () => React.createElement(Mount, { which: 'bar' }),
      )), 'music-local: player bar')

      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'music-local-panel', order: 18 },
        () => React.createElement(Mount, { which: 'panel' }),
      )), 'music-local: player panel')
    }

    exports.apply = apply
    exports.inject = inject

    // ★★ 这一行绝对不能少 ★★
    // 模块系统是 lazy-CJS：factory 的返回值就是这个模块的 exports，
    // 宿主拿到它之后会交给 cordis 的 ctx.plugin()。若 factory 返回 undefined，
    // cordis 会抛
    //   invalid plugin, expect function or object with an "apply" method, received undefined
    // 而这条错误在桌面端是渲染进程启动失败后回报的，日志里只看到
    //   Error: ... at app.asar/lib/main.js:11573  （那其实是 reportFatal 的帧）
    // 极容易被误判成宿主半体或 package.json 声明的问题。官方每个 client 包
    // （含 @deepseek-ai/dsh-client-modules 自己）末尾都是 `return module.exports`。
    // 自检：exports 上没有 apply 时立刻吵出来。这类问题在桌面端的表现是
    // "渲染进程启动失败"（主进程日志里只有一行 reportFatal 的栈），
    // 没有这行提示就得靠反查 asar 才找得到。
    if (typeof module.exports.apply !== 'function') {
      console.error('[music-local] 客户端半体没有导出 apply，播放器不会出现')
    }

    return module.exports
  },
})
