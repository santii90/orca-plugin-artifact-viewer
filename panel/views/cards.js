/* Cards view (mock 2): pinned rail + responsive grid of cards with kind-styled placeholder covers and preview thumbnails. */
(function () {
  'use strict'

  var root = typeof window !== 'undefined' ? window : globalThis
  var AV = (root.AV = root.AV || {})
  AV.views = AV.views || {}

  var PAGE = 12
  // how many grid cards are shown ("Show N more" grows it); survives re-renders
  var paging = { shown: PAGE }

  function M() {
    return AV.model
  }

  function hash(str) {
    var h = 2166136261
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }

  var PATTERNS = ['dots', 'grid', 'diag', 'rings']

  /** Deterministic cover parameters from the item key. */
  function coverSeed(key) {
    var h = hash(String(key))
    var hue = h % 360
    return {
      hue: hue,
      hue2: (hue + 35 + ((h >>> 9) % 50)) % 360,
      angle: 120 + ((h >>> 5) % 80),
      pattern: PATTERNS[(h >>> 13) % PATTERNS.length],
      variant: (h >>> 7) % 997,
      shift: (h >>> 17) % 5
    }
  }

  var TYPE_TAGS = [
    [/deck|slide/i, 'Deck'],
    [/doc/i, 'Doc'],
    [/dashboard/i, 'Dashboard'],
    [/design/i, 'Design'],
    [/sheet|spreadsheet/i, 'Sheet']
  ]

  /** artifactType is an opaque URL today; only well-known words map to a tag. */
  function typeTag(item) {
    if (item.kind !== 'claude') return ''
    var t = item.artifactType
    if (!t) return ''
    for (var i = 0; i < TYPE_TAGS.length; i++) if (TYPE_TAGS[i][0].test(t)) return TYPE_TAGS[i][1]
    return ''
  }

  function host(item) {
    if (item.kind === 'claude') {
      try {
        return M().hostOf(item.url) || 'claude.ai'
      } catch (e) {
        return 'claude.ai'
      }
    }
    return 'local file'
  }

  // Placeholder illustrations per kind (mock 2's kind-styled covers); picked by the seed.
  var TEMPLATES = { claude: ['frames', 'dash', 'timeline', 'doc'], visual: ['bars', 'area', 'flow', 'bars'] }
  var TAG_TEMPLATE = { Deck: 'frames', Doc: 'doc', Dashboard: 'dash', Design: 'frames', Sheet: 'dash' }

  function describeCover(item) {
    var seed = coverSeed(item.key)
    var tag = typeTag(item)
    var list = TEMPLATES[item.kind === 'visual' ? 'visual' : 'claude']
    return {
      type: 'generated',
      seed: seed,
      template: TAG_TEMPLATE[tag] || list[seed.variant % list.length],
      icon: item.kind === 'visual' ? 'visual' : 'artifact',
      host: host(item),
      tag: tag
    }
  }

  function sessionTitle(vm, item) {
    var ids = item.sessionIds || []
    var s = ids.length && vm.sessions ? vm.sessions[ids[ids.length - 1]] : null
    return (s && s.title) || ''
  }

  function describeCard(item, vm, pinned) {
    var m = M()
    var wt = ''
    try {
      wt = m.worktreeLabel(item.lastCwd, (vm.context && vm.context.worktrees) || []) || ''
    } catch (e) {}
    return {
      key: item.key,
      kind: item.kind,
      title: item.title || 'Untitled',
      description: item.description || '',
      pinned: pinned,
      selected: vm.selectedKey === item.key,
      cover: describeCover(item),
      thumbUrl: (vm.thumbUrl && vm.thumbUrl(item.key)) || null,
      thumbReason: (vm.thumbReason && vm.thumbReason(item.key)) || null,
      meta: {
        worktree: wt,
        source: sessionTitle(vm, item) || wt,
        time: m.relTime(item.updatedAt, vm.now),
        fullTime: m.fullTime(item.updatedAt),
        version: m.versionBadge(item)
      }
    }
  }

  /** Pure description of the view: { pinned: Card[], cards: Card[] }; pinned follow the pin order when given. */
  function layout(vm) {
    var items = (vm && vm.items) || []
    var pins = (vm && vm.pins) || new Set()
    var pinned = []
    var rest = []
    items.forEach(function (it) {
      if (pins.has(it.key)) pinned.push(describeCard(it, vm, true))
      else rest.push(describeCard(it, vm, false))
    })
    var order = vm && vm.pinOrder
    if (order && order.length) {
      pinned.sort(function (a, b) { return order.indexOf(a.key) - order.indexOf(b.key) })
    }
    return { pinned: pinned, cards: rest }
  }

  // ---- DOM ----------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function iconBtn(name, label, cls) {
    var b = el('button', 'av-iconbtn ' + (cls || ''))
    b.type = 'button'
    b.title = label
    b.setAttribute('aria-label', label)
    b.appendChild(AV.icon(name, 'sm'))
    return b
  }

  var NS = 'http://www.w3.org/2000/svg'
  function sv(parent, tag, cls, attrs) {
    var n = document.createElementNS(NS, tag)
    if (cls) n.setAttribute('class', cls)
    for (var k in attrs) n.setAttribute(k, String(attrs[k]))
    parent.appendChild(n)
    return n
  }
  function r(p, cls, x, y, w, h, rx) {
    return sv(p, 'rect', cls, { x: x, y: y, width: w, height: h, rx: rx == null ? Math.min(h / 2, 3) : rx })
  }

  /** Inline SVG placeholder (160x100, sliced to the thumb's aspect). Colors come from CSS classes. */
  function coverArt(c) {
    var s = c.seed
    var svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('class', 'av-cards-art')
    svg.setAttribute('viewBox', '0 0 160 100')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice')
    svg.setAttribute('aria-hidden', 'true')
    r(svg, 'bg', 0, 0, 160, 100, 0)
    var cs = ['c1', 'c2', 'c3', 'c4', 'c5']
    var col = function (i) { return cs[(i + s.shift) % cs.length] }
    var i
    switch (c.template) {
      case 'bars': {
        r(svg, 'ln2', 12, 12, 56, 5)
        var ws = [98, 74, 56, 40, 28]
        for (i = 0; i < 5; i++) {
          r(svg, 'ln', 12, 30 + i * 12, 22, 4, 2)
          r(svg, col(i), 40, 29 + i * 12, ws[(i + s.shift) % 5], 6, 2)
        }
        break
      }
      case 'area': {
        r(svg, 'ln2', 12, 12, 48, 5)
        r(svg, 'ln', 12, 21, 30, 3, 1.5)
        for (i = 0; i < 4; i++) r(svg, 'ln', 12, 40 + i * 14, 136, 0.8, 0)
        var ys = [74, 66, 70, 52, 58, 44, 50, 36]
        var pts = ys.map(function (y, j) { return (12 + j * 19.4).toFixed(1) + ',' + (y - ((s.variant >> j) & 3) * 2) })
        sv(svg, 'path', 'a1', { d: 'M12,86 L' + pts.join(' L') + ' L148,86 Z' })
        sv(svg, 'path', 's1', { d: 'M' + pts.join(' L') })
        break
      }
      case 'flow': {
        sv(svg, 'rect', 'fr', { x: 10, y: 18, width: 38, height: 64, rx: 5 })
        r(svg, col(1), 16, 26, 18, 10, 2)
        r(svg, 'ln', 16, 42, 24, 3, 1.5)
        r(svg, 'ln', 16, 48, 18, 3, 1.5)
        r(svg, col(0), 16, 70, 26, 5, 2)
        sv(svg, 'rect', 'fr', { x: 61, y: 18, width: 38, height: 64, rx: 5 })
        r(svg, 'ln2', 67, 26, 20, 4, 2)
        r(svg, 'pn2', 67, 36, 26, 8, 2)
        r(svg, 'pn2', 67, 48, 26, 8, 2)
        r(svg, col(0), 67, 70, 26, 5, 2)
        sv(svg, 'rect', 'fr', { x: 112, y: 18, width: 38, height: 64, rx: 5 })
        r(svg, 'ln2', 118, 26, 24, 4, 2)
        r(svg, 'ln', 118, 36, 26, 3, 1.5)
        r(svg, 'ln', 118, 42, 20, 3, 1.5)
        r(svg, col(2), 118, 70, 26, 5, 2)
        sv(svg, 'path', 'ed', { d: 'M50 50 H59 M101 50 H110' })
        break
      }
      case 'dash': {
        r(svg, 'pn', 0, 0, 30, 100, 0)
        r(svg, 'ln', 6, 10, 18, 4, 2)
        for (i = 0; i < 4; i++) r(svg, 'ln', 6, 22 + i * 7, 12 + ((i * 5 + s.shift) % 8), 3, 1.5)
        r(svg, 'ln2', 38, 10, 46, 5)
        for (i = 0; i < 5; i++) {
          r(svg, 'pn2', 38, 22 + i * 14, 114, 10, 2)
          r(svg, col(i), 41, 24.5 + i * 14, 12, 5, 2)
          r(svg, 'ln', 58, 25.5 + i * 14, 40 + ((i * 17 + s.variant) % 50), 3, 1.5)
        }
        break
      }
      case 'timeline': {
        r(svg, 'ln2', 14, 14, 80, 6)
        r(svg, 'ln', 14, 25, 110, 3, 1.5)
        r(svg, 'ln', 14, 31, 92, 3, 1.5)
        r(svg, 'ln', 14, 60, 132, 2, 1)
        for (i = 0; i < 4; i++) {
          sv(svg, 'circle', col(i), { cx: 24 + i * 38, cy: 61, r: 5 })
          r(svg, 'ln', 12 + i * 38, 72, 26, 3, 1.5)
          r(svg, 'ln', 12 + i * 38, 78, 18 + ((i + s.shift) % 3) * 3, 3, 1.5)
        }
        break
      }
      case 'doc': {
        r(svg, 'pn', 26, 8, 108, 100, 4)
        r(svg, 'ln2', 36, 18, 64, 6)
        r(svg, 'ln', 36, 30, 88, 3, 1.5)
        r(svg, 'ln', 36, 36, 80, 3, 1.5)
        r(svg, 'a1', 36, 45, 88, 22, 3)
        r(svg, col(0), 36, 45, 3, 22, 1.5)
        r(svg, 'ln', 36, 74, 86, 3, 1.5)
        r(svg, 'ln', 36, 80, 70, 3, 1.5)
        r(svg, 'ln', 36, 86, 78, 3, 1.5)
        break
      }
      default: {
        // 'frames': three app screens on a dotted canvas
        var pat = sv(svg, 'pattern', null, { id: 'avd' + s.variant, width: 8, height: 8, patternUnits: 'userSpaceOnUse' })
        sv(pat, 'circle', 'dot', { cx: 1, cy: 1, r: 1 })
        sv(svg, 'rect', null, { width: 160, height: 100, fill: 'url(#avd' + s.variant + ')' })
        sv(svg, 'rect', 'fr', { x: 14, y: 16, width: 38, height: 76, rx: 5 })
        r(svg, col(0), 19, 22, 20, 4, 2)
        r(svg, 'ln', 19, 30, 28, 3, 1.5)
        r(svg, 'ln', 19, 35, 22, 3, 1.5)
        r(svg, 'a1', 19, 42, 28, 20, 3)
        r(svg, 'ln', 19, 68, 26, 3, 1.5)
        sv(svg, 'rect', 'fr', { x: 61, y: 10, width: 38, height: 76, rx: 5 })
        r(svg, 'ln2', 66, 16, 16, 3, 1.5)
        for (i = 0; i < 3; i++) {
          r(svg, 'pn2', 66, 24 + i * 14, 28, 10, 2)
          sv(svg, 'circle', col(i + 1), { cx: 70, cy: 29 + i * 14, r: 2.2 })
        }
        sv(svg, 'rect', 'fr', { x: 108, y: 20, width: 38, height: 76, rx: 5 })
        r(svg, 'ln2', 113, 26, 20, 3, 1.5)
        r(svg, 'ln', 113, 33, 28, 3, 1.5)
        r(svg, 'ln', 113, 38, 28, 3, 1.5)
        r(svg, 'ln', 113, 43, 18, 3, 1.5)
        r(svg, col(0), 113, 82, 28, 7, 2)
      }
    }
    return svg
  }

  /** Preview image over the placeholder; the placeholder stays when it fails to load. */
  function thumbImg(url) {
    var img = document.createElement('img')
    img.className = 'av-cards-img'
    img.alt = ''
    img.decoding = 'async'
    img.draggable = false
    img.addEventListener('load', function () { img.classList.add('is-on') })
    img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img) })
    img.src = url
    return img
  }

  function renderCard(card, actions, io, inRail) {
    var art = el('article', 'av-cards-card' + (card.selected ? ' is-sel' : ''))
    art.tabIndex = 0
    art.dataset.key = card.key
    art.setAttribute('aria-label', card.title)
    if (io) io.observe(art)
    else if (actions.wantThumb) actions.wantThumb(card.key)

    var thumb = el('div', 'av-cards-thumb')
    thumb.appendChild(coverArt(card.cover))
    if (card.thumbUrl) thumb.appendChild(thumbImg(card.thumbUrl))
    else if (card.thumbReason) thumb.title = 'No preview: ' + card.thumbReason

    var badge = el('span', 'av-cards-kind av-cards-kind-' + card.kind)
    badge.appendChild(AV.icon(card.kind === 'visual' ? 'visual' : 'artifact'))
    badge.appendChild(document.createTextNode(card.cover.tag || (card.kind === 'visual' ? 'Visual' : 'Artifact')))
    thumb.appendChild(badge)
    if (card.pinned) {
      var pb = el('span', 'av-cards-pinmark')
      pb.title = 'Pinned'
      pb.appendChild(AV.icon('pin', 'sm', 'av-icon-filled'))
      thumb.appendChild(pb)
    }

    var ovl = el('div', 'av-cards-ovl')
    var open = el('button', 'av-cards-open')
    open.type = 'button'
    open.tabIndex = -1
    open.appendChild(AV.icon('browser', 'sm'))
    open.appendChild(document.createTextNode('Open'))
    open.addEventListener('click', function (e) {
      e.stopPropagation()
      actions.select(card.key)
      actions.open(card.key)
    })
    ovl.appendChild(open)
    thumb.appendChild(ovl)
    art.appendChild(thumb)

    var meta = el('div', 'av-cards-meta')
    var mt = el('div', 'av-cards-mt')
    var ct = el('div', 'av-cards-title', card.title)
    ct.title = card.title
    mt.appendChild(ct)
    if (inRail && card.description) mt.appendChild(el('div', 'av-cards-desc', card.description))
    var cm = el('div', 'av-cards-cm')
    if (card.meta.version) cm.appendChild(el('span', 'av-cards-ver', card.meta.version))
    var tm = el('span', 'av-cards-time', card.meta.time)
    tm.title = card.meta.fullTime
    cm.appendChild(tm)
    if (card.meta.source) {
      cm.appendChild(el('span', 'av-cards-dot', '·'))
      var src = el('span', 'av-cards-src', card.meta.source)
      src.title = card.meta.source + (card.meta.worktree && card.meta.worktree !== card.meta.source ? ' — ' + card.meta.worktree : '')
      cm.appendChild(src)
    }
    mt.appendChild(cm)
    meta.appendChild(mt)
    var more = iconBtn('more', 'More actions', 'av-iconbtn-sm av-cards-more')
    more.setAttribute('aria-haspopup', 'menu')
    more.addEventListener('click', function (e) {
      e.stopPropagation()
      actions.menu(card.key, more)
    })
    meta.appendChild(more)
    art.appendChild(meta)

    art.addEventListener('click', function () {
      actions.select(card.key)
      actions.open(card.key)
    })
    art.addEventListener('keydown', function (e) {
      if (e.target !== art) return
      if (actions.keydown && actions.keydown(e, card.key, more)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        actions.select(card.key)
        actions.open(card.key)
      }
    })
    art.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      actions.menu(card.key, more)
    })
    return art
  }

  function sectionHead(icon, label, n) {
    var h = el('div', 'av-cards-sh')
    if (icon) h.appendChild(AV.icon(icon, 'sm', 'av-icon-filled av-cards-shpin'))
    h.appendChild(el('span', null, label))
    h.appendChild(el('span', 'av-cards-n', String(n)))
    h.appendChild(el('span', 'av-cards-line'))
    return h
  }

  function render(rootEl, vm, actions) {
    rootEl.textContent = ''
    var lay = layout(vm)
    var wrap = el('div', 'av-cards')
    var io = null
    var ioFired = false
    if (actions.wantThumb && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(function (entries) {
        ioFired = true
        entries.forEach(function (e) {
          if (!e.isIntersecting) return
          io.unobserve(e.target)
          actions.wantThumb(e.target.dataset.key)
        })
      }, { root: null, rootMargin: '120px' })
    }
    if (!lay.pinned.length && !lay.cards.length) {
      rootEl.appendChild(wrap)
      return
    }
    if (lay.pinned.length) {
      wrap.appendChild(sectionHead('pin', 'Pinned', lay.pinned.length))
      var rail = el('div', 'av-cards-rail')
      lay.pinned.forEach(function (c) {
        rail.appendChild(renderCard(c, actions, io, true))
      })
      wrap.appendChild(rail)
    }
    if (lay.cards.length) {
      wrap.appendChild(sectionHead(null, 'Recent', lay.cards.length))
      var grid = el('div', 'av-cards-grid')
      var shown = Math.max(PAGE, paging.shown)
      lay.cards.slice(0, shown).forEach(function (c) {
        grid.appendChild(renderCard(c, actions, io, false))
      })
      wrap.appendChild(grid)
      var rest = lay.cards.length - shown
      if (rest > 0) {
        var mw = el('div', 'av-cards-morewrap')
        var mb = el('button', 'av-btn', 'Show ' + Math.min(rest, PAGE) + ' more')
        mb.type = 'button'
        mb.addEventListener('click', function () {
          paging.shown = shown + PAGE
          render(rootEl, vm, actions)
          var cards = rootEl.querySelectorAll('.av-cards-grid .av-cards-card')
          if (cards[shown]) cards[shown].focus()
        })
        mw.appendChild(mb)
        wrap.appendChild(mw)
      }
    }
    rootEl.appendChild(wrap)
    if (io) {
      // Safety net: some hosts never deliver IntersectionObserver callbacks; then request every card.
      setTimeout(function () {
        if (!M().ioFallbackDue(ioFired, wrap.isConnected)) return
        io.disconnect()
        wrap.querySelectorAll('.av-cards-card').forEach(function (c) { actions.wantThumb(c.dataset.key) })
      }, M().IO_FALLBACK_MS)
    }
  }

  AV.views.cards = { id: 'cards', label: 'Cards', render: render, _layout: layout, _coverSeed: coverSeed }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { layout: layout, coverSeed: coverSeed, typeTag: typeTag, view: AV.views.cards }
  }
})()
