/* Artifacts panel shell: state, header/controls, data loading, actions, overflow menu. */
;(function () {
  var AV = window.AV
  var M = AV.model
  var api = window.orca
  var $ = function (id) { return document.getElementById(id) }
  var VIEW_ORDER = ['list', 'cards', 'sessions']
  var VIEW_LABELS = { list: 'List', cards: 'Cards', sessions: 'Sessions' }
  var STORE = 'av.prefs'

  var state = {
    view: 'list',
    scope: 'repo',
    kind: 'all',
    groupBy: 'date',
    q: '',
    pinsOnly: false,
    data: null,
    loading: true,
    requestError: '',
    selectedKey: null,
    refreshing: false,
    // last known item count per scope, for the scope toggle; reset when the worktree changes
    scopeCounts: { repo: null, worktree: null },
    countsFor: null
  }

  try {
    var saved = JSON.parse(localStorage.getItem(STORE) || '{}')
    if (VIEW_ORDER.indexOf(saved.view) >= 0) state.view = saved.view
    if (saved.scope === 'repo' || saved.scope === 'worktree') state.scope = saved.scope
    if (['all', 'claude', 'visual'].indexOf(saved.kind) >= 0) state.kind = saved.kind
    if (saved.groupBy === 'date' || saved.groupBy === 'session') state.groupBy = saved.groupBy
  } catch (e) {}

  function persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ view: state.view, scope: state.scope, kind: state.kind, groupBy: state.groupBy }))
    } catch (e) {}
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function availableViews() {
    return VIEW_ORDER.filter(function (id) { return AV.views && AV.views[id] && typeof AV.views[id].render === 'function' })
  }

  // ---- toast ----
  var toastTimer
  function toast(text) {
    var t = $('av-toast')
    t.textContent = text
    t.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { t.hidden = true }, 3500)
  }

  // ---- data ----
  var reqSeq = 0
  function itemByKey(key) {
    var items = (state.data && state.data.items) || []
    for (var i = 0; i < items.length; i++) if (items[i].key === key) return items[i]
    return null
  }

  // ---- thumbnails ----
  var THUMB_W = 480
  var THUMB_H = 300
  var thumbRenderTimer

  var thumbQ = M.createThumbQueue({
    request: function (method, params) { return api.plugin.request(method, params) },
    downscale: function (res) { return downscale(res) },
    now: function () { return Date.now() },
    onChange: function () { scheduleThumbRender() },
    max: 3
  })

  function thumbUrl(key) { return thumbQ.url(key) }
  function thumbReason(key) { return thumbQ.reason(key) }

  function scheduleThumbRender() {
    clearTimeout(thumbRenderTimer)
    thumbRenderTimer = setTimeout(function () {
      if (menuEl) return scheduleThumbRender()
      render()
    }, 150)
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image()
      img.onload = function () { resolve(img) }
      img.onerror = function () { reject(new Error('image decode failed')) }
      img.src = src
    })
  }

  /** Crop + cover/top-anchor a raw capture to 480x300 JPEG (q0.8, retry q0.6 above 200 KB). */
  function downscale(res) {
    return loadImage(res.dataUrl).then(function (img) {
      var r = M.coverCropRect(img.naturalWidth, img.naturalHeight, res.crop, THUMB_W, THUMB_H)
      var c = document.createElement('canvas')
      c.width = THUMB_W
      c.height = THUMB_H
      var ctx = c.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, THUMB_W, THUMB_H)
      ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, THUMB_W, THUMB_H)
      var out = c.toDataURL('image/jpeg', 0.8)
      if (M.dataUrlBytes(out) > 200 * 1024) out = c.toDataURL('image/jpeg', 0.6)
      return out
    })
  }

  function wantThumb(key) {
    if (!api || !api.plugin) return
    thumbQ.want(itemByKey(key))
  }

  function load() {
    var seq = ++reqSeq
    if (!api || !api.plugin) {
      state.loading = false
      state.requestError = 'Orca plugin bridge is not available in this frame.'
      render()
      return Promise.resolve()
    }
    return api.plugin.request('artifacts.list', { scope: state.scope }).then(function (res) {
      if (seq !== reqSeq) return
      state.loading = false
      if (res && Array.isArray(res.items) && Array.isArray(res.pins) && res.context) {
        var prevPath = state.data && state.data.context && state.data.context.worktreePath
        if (prevPath && prevPath !== res.context.worktreePath) state.selectedKey = null
        state.data = res
        updateScopeCounts(res)
        thumbQ.bumpList()
        state.requestError = ''
      } else {
        state.data = null
        state.requestError = 'Unexpected response from the plugin worker'
      }
      render()
    }).catch(function (err) {
      if (seq !== reqSeq) return
      state.loading = false
      state.data = null // never keep another workspace's items on screen
      state.requestError = 'Could not load artifacts' + (err && (err.message || err.code) ? ': ' + (err.message || err.code) : '.')
      render()
    })
  }

  function updateScopeCounts(res) {
    var wp = res.context.worktreePath
    if (state.countsFor !== wp) {
      state.countsFor = wp
      state.scopeCounts = { repo: null, worktree: null }
    }
    if (!wp) return
    if (res.scope === 'repo') {
      state.scopeCounts.repo = res.items.length
      state.scopeCounts.worktree = M.countInWorktree(res.items, res.sessions, wp)
    } else if (res.scope === 'worktree') {
      state.scopeCounts.worktree = res.items.length
    }
  }

  var changedTimer
  function scheduleLoad() {
    clearTimeout(changedTimer)
    changedTimer = setTimeout(load, 300)
  }

  function hasPlugin() {
    if (api && api.plugin && typeof api.plugin.request === 'function') return true
    toast('Plugin worker not available')
    return false
  }

  function errMsg(err, fallback) {
    return (err && (err.message || err.code)) || fallback
  }

  function refresh() {
    if (state.refreshing || !hasPlugin()) return
    state.refreshing = true
    renderHeader()
    api.plugin.request('artifacts.refresh', {}).then(function (r) {
      if (r && r.started === false && r.reason) toast(String(r.reason))
    }).catch(function (err) {
      toast('Refresh failed: ' + errMsg(err, 'unknown error'))
    }).then(function () {
      state.refreshing = false
      return load()
    })
  }

  // ---- actions ----
  var copyDlg = null
  function closeCopyDialog() {
    if (copyDlg) copyDlg.remove()
    copyDlg = null
  }

  function showCopyDialog(text, label) {
    closeCopyDialog()
    var d = el('div', 'av-copydlg')
    d.setAttribute('role', 'dialog')
    d.setAttribute('aria-label', 'Copy ' + label)
    d.appendChild(el('div', 'av-copydlg-h', 'Press Ctrl+C to copy the ' + label))
    var inp = document.createElement('input')
    inp.type = 'text'
    inp.readOnly = true
    inp.value = text
    inp.setAttribute('aria-label', label)
    d.appendChild(inp)
    var b = el('button', 'av-btn', 'Close')
    b.type = 'button'
    b.addEventListener('click', closeCopyDialog)
    d.appendChild(b)
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeCopyDialog() }
    })
    document.body.appendChild(d)
    copyDlg = d
    inp.focus()
    inp.select()
  }

  function copyText(text, label) {
    function fallback() {
      var t = document.createElement('textarea')
      t.value = text
      t.style.position = 'fixed'
      t.style.opacity = '0'
      document.body.appendChild(t)
      t.select()
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) {}
      t.remove()
      if (ok) toast('Copied ' + label)
      else showCopyDialog(text, label)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied ' + label) }, fallback)
    } else fallback()
  }

  function copy(key) {
    var it = itemByKey(key)
    if (!it) return toast('Item no longer in the list \u2014 refresh')
    if (it.kind === 'claude') copyText(it.url, 'link')
    else copyText(it.filePath || it.url, 'path')
  }

  function open(key) {
    if (!hasPlugin()) return
    api.plugin.request('artifacts.open', { key: key }).then(function (r) {
      if (!r || !r.ok) toast((r && r.reason) || 'Could not open that item')
    }).catch(function (err) { toast('Could not open that item: ' + errMsg(err, 'unknown error')) })
  }

  var canOpenExternal = !!(api && api.shell && typeof api.shell.openExternal === 'function')

  function openExternal(key) {
    var it = itemByKey(key)
    if (!it) return toast('Item no longer in the list \u2014 refresh')
    if (!canOpenExternal) return
    if (it.kind !== 'claude' || !M.isClaudeArtifactUrl(it.url)) return toast('Only claude.ai artifact links can be opened in the browser')
    api.shell.openExternal(it.url).then(function (r) {
      if (!r || r.opened) return
      if (r.reason === 'cancelled') return
      toast('Could not open the browser' + (r.reason ? ': ' + r.reason : ''))
    }).catch(function (err) { toast('Could not open the browser: ' + errMsg(err, 'unknown error')) })
  }

  function pin(key, pinned) {
    if (!state.data || !hasPlugin()) return
    var before = state.data.pins.slice()
    var next = before.filter(function (k) { return k !== key })
    if (pinned) next.unshift(key)
    state.data.pins = next
    render()
    api.plugin.request('artifacts.pin', { key: key, pinned: !!pinned }).then(function (r) {
      if (r && Array.isArray(r.pins) && state.data) {
        state.data.pins = r.pins
        render()
      }
    }).catch(function (err) {
      if (state.data) state.data.pins = before
      render()
      toast('Could not update pin: ' + errMsg(err, 'unknown error'))
    })
  }

  function select(key) {
    state.selectedKey = key
    render()
  }

  // ---- overflow menu ----
  var menuEl = null
  var menuAnchor = null
  var menuKey = null

  function closeMenu(restoreFocus) {
    if (!menuEl) return
    menuEl.remove()
    menuEl = null
    var a = menuAnchor
    menuAnchor = null
    menuKey = null
    document.querySelectorAll('.is-menu').forEach(function (n) { n.classList.remove('is-menu') })
    if (a) {
      a.removeAttribute('aria-expanded')
      if (restoreFocus && a.isConnected) a.focus()
    }
  }

  /** claude.ai/artifact/9c41e7a2…f03d */
  function menuUrl(url) {
    var u = String(url || '').replace(/^https?:\/\//, '')
    return u.length > 34 ? u.slice(0, 26) + '\u2026' + u.slice(-4) : u
  }

  function canExternal(it) {
    return !!(it && it.kind === 'claude' && canOpenExternal && M.isClaudeArtifactUrl(it.url))
  }

  /** Row/card keyboard shortcuts shared by the views (plain Enter is handled by each view). */
  function rowKeydown(e, key, anchor) {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      openMenu(key, anchor)
      return true
    }
    if (e.key === 'Enter' && e.shiftKey) {
      var it = itemByKey(key)
      if (canExternal(it)) {
        e.preventDefault()
        openExternal(key)
        return true
      }
      return false
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      var sel = window.getSelection && window.getSelection()
      if (sel && String(sel).length) return false
      e.preventDefault()
      copy(key)
      return true
    }
    if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      pin(key, !(state.data && state.data.pins.indexOf(key) >= 0))
      return true
    }
    return false
  }

  function openMenu(key, anchor) {
    var it = itemByKey(key)
    if (!it) return
    closeMenu(false)
    menuKey = key
    menuAnchor = anchor
    var pinned = state.data.pins.indexOf(key) >= 0
    var m = el('div', 'av-menu')
    m.setAttribute('role', 'menu')
    var head = it.kind === 'claude' ? menuUrl(it.url) : M.fileName(it.filePath)
    var mh = el('div', 'av-menu-head', head)
    mh.title = it.kind === 'claude' ? it.url : (it.filePath || '')
    m.appendChild(mh)
    var defs = [{ icon: 'browser', label: 'Open in Orca browser', kbd: '\u21b5', run: function () { open(key) } }]
    if (canExternal(it)) defs.push({ icon: 'external', label: 'Open in external browser', kbd: 'Shift \u21b5', run: function () { openExternal(key) } })
    defs.push({ icon: 'copy', label: it.kind === 'claude' ? 'Copy link' : 'Copy file path', kbd: 'Ctrl C', run: function () { copy(key) } })
    defs.push('sep')
    defs.push({ icon: 'pin', label: pinned ? 'Unpin' : 'Pin to top', kbd: 'P', run: function () { pin(key, !pinned) } })
    defs.forEach(function (d) {
      if (d === 'sep') {
        var sp = el('div', 'av-menu-sep')
        sp.setAttribute('role', 'separator')
        m.appendChild(sp)
        return
      }
      var b = el('button', 'av-menu-item')
      b.type = 'button'
      b.setAttribute('role', 'menuitem')
      b.appendChild(AV.icon(d.icon))
      b.appendChild(el('span', null, d.label))
      if (d.kbd) {
        var k = el('kbd', null, d.kbd)
        k.setAttribute('aria-hidden', 'true')
        b.appendChild(k)
      }
      b.addEventListener('click', function () {
        closeMenu(false)
        d.run()
      })
      m.appendChild(b)
    })
    document.body.appendChild(m)
    menuEl = m
    anchor.setAttribute('aria-expanded', 'true')
    var host = anchor.closest('[data-key]')
    if (host) host.classList.add('is-menu')
    // position below the anchor, right-aligned, clamped to the viewport
    var r = anchor.getBoundingClientRect()
    var w = m.offsetWidth
    var h = m.offsetHeight
    var left = Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w))
    var top = r.bottom + 4
    if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 4)
    m.style.left = left + 'px'
    m.style.top = top + 'px'
    m.querySelector('.av-menu-item').focus()
    m.addEventListener('keydown', function (e) {
      // the shortcut shown next to Pin also works while the menu is open
      if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        closeMenu(true)
        pin(key, !pinned)
      }
    })
  }

  document.addEventListener('pointerdown', function (e) {
    if (menuEl && !menuEl.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu(false)
  }, true)
  document.addEventListener('keydown', function (e) {
    if (!menuEl) return
    var items = Array.prototype.slice.call(menuEl.querySelectorAll('.av-menu-item'))
    var i = items.indexOf(document.activeElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu(true)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(i + 1) % items.length].focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i - 1 + items.length) % items.length].focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0].focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1].focus()
    } else if (e.key === 'Tab') {
      closeMenu(false)
    }
  }, true)
  $('av-scroll').addEventListener('scroll', function () { closeMenu(false) })
  window.addEventListener('resize', function () { closeMenu(false) })

  var actions = {
    open: open,
    openExternal: openExternal,
    copy: copy,
    pin: pin,
    select: select,
    menu: openMenu,
    keydown: rowKeydown,
    wantThumb: wantThumb
  }

  // ---- controls ----
  function seg(container, opts, current, onPick, iconOnly) {
    container.textContent = ''
    opts.forEach(function (o) {
      var b = el('button')
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', o.id === current ? 'true' : 'false')
      b.title = o.title || o.label
      if (iconOnly) {
        b.setAttribute('aria-label', o.label)
        b.appendChild(AV.icon(o.id))
      } else {
        b.appendChild(el('span', null, o.label))
        if (o.count != null) b.appendChild(el('span', 'av-n', String(o.count)))
      }
      b.addEventListener('click', function () { if (o.id !== current) onPick(o.id) })
      container.appendChild(b)
    })
  }

  function counts() {
    var c = { all: 0, claude: 0, visual: 0 }
    var data = state.data
    if (!data) return c
    M.filterItems(data.items, { q: state.q, pinsOnly: state.pinsOnly, kind: 'all' }, data.pins).forEach(function (it) {
      c.all++
      c[it.kind]++
    })
    return c
  }

  function chip(label, on, count, dotClass, onClick, icon) {
    var b = el('button', 'av-chip' + (on ? ' on' : ''))
    b.type = 'button'
    b.setAttribute('aria-pressed', on ? 'true' : 'false')
    if (dotClass) {
      var d = el('span', 'av-dot ' + dotClass)
      b.appendChild(d)
    }
    if (icon) b.appendChild(AV.icon(icon, 'sm'))
    if (label) b.appendChild(el('span', null, label))
    if (count != null) b.appendChild(el('span', 'av-n', String(count)))
    b.addEventListener('click', onClick)
    return b
  }

  function renderHeader() {
    var views = availableViews()
    if (views.indexOf(state.view) < 0) state.view = views[0] || 'list'
    var vs = $('av-views')
    vs.hidden = views.length < 2
    seg(vs, views.map(function (id) { return { id: id, label: VIEW_LABELS[id] } }), state.view, function (id) {
      state.view = id
      persist()
      render()
    }, true)

    var rb = $('av-refresh')
    rb.classList.toggle('av-refreshing', state.refreshing || !!(state.data && state.data.indexing))
    rb.disabled = state.refreshing

    var ctx = $('av-ctx')
    ctx.textContent = ''
    var c = state.data && state.data.context
    if (c && (c.repoName || c.worktreeName)) {
      ctx.appendChild(AV.icon('branch', 'sm'))
      var s = el('span')
      if (c.repoName) s.appendChild(document.createTextNode(c.repoName + (c.worktreeName ? ' / ' : '')))
      if (c.worktreeName) s.appendChild(el('b', null, c.worktreeName))
      ctx.appendChild(s)
    }

    seg($('av-scope'), [
      { id: 'repo', label: 'This repo', count: state.scopeCounts.repo },
      { id: 'worktree', label: 'This worktree', count: state.scopeCounts.worktree }
    ], state.scope, setScope)

    var cnt = counts()
    var k = $('av-kinds')
    k.textContent = ''
    var setKind = function (v) { return function () { state.kind = v; persist(); render() } }
    k.appendChild(chip('All', state.kind === 'all', state.data ? cnt.all : null, null, setKind('all')))
    k.appendChild(chip('Artifacts', state.kind === 'claude', state.data ? cnt.claude : null, 'av-kind-claude', setKind('claude')))
    k.appendChild(chip('Visuals', state.kind === 'visual', state.data ? cnt.visual : null, 'av-kind-visual', setKind('visual')))
    var pc = chip('', state.pinsOnly, null, null, function () { state.pinsOnly = !state.pinsOnly; render() }, 'pin')
    pc.classList.add('av-chip-icon')
    pc.title = state.pinsOnly ? 'Showing pinned only' : 'Show pinned only'
    pc.setAttribute('aria-label', 'Pinned only')
    k.appendChild(pc)

    var gb = $('av-groupby')
    gb.hidden = state.view !== 'list'
    if (!gb.hidden) {
      var cur = state.groupBy === 'session' ? 'Session' : 'Date'
      var nxt = state.groupBy === 'session' ? 'date' : 'session'
      gb.textContent = ''
      gb.appendChild(el('span', null, 'Group'))
      gb.appendChild(el('b', null, cur))
      gb.appendChild(AV.icon('chevron', 'sm'))
      gb.title = 'Grouped by ' + cur.toLowerCase() + ' \u2014 click to group by ' + nxt
      gb.setAttribute('aria-label', 'Group by ' + cur.toLowerCase() + '. Activate to group by ' + nxt)
    }
    $('av-q-clear').hidden = !state.q
    $('av-q-kbd').hidden = !!state.q
  }

  function renderFooter(shownCount) {
    var f = $('av-foot')
    var d = state.data
    if (!d || !d.context || !d.context.worktreePath) { f.hidden = true; return }
    f.hidden = false
    var st = M.syncStatus({ indexing: d.indexing || state.refreshing, lastIndexedAt: d.lastIndexedAt, error: state.requestError, now: Date.now() })
    f.classList.toggle('is-busy', st.tone === 'busy')
    f.classList.toggle('is-err', st.tone === 'err')
    var sync = $('av-foot-sync')
    sync.textContent = st.text
    sync.title = d.lastIndexedAt ? 'Last indexed ' + M.fullTime(d.lastIndexedAt) : ''
    var total = (d.items || []).length
    $('av-foot-n').textContent = shownCount != null && shownCount !== total ? shownCount + ' of ' + M.plural(total, 'item') : M.plural(total, 'item')
  }

  // ---- main render ----
  /** btns: [{ label, run, primary?, icon? }]. */
  function empty(iconName, title, text, btns) {
    var d = el('div', 'av-empty')
    var ring = el('div', 'av-empty-ring')
    ring.appendChild(AV.icon(iconName, 'lg'))
    d.appendChild(ring)
    d.appendChild(el('h3', null, title))
    d.appendChild(el('p', null, text))
    btns = btns || []
    if (btns.length) {
      var acts = el('div', 'av-empty-acts')
      btns.forEach(function (btn) {
        var b = el('button', 'av-btn' + (btn.primary ? ' av-btn-pri' : ''))
        b.type = 'button'
        if (btn.icon) b.appendChild(AV.icon(btn.icon, 'sm'))
        b.appendChild(document.createTextNode(btn.label))
        b.addEventListener('click', btn.run)
        acts.appendChild(b)
      })
      d.appendChild(acts)
    }
    return d
  }

  function skeleton() {
    var wrap = el('div', 'av-skel-wrap')
    wrap.setAttribute('aria-busy', 'true')
    wrap.setAttribute('aria-label', 'Loading artifacts')
    var rows = [null, 180, 130, 210, null, 150, 190, 120]
    rows.forEach(function (w) {
      var r = el('div', 'av-skel' + (w == null ? ' av-skel-head' : ''))
      if (w == null) {
        r.appendChild(el('i'))
        wrap.appendChild(r)
        return
      }
      r.appendChild(el('i', 'av-sk-kind'))
      var bar = el('i', 'av-sk-text')
      bar.style.maxWidth = w + 'px'
      r.appendChild(bar)
      r.appendChild(el('i', 'av-sk-time'))
      wrap.appendChild(r)
    })
    return wrap
  }

  function setScope(id) {
    if (state.scope === id) return
    state.scope = id
    state.selectedKey = null
    persist()
    state.loading = !state.data
    load()
    renderHeader()
  }

  var refreshBtn = { label: 'Refresh', icon: 'refresh', run: function () { refresh() } }

  function clearFilters() {
    state.q = ''
    state.kind = 'all'
    state.pinsOnly = false
    $('av-q').value = ''
    persist()
    render()
  }

  function render() {
    try {
      doRender()
    } catch (e) {
      var msg = (e && e.message) || String(e)
      var banner = $('av-banner')
      banner.textContent = ''
      banner.hidden = false
      banner.appendChild(AV.icon('alert', 'sm'))
      banner.appendChild(el('span', null, 'Panel failed to render: ' + msg))
      var r = $('av-root')
      r.textContent = ''
      r.appendChild(empty('alert', 'Panel failed to render', msg))
    }
  }

  function doRender() {
    closeMenu(false)
    renderHeader()
    var data = state.data
    var banner = $('av-banner')
    var message = state.requestError || (data && data.error && data.context && data.context.worktreePath ? data.error : '')
    banner.textContent = ''
    banner.hidden = !message
    if (message) {
      banner.appendChild(AV.icon('alert', 'sm'))
      banner.appendChild(el('span', null, message))
    }

    var scroll = $('av-scroll')
    var top = scroll.scrollTop
    var focusedKey = null
    var focusedCls = null
    var ae = document.activeElement
    if (ae && ae !== document.body && $('av-root').contains(ae)) {
      var host = ae.closest('[data-key]')
      if (host) {
        focusedKey = host.getAttribute('data-key')
        // The same key can appear on several elements (e.g. a pinned pill and its row): remember which.
        focusedCls = host.classList[0] || null
      }
    }
    var root = $('av-root')
    root.textContent = ''

    var ps = M.panelState({ data: data, requestError: state.requestError, loading: state.loading, query: state.q, kind: state.kind, pinsOnly: state.pinsOnly })
    renderFooter(null)
    if (ps.state === 'skeleton') { root.appendChild(skeleton()); return }
    if (ps.state === 'error') {
      if (!state.requestError) root.appendChild(empty('alert', 'Nothing to show', ps.message, [refreshBtn]))
      return
    }
    if (ps.state === 'no-workspace') { root.appendChild(empty('branch', 'No workspace', ps.message)); return }
    if (ps.state === 'empty-index') {
      var ctx = data.context || {}
      if (state.scope === 'worktree') {
        root.appendChild(empty('sparkles', 'Nothing generated in ' + (ctx.worktreeName || 'this worktree') + ' yet',
          'Artifacts and inline visuals Claude creates in this worktree\u2019s chats show up here.',
          [{ label: 'Show the whole repo', primary: true, run: function () { setScope('repo') } }, refreshBtn]))
      } else {
        root.appendChild(empty('sparkles', 'Nothing generated in ' + (ctx.repoName || 'this repo') + ' yet',
          'claude.ai Artifacts Claude publishes and HTML visuals it shows in Orca chats, in any worktree of this repo, show up here.',
          [refreshBtn]))
      }
      return
    }
    if (ps.state === 'no-results') {
      root.appendChild(empty('search', 'No matches', 'Nothing fits the current search and filters.', [{ label: 'Clear filters', primary: true, run: clearFilters }]))
      renderFooter(0)
      return
    }
    var items = M.filterItems(data.items, { q: state.q, kind: state.kind, pinsOnly: state.pinsOnly }, data.pins)
    renderFooter(items.length)
    var view = AV.views[state.view]
    var vm = {
      items: items,
      sessions: data.sessions || {},
      pins: new Set(data.pins || []),
      pinOrder: (data.pins || []).slice(),
      context: data.context,
      scope: state.scope,
      now: Date.now(),
      selectedKey: state.selectedKey,
      query: state.q,
      kind: state.kind,
      groupBy: state.groupBy,
      canOpenExternal: canOpenExternal,
      thumbUrl: thumbUrl,
      thumbReason: thumbReason
    }
    try {
      view.render(root, vm, actions)
    } catch (e) {
      root.textContent = ''
      root.appendChild(empty('alert', 'View failed', String((e && e.message) || e)))
    }
    scroll.scrollTop = top
    if (focusedKey) {
      var cand = root.querySelectorAll('[data-key]')
      var firstMatch = null
      var target = null
      for (var i = 0; i < cand.length; i++) {
        var c = cand[i]
        if (c.getAttribute('data-key') !== focusedKey) continue
        if (!(c.tabIndex >= 0 || /^(BUTTON|A)$/.test(c.tagName))) continue
        if (!firstMatch) firstMatch = c
        if (focusedCls && c.classList.contains(focusedCls)) { target = c; break }
      }
      target = target || firstMatch
      if (target) target.focus({ preventScroll: true })
    }
  }

  // ---- wiring ----
  $('av-refresh').appendChild(AV.icon('refresh'))
  $('av-search-icon').appendChild(AV.icon('search'))
  $('av-q-clear').appendChild(AV.icon('x', 'sm'))
  $('av-refresh').addEventListener('click', refresh)
  $('av-groupby').addEventListener('click', function () {
    state.groupBy = state.groupBy === 'session' ? 'date' : 'session'
    persist()
    render()
  })
  var qTimer
  $('av-q').addEventListener('input', function (e) {
    state.q = e.target.value
    clearTimeout(qTimer)
    qTimer = setTimeout(render, 60)
  })
  $('av-q').addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.q) {
      e.preventDefault()
      e.target.value = ''
      state.q = ''
      render()
    }
  })
  $('av-q-clear').addEventListener('click', function () {
    $('av-q').value = ''
    state.q = ''
    render()
    $('av-q').focus()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement !== $('av-q')) {
      e.preventDefault()
      $('av-q').focus()
    }
  })

  if (api && api.plugin && typeof api.plugin.on === 'function') api.plugin.on('artifacts.changed', scheduleLoad)
  else setInterval(function () { if (!document.hidden) load() }, 30000)
  setInterval(function () { if (state.data && !menuEl) render() }, 60000)

  render()
  load()
})()
