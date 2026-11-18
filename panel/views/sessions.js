/* Sessions view (mock 3): timeline grouped by chat session, every session with a header, version trail on the selected item. */
(function () {
  'use strict'

  var root = typeof window !== 'undefined' ? window : globalThis
  var AV = (root.AV = root.AV || {})
  AV.views = AV.views || {}

  var UNTITLED = 'Untitled session'
  var TRAIL_MAX = 4
  var BUCKET_LABEL = { today: 'Today', week: 'This week', older: 'Earlier' }
  var ENTRY = { orca: 'Orca', cli: 'CLI', 'claude-desktop': 'Desktop', 'sdk-cli': 'SDK' }
  // sessionId -> true when collapsed. Survives re-renders.
  var collapsed = new Map()

  function M() {
    return AV.model
  }

  function sessionTitle(sessions, id) {
    var s = sessions && sessions[id]
    return (s && s.title) || UNTITLED
  }

  function actionLabel(a) {
    return a === 'create' ? 'Created' : 'Updated'
  }

  function baseName(p) {
    var parts = String(p || '').split(/[\\/]+/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : ''
  }

  function describeRow(item, group, vm, sessions) {
    var m = M()
    var inSession = (item.versions || []).filter(function (v) {
      return v.sessionId === group.sessionId
    })
    var dots = inSession.map(function (v, i) {
      return {
        at: v.at,
        action: v.action,
        latest: i === inSession.length - 1,
        label: actionLabel(v.action) + ' · ' + m.fullTime(v.at)
      }
    })
    var selected = vm.selectedKey === item.key
    var row = {
      key: item.key,
      kind: item.kind,
      title: item.title || 'Untitled',
      version: m.versionBadge(item),
      time: m.relTime(item.updatedAt, vm.now),
      fullTime: m.fullTime(item.updatedAt),
      file: item.kind === 'visual' ? baseName(item.filePath) : '',
      pinned: !!(vm.pins && vm.pins.has(item.key)),
      versionCount: Math.max(item.publishCount || 0, (item.versions || []).length),
      selected: selected,
      dots: dots,
      history: null
    }
    if (selected) {
      var total = row.versionCount
      row.history = (item.versions || [])
        .slice()
        .reverse()
        .map(function (v, i) {
          return {
            n: total - i,
            action: v.action,
            actionLabel: actionLabel(v.action),
            time: m.relTime(v.at, vm.now),
            fullTime: m.fullTime(v.at),
            sessionId: v.sessionId,
            session: v.sessionId !== group.sessionId ? sessionTitle(sessions, v.sessionId) : ''
          }
        })
    }
    return row
  }

  /**
   * Pure description: { groups: [{ sessionId, title, entrypoint, branch, worktree, current, bucket,
   * time, fullTime, count, compact, collapsed, rows }] }. Every group renders a header; `compact`
   * (one item) gets a one-line header and cannot collapse.
   */
  function layout(vm) {
    var m = M()
    var sessions = (vm && vm.sessions) || {}
    var ctx = (vm && vm.context) || {}
    var worktrees = ctx.worktrees || []
    var raw = m.groupBySession((vm && vm.items) || [], sessions) || []
    var groups = raw.map(function (g) {
      var s = g.session || sessions[g.sessionId] || null
      var wt = ''
      if (s && s.cwd) {
        try {
          wt = m.worktreeLabel(s.cwd, worktrees) || ''
        } catch (e) {}
      }
      var group = {
        sessionId: g.sessionId,
        title: (s && s.title) || UNTITLED,
        entrypoint: (s && s.entrypoint) || '',
        branch: (s && s.gitBranch) || '',
        worktree: wt,
        current: !!(wt && ctx.worktreeName && wt === ctx.worktreeName),
        bucket: m.dateBucket ? m.dateBucket(g.lastAt, vm.now) : 'older',
        time: m.relTime(g.lastAt, vm.now),
        fullTime: m.fullTime(g.lastAt),
        count: g.items.length,
        compact: g.items.length === 1
      }
      group.collapsed = !group.compact && collapsed.get(g.sessionId) === true
      group.rows = g.items.map(function (it) {
        return describeRow(it, group, vm, sessions)
      })
      return group
    })
    return { groups: groups }
  }

  // ---- DOM ----------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function iconBtn(name, label, cls) {
    var b = el('button', 'av-iconbtn av-iconbtn-sm ' + (cls || ''))
    b.type = 'button'
    b.title = label
    b.setAttribute('aria-label', label)
    b.appendChild(AV.icon(name, 'sm'))
    return b
  }

  function plural(n, one) {
    return n + ' ' + (n === 1 ? one : one + 's')
  }

  function branchChip(g) {
    var label = g.branch || g.worktree
    if (!label) return null
    var b = el('span', 'av-sessions-br' + (g.current ? ' is-cur' : ''))
    b.appendChild(AV.icon('branch', 'xs'))
    b.appendChild(el('span', null, label))
    b.title = (g.branch ? 'Branch ' + g.branch : '') + (g.worktree && g.worktree !== g.branch ? (g.branch ? ' · ' : '') + 'worktree ' + g.worktree : '') + (g.current ? ' (this worktree)' : '')
    return b
  }

  function avatar() {
    var a = el('span', 'av-sessions-av')
    a.title = 'Claude'
    a.appendChild(AV.icon('claude', 'sm'))
    return a
  }

  function renderTrail(row, actions) {
    var t = el('div', 'av-sessions-trail')
    t.setAttribute('role', 'list')
    t.setAttribute('aria-label', 'Versions of ' + row.title)
    row.history.slice(0, TRAIL_MAX).forEach(function (v, i) {
      var vr = el('div', 'av-sessions-vr' + (i === 0 ? ' is-cur' : ''))
      vr.setAttribute('role', 'listitem')
      vr.appendChild(el('code', null, 'v' + v.n))
      vr.appendChild(el('span', null, v.actionLabel + (v.session ? ' in “' + v.session + '”' : '')))
      var tm = el('time', null, v.time)
      tm.title = v.fullTime
      vr.appendChild(tm)
      t.appendChild(vr)
    })
    var rest = row.history.length - TRAIL_MAX
    if (rest > 0) t.appendChild(el('div', 'av-sessions-vr is-more', '+ ' + plural(rest, 'earlier version')))
    return t
  }

  function renderRow(row, group, actions) {
    var wrap = el('div', 'av-sessions-it')
    var li = el('div', 'av-sessions-row av-sessions-' + row.kind + (row.selected ? ' is-sel' : ''))
    li.tabIndex = 0
    li.dataset.key = row.key
    li.setAttribute('role', 'button')
    li.setAttribute('aria-expanded', row.selected ? 'true' : 'false')
    li.title = row.title

    var ic = el('span', 'av-sessions-kind')
    ic.appendChild(AV.icon(row.kind === 'visual' ? 'visual' : 'artifact'))
    li.appendChild(ic)

    var body = el('div', 'av-sessions-body')
    body.appendChild(el('div', 'av-sessions-title', row.title))
    var sub = el('div', 'av-sessions-sub')
    var t = el('span', null, row.time)
    t.title = row.fullTime
    if (row.kind === 'visual') {
      sub.appendChild(el('span', null, 'Inline visual'))
      if (row.file) sub.appendChild(el('code', null, row.file))
      sub.appendChild(t)
    } else {
      if (row.version) sub.appendChild(el('span', 'av-sessions-vb', row.version))
      var n = row.dots.length
      var what = n > 1 ? plural(n, 'update') + ' · ' : n === 1 && row.dots[0].action === 'create' ? 'Created · ' : n === 1 ? 'Updated · ' : ''
      var u = el('span', null, what)
      if (n) u.title = row.dots.map(function (d) { return d.label }).join('\n')
      u.appendChild(t)
      sub.appendChild(u)
    }
    body.appendChild(sub)
    li.appendChild(body)

    if (row.pinned) {
      var pm = el('span', 'av-sessions-pinmark')
      pm.title = 'Pinned'
      pm.appendChild(AV.icon('pin', 'sm', 'av-icon-filled'))
      li.appendChild(pm)
    }

    var acts = el('div', 'av-sessions-acts')
    if (row.versionCount > 1) {
      var tog = iconBtn('history', row.selected ? 'Hide versions' : 'Show versions', 'av-sessions-tog')
      tog.setAttribute('aria-pressed', row.selected ? 'true' : 'false')
      tog.addEventListener('click', function (e) {
        e.stopPropagation()
        actions.select(row.selected ? null : row.key)
      })
      acts.appendChild(tog)
    }
    var copy = iconBtn('copy', row.kind === 'visual' ? 'Copy file path' : 'Copy link')
    copy.addEventListener('click', function (e) {
      e.stopPropagation()
      actions.copy(row.key)
    })
    acts.appendChild(copy)
    var more = iconBtn('more', 'More actions')
    more.setAttribute('aria-haspopup', 'menu')
    more.addEventListener('click', function (e) {
      e.stopPropagation()
      actions.menu(row.key, more)
    })
    acts.appendChild(more)
    li.appendChild(acts)

    li.addEventListener('click', function () {
      actions.select(row.key)
      actions.open(row.key)
    })
    li.addEventListener('keydown', function (e) {
      if (e.target !== li) return
      if (actions.keydown && actions.keydown(e, row.key, more)) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        actions.select(row.key)
        actions.open(row.key)
      } else if (e.key === 'Escape' && row.selected) {
        actions.select(null)
      }
    })
    li.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      actions.menu(row.key, more)
    })
    wrap.appendChild(li)
    if (row.history && row.history.length > 1) wrap.appendChild(renderTrail(row, actions))
    return wrap
  }

  function renderHead(g, rerender) {
    var head
    if (g.compact) {
      head = el('div', 'av-sessions-head is-compact')
      head.appendChild(el('span', 'av-sessions-chev'))
    } else {
      head = el('button', 'av-sessions-head')
      head.type = 'button'
      head.setAttribute('aria-expanded', g.collapsed ? 'false' : 'true')
      head.setAttribute('data-sid', g.sessionId)
      var chev = el('span', 'av-sessions-chev')
      chev.appendChild(AV.icon('chevron', 'sm'))
      head.appendChild(chev)
      head.addEventListener('click', function () {
        collapsed.set(g.sessionId, !g.collapsed)
        rerender(g.sessionId)
      })
    }
    head.appendChild(avatar())
    var info = el('span', 'av-sessions-info')
    var l1 = el('span', 'av-sessions-l1')
    var tt = el('span', 'av-sessions-stitle', g.title)
    tt.title = g.title
    l1.appendChild(tt)
    if (g.collapsed) l1.appendChild(el('span', 'av-sessions-cnt', String(g.count)))
    info.appendChild(l1)
    var l2 = el('span', 'av-sessions-l2')
    var br = branchChip(g)
    if (br) l2.appendChild(br)
    var bits = []
    if (!g.compact && !g.collapsed) bits.push(plural(g.count, 'item'))
    var ep = g.entrypoint ? ENTRY[g.entrypoint] || g.entrypoint : ''
    // compact one-liners keep the title readable: the source moves to the tooltip
    if (ep && !g.compact) bits.push(ep)
    if (ep && g.compact) tt.title = g.title + ' · Claude ' + ep
    if (bits.length) l2.appendChild(el('span', 'av-sessions-l2t', bits.join(' · ')))
    if (l2.firstChild) info.appendChild(l2)
    head.appendChild(info)
    var tm = el('span', 'av-sessions-htm', g.time)
    tm.title = g.fullTime
    head.appendChild(tm)
    return head
  }

  function renderGroup(g, rerender, actions) {
    var sec = el('section', 'av-sessions-group' + (g.compact ? ' is-compact' : '') + (g.collapsed ? ' is-collapsed' : ''))
    sec.setAttribute('aria-label', g.title)
    sec.appendChild(renderHead(g, rerender))
    if (!g.collapsed) {
      var items = el('div', 'av-sessions-items')
      g.rows.forEach(function (r) {
        items.appendChild(renderRow(r, g, actions))
      })
      sec.appendChild(items)
    }
    return sec
  }

  function renderPins(vm, actions) {
    var order = vm.pinOrder || []
    var byKey = {}
    ;(vm.items || []).forEach(function (it) { byKey[it.key] = it })
    var pinned = order.map(function (k) { return byKey[k] }).filter(Boolean)
    if (!pinned.length) return null
    var strip = el('div', 'av-sessions-pins')
    strip.setAttribute('role', 'group')
    strip.setAttribute('aria-label', 'Pinned')
    strip.appendChild(AV.icon('pin', 'sm', 'av-icon-filled av-sessions-pinic'))
    pinned.forEach(function (it) {
      var p = el('button', 'av-sessions-pill')
      p.type = 'button'
      p.dataset.key = it.key
      p.title = it.title
      p.appendChild(el('span', 'av-sessions-pk av-sessions-pk-' + it.kind))
      p.appendChild(el('span', null, it.title))
      p.addEventListener('click', function () {
        actions.select(it.key)
        actions.open(it.key)
      })
      p.addEventListener('keydown', function (e) {
        if (actions.keydown) actions.keydown(e, it.key, p)
      })
      p.addEventListener('contextmenu', function (e) {
        e.preventDefault()
        actions.menu(it.key, p)
      })
      strip.appendChild(p)
    })
    return strip
  }

  function render(rootEl, vm, actions) {
    var rerender = function (focusSid) {
      render(rootEl, vm, actions)
      if (!focusSid) return
      var heads = rootEl.querySelectorAll('.av-sessions-head[data-sid]')
      for (var i = 0; i < heads.length; i++) if (heads[i].getAttribute('data-sid') === focusSid) heads[i].focus()
    }
    rootEl.textContent = ''
    var lay = layout(vm)
    var wrap = el('div', 'av-sessions')
    var pins = renderPins(vm, actions)
    if (pins) wrap.appendChild(pins)
    var list = el('div', 'av-sessions-list')
    var lastBucket = null
    lay.groups.forEach(function (g) {
      if (g.bucket !== lastBucket) {
        lastBucket = g.bucket
        list.appendChild(el('div', 'av-sessions-divider', BUCKET_LABEL[g.bucket] || 'Earlier'))
      }
      list.appendChild(renderGroup(g, rerender, actions))
    })
    wrap.appendChild(list)
    rootEl.appendChild(wrap)
  }

  AV.views.sessions = {
    id: 'sessions',
    label: 'Sessions',
    render: render,
    _layout: layout,
    _collapsed: collapsed
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { layout: layout, collapsed: collapsed, view: AV.views.sessions }
  }
})()
