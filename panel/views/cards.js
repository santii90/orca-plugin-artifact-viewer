/* Cards view: pinned rail + responsive grid of cards with generated covers and preview thumbnails. */
(function () {
  'use strict'

  var root = typeof window !== 'undefined' ? window : globalThis
  var AV = (root.AV = root.AV || {})
  AV.views = AV.views || {}

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
      pattern: PATTERNS[(h >>> 13) % PATTERNS.length]
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

  function describeCover(item) {
    return {
      type: 'generated',
      seed: coverSeed(item.key),
      icon: item.kind === 'visual' ? 'visual' : 'artifact',
      host: host(item),
      tag: typeTag(item)
    }
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
      pinned: pinned,
      selected: vm.selectedKey === item.key,
      cover: describeCover(item),
      thumbUrl: (vm.thumbUrl && vm.thumbUrl(item.key)) || null,
      thumbReason: (vm.thumbReason && vm.thumbReason(item.key)) || null,
      meta: {
        worktree: wt,
        time: m.relTime(item.updatedAt, vm.now),
        fullTime: m.fullTime(item.updatedAt),
        version: m.versionBadge(item)
      }
    }
  }

  /** Pure description of the view: { pinned: Card[], cards: Card[] }. */
  function layout(vm) {
    var items = (vm && vm.items) || []
    var pins = (vm && vm.pins) || new Set()
    var pinned = []
    var rest = []
    items.forEach(function (it) {
      if (pins.has(it.key)) pinned.push(describeCard(it, vm, true))
      else rest.push(describeCard(it, vm, false))
    })
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
    b.appendChild(AV.icon(name))
    return b
  }

  function generatedCover(c) {
    var s = c.seed
    var d = el('div', 'av-cards-gen')
    d.style.setProperty('--h1', String(s.hue))
    d.style.setProperty('--h2', String(s.hue2))
    d.style.setProperty('--ang', s.angle + 'deg')
    d.appendChild(el('div', 'av-cards-pat av-cards-pat-' + s.pattern))
    var ic = el('span', 'av-cards-genicon')
    ic.appendChild(AV.icon(c.icon))
    d.appendChild(ic)
    d.appendChild(el('span', 'av-cards-host', c.host))
    if (c.tag) d.appendChild(el('span', 'av-cards-tag', c.tag))
    return d
  }

  /** Preview image over the generated cover; the cover stays when it fails to load. */
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

  function renderCard(card, actions, io) {
    var art = el('article', 'av-cards-card' + (card.selected ? ' is-sel' : ''))
    art.tabIndex = 0
    art.dataset.key = card.key
    art.setAttribute('aria-label', card.title)
    if (io) io.observe(art)
    else if (actions.wantThumb) actions.wantThumb(card.key)

    var thumb = el('div', 'av-cards-thumb')
    thumb.appendChild(generatedCover(card.cover))
    if (card.thumbUrl) thumb.appendChild(thumbImg(card.thumbUrl))
    else if (card.thumbReason) thumb.title = 'No preview: ' + card.thumbReason

    var badge = el('span', 'av-badge av-cards-kind av-kind-' + card.kind)
    badge.appendChild(AV.icon(card.kind === 'visual' ? 'visual' : 'artifact'))
    badge.appendChild(document.createTextNode(card.kind === 'visual' ? 'Visual' : 'Artifact'))
    thumb.appendChild(badge)
    if (card.pinned) {
      var pb = el('span', 'av-cards-pinmark')
      pb.title = 'Pinned'
      pb.appendChild(AV.icon('pin'))
      thumb.appendChild(pb)
    }

    var ovl = el('div', 'av-cards-ovl')
    var open = el('button', 'av-cards-open')
    open.type = 'button'
    open.appendChild(AV.icon('external'))
    open.appendChild(document.createTextNode('Open'))
    open.addEventListener('click', function (e) {
      e.stopPropagation()
      actions.open(card.key)
    })
    ovl.appendChild(open)
    thumb.appendChild(ovl)
    art.appendChild(thumb)

    var meta = el('div', 'av-cards-meta')
    var mt = el('div', 'av-cards-mt')
    mt.appendChild(el('div', 'av-cards-title', card.title))
    var cm = el('div', 'av-cards-cm av-muted')
    var parts = []
    if (card.meta.worktree) parts.push(card.meta.worktree)
    parts.push(card.meta.time)
    parts.forEach(function (p, i) {
      if (i) cm.appendChild(el('span', 'av-cards-dot', '•'))
      var last = i === parts.length - 1
      var s = el('span', last ? 'av-cards-time' : 'av-cards-wt', p)
      if (last) s.title = card.meta.fullTime
      cm.appendChild(s)
    })
    if (card.meta.version) cm.appendChild(el('span', 'av-badge av-cards-ver', card.meta.version))
    mt.appendChild(cm)
    meta.appendChild(mt)
    var more = iconBtn('more', 'More actions', 'av-cards-more')
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
      if (e.key === 'Enter') {
        e.preventDefault()
        actions.open(card.key)
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault()
        actions.menu(card.key, more)
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
    if (icon) h.appendChild(AV.icon(icon))
    h.appendChild(el('span', null, label))
    h.appendChild(el('span', 'av-cards-n', String(n)))
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
      wrap.appendChild(el('div', 'av-empty', 'Nothing here yet.'))
      rootEl.appendChild(wrap)
      return
    }
    if (lay.pinned.length) {
      wrap.appendChild(sectionHead('pin', 'Pinned', lay.pinned.length))
      var rail = el('div', 'av-cards-rail')
      lay.pinned.forEach(function (c) {
        rail.appendChild(renderCard(c, actions, io))
      })
      wrap.appendChild(rail)
    }
    if (lay.cards.length) {
      if (lay.pinned.length) wrap.appendChild(sectionHead(null, 'All', lay.cards.length))
      var grid = el('div', 'av-cards-grid')
      lay.cards.forEach(function (c) {
        grid.appendChild(renderCard(c, actions, io))
      })
      wrap.appendChild(grid)
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
