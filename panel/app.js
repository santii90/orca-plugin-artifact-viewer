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
    refreshing: false
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
        state.data = res
        state.requestError = ''
      } else {
        state.requestError = 'Unexpected response from the plugin worker'
      }
      render()
    }).catch(function (err) {
      if (seq !== reqSeq) return
      state.loading = false
      state.requestError = 'Could not load artifacts' + (err && (err.message || err.code) ? ': ' + (err.message || err.code) : '.')
      render()
    })
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

  function openMenu(key, anchor) {
    var it = itemByKey(key)
    if (!it) return
    closeMenu(false)
    menuKey = key
    menuAnchor = anchor
    var pinned = state.data.pins.indexOf(key) >= 0
    var m = el('div', 'av-menu')
    m.setAttribute('role', 'menu')
    var head = it.kind === 'claude' ? M.hostOf(it.url) + '/…' + it.url.slice(-8) : M.fileName(it.filePath)
    m.appendChild(el('div', 'av-menu-head', head))
    var defs = [{ icon: 'browser', label: 'Open in Orca', run: function () { open(key) } }]
    if (it.kind === 'claude' && canOpenExternal && M.isClaudeArtifactUrl(it.url)) defs.push({ icon: 'external', label: 'Open in browser', run: function () { openExternal(key) } })
    defs.push({ icon: 'copy', label: it.kind === 'claude' ? 'Copy link' : 'Copy path', run: function () { copy(key) } })
    defs.push({ icon: 'pin', label: pinned ? 'Unpin' : 'Pin', run: function () { pin(key, !pinned) } })
    defs.forEach(function (d) {
      var b = el('button', 'av-menu-item')
      b.type = 'button'
      b.setAttribute('role', 'menuitem')
      b.appendChild(AV.icon(d.icon))
      b.appendChild(el('span', null, d.label))
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
    menu: openMenu
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
      } else b.textContent = o.label
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
    b.appendChild(el('span', null, label))
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
      { id: 'repo', label: 'This repo' },
      { id: 'worktree', label: 'This worktree' }
    ], state.scope, function (id) {
      state.scope = id
      state.selectedKey = null
      persist()
      state.loading = !state.data
      load()
      renderHeader()
    })

    var cnt = counts()
    var k = $('av-kinds')
    k.textContent = ''
    var setKind = function (v) { return function () { state.kind = v; persist(); render() } }
    k.appendChild(chip('All', state.kind === 'all', state.data ? cnt.all : null, null, setKind('all')))
    k.appendChild(chip('Artifacts', state.kind === 'claude', state.data ? cnt.claude : null, 'av-kind-claude', setKind('claude')))
    k.appendChild(chip('Visuals', state.kind === 'visual', state.data ? cnt.visual : null, 'av-kind-visual', setKind('visual')))
    k.appendChild(chip('Pinned', state.pinsOnly, null, null, function () { state.pinsOnly = !state.pinsOnly; render() }, 'pin'))

    var gb = $('av-groupby')
    gb.hidden = state.view !== 'list'
    if (!gb.hidden) {
      seg(gb, [{ id: 'date', label: 'Date' }, { id: 'session', label: 'Session' }], state.groupBy, function (id) {
        state.groupBy = id
        persist()
        render()
      })
      gb.title = 'Group by'
    }
    $('av-q-clear').hidden = !state.q
  }

  // ---- main render ----
  function empty(iconName, title, text, btn) {
    var d = el('div', 'av-empty')
    var ring = el('div', 'av-empty-ring')
    ring.appendChild(AV.icon(iconName, 'lg'))
    d.appendChild(ring)
    d.appendChild(el('h3', null, title))
    d.appendChild(el('p', null, text))
    if (btn) {
      var b = el('button', 'av-btn', btn.label)
      b.type = 'button'
      b.addEventListener('click', btn.run)
      d.appendChild(b)
    }
    return d
  }

  function skeleton() {
    var wrap = el('div')
    wrap.setAttribute('aria-busy', 'true')
    var widths = [70, 55, 82, 48, 64, 76]
    widths.forEach(function (w) {
      var r = el('div', 'av-skel')
      r.appendChild(el('i'))
      var bar = el('i')
      bar.style.maxWidth = w + '%'
      r.appendChild(bar)
      wrap.appendChild(r)
    })
    return wrap
  }

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
    var ae = document.activeElement
    if (ae && ae !== document.body && $('av-root').contains(ae)) {
      var host = ae.closest('[data-key]')
      if (host) focusedKey = host.getAttribute('data-key')
    }
    var root = $('av-root')
    root.textContent = ''

    var ps = M.panelState({ data: data, requestError: state.requestError, loading: state.loading, query: state.q, kind: state.kind, pinsOnly: state.pinsOnly })
    if (ps.state === 'skeleton') { root.appendChild(skeleton()); return }
    if (ps.state === 'error') {
      if (!state.requestError) root.appendChild(empty('artifact', 'Nothing to show', ps.message))
      return
    }
    if (ps.state === 'no-workspace') { root.appendChild(empty('branch', 'No workspace', ps.message)); return }
    if (ps.state === 'empty-index') {
      root.appendChild(empty('artifact', 'No artifacts yet',
        'This lists claude.ai Artifacts Claude published and HTML visuals it showed in Orca chats, from sessions in this ' + (state.scope === 'repo' ? 'repo.' : 'worktree.')))
      return
    }
    if (ps.state === 'no-results') {
      root.appendChild(empty('search', 'No matches', 'Nothing fits the current search and filters.', { label: 'Clear filters', run: clearFilters }))
      return
    }
    var items = M.filterItems(data.items, { q: state.q, kind: state.kind, pinsOnly: state.pinsOnly }, data.pins)
    var view = AV.views[state.view]
    var vm = {
      items: items,
      sessions: data.sessions || {},
      pins: new Set(data.pins || []),
      context: data.context,
      scope: state.scope,
      now: Date.now(),
      selectedKey: state.selectedKey,
      query: state.q,
      kind: state.kind,
      groupBy: state.groupBy,
      canOpenExternal: canOpenExternal
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
      for (var i = 0; i < cand.length; i++) {
        if (cand[i].getAttribute('data-key') === focusedKey && /^(BUTTON|A)$/.test(cand[i].tagName)) {
          cand[i].focus({ preventScroll: true })
          break
        }
      }
    }
  }

  // ---- wiring ----
  $('av-refresh').appendChild(AV.icon('refresh'))
  $('av-search-icon').appendChild(AV.icon('search'))
  $('av-q-clear').appendChild(AV.icon('x', 'sm'))
  $('av-refresh').addEventListener('click', refresh)
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
