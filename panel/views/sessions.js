/* Sessions view: timeline grouped by chat session, with per-item version strips. */
(function () {
  'use strict'

  var root = typeof window !== 'undefined' ? window : globalThis
  var AV = (root.AV = root.AV || {})
  AV.views = AV.views || {}

  var UNTITLED = 'Untitled session'
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
      selected: selected,
      dots: dots,
      history: null
    }
    if (selected) {
      row.history = (item.versions || [])
        .slice()
        .reverse()
        .map(function (v) {
          return {
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

  /** Pure description: { groups: [{ sessionId, title, entrypoint, branch, worktree, time, fullTime, count, compact, collapsed, rows }] }. */
  function layout(vm) {
    var m = M()
    var sessions = (vm && vm.sessions) || {}
    var worktrees = (vm.context && vm.context.worktrees) || []
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
    var b = el('button', 'av-iconbtn ' + (cls || ''))
    b.type = 'button'
    b.title = label
    b.setAttribute('aria-label', label)
    b.appendChild(AV.icon(name))
    return b
  }

  function strip(dots) {
    var s = el('span', 'av-sessions-strip')
    var shown = dots.length > 8 ? dots.slice(dots.length - 8) : dots
    if (shown.length < dots.length) s.appendChild(el('span', 'av-sessions-more', '+' + (dots.length - shown.length)))
    shown.forEach(function (d) {
      var dot = el('span', 'av-sessions-vdot' + (d.latest ? ' is-latest' : '') + (d.action === 'create' ? ' is-create' : ''))
      dot.title = d.label
      s.appendChild(dot)
    })
    return s
  }

  function renderRow(row, group, actions) {
    var li = el('div', 'av-sessions-row av-sessions-' + row.kind + (row.selected ? ' is-sel' : ''))
    li.tabIndex = 0
    li.dataset.key = row.key
    li.setAttribute('role', 'button')
    li.setAttribute('aria-expanded', row.selected ? 'true' : 'false')

    var main = el('div', 'av-sessions-main')
    var ic = el('span', 'av-sessions-kind av-kind-' + row.kind)
    ic.appendChild(AV.icon(row.kind === 'visual' ? 'visual' : 'artifact'))
    main.appendChild(ic)

    var body = el('div', 'av-sessions-body')
    body.appendChild(el('div', 'av-sessions-title', row.title))
    var sub = el('div', 'av-sessions-sub av-muted')
    if (row.dots.length) sub.appendChild(strip(row.dots))
    if (row.version) sub.appendChild(el('span', 'av-badge av-sessions-ver', row.version))
    var t = el('span', 'av-sessions-time', row.time)
    t.title = row.fullTime
    sub.appendChild(t)
    if (group.compact && group.title !== UNTITLED) {
      sub.appendChild(el('span', 'av-sessions-cap', group.title))
    }
    body.appendChild(sub)
    main.appendChild(body)

    var acts = el('div', 'av-sessions-acts')
    var tog = iconBtn('chevron', row.selected ? 'Hide versions' : 'Show versions', 'av-sessions-tog')
    tog.addEventListener('click', function (e) {
      e.stopPropagation()
      actions.select(row.selected ? null : row.key)
    })
    var more = iconBtn('more', 'More actions')
    more.addEventListener('click', function (e) {
      e.stopPropagation()
      actions.menu(row.key, more)
    })
    acts.appendChild(tog)
    acts.appendChild(more)
    main.appendChild(acts)
    li.appendChild(main)

    if (row.history) {
      var h = el('ol', 'av-sessions-hist')
      row.history.forEach(function (v) {
        var e = el('li', 'av-sessions-he')
        e.appendChild(el('span', 'av-sessions-hact', v.actionLabel))
        var tm = el('span', 'av-sessions-htime av-muted', v.time)
        tm.title = v.fullTime
        e.appendChild(tm)
        if (v.session) e.appendChild(el('span', 'av-sessions-hsess av-muted', v.session))
        h.appendChild(e)
      })
      li.appendChild(h)
    }

    li.addEventListener('click', function () {
      actions.select(row.key)
      actions.open(row.key)
    })
    li.addEventListener('keydown', function (e) {
      if (e.target !== li) return
      if (e.key === 'Enter') {
        e.preventDefault()
        actions.open(row.key)
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault()
        actions.menu(row.key, li)
      }
    })
    li.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      actions.menu(row.key, li)
    })
    return li
  }

  function renderGroup(g, rerender, actions) {
    var sec = el('section', 'av-sessions-group' + (g.compact ? ' is-compact' : '') + (g.collapsed ? ' is-collapsed' : ''))
    if (!g.compact) {
      var head = el('button', 'av-sessions-head')
      head.type = 'button'
      head.setAttribute('aria-expanded', g.collapsed ? 'false' : 'true')
      var chev = el('span', 'av-sessions-chev')
      chev.appendChild(AV.icon('chevron'))
      head.appendChild(chev)
      var info = el('span', 'av-sessions-info')
      var line1 = el('span', 'av-sessions-l1')
      line1.appendChild(el('span', 'av-sessions-stitle', g.title))
      if (g.entrypoint) line1.appendChild(el('span', 'av-badge av-sessions-ep', g.entrypoint))
      info.appendChild(line1)
      var line2 = el('span', 'av-sessions-l2 av-muted')
      var bits = []
      if (g.branch) bits.push(g.branch)
      if (g.worktree && g.worktree !== g.branch) bits.push(g.worktree)
      bits.push(g.count + ' items')
      line2.textContent = bits.join(' • ')
      info.appendChild(line2)
      head.appendChild(info)
      var tm = el('span', 'av-sessions-htm av-muted', g.time)
      tm.title = g.fullTime
      head.appendChild(tm)
      head.addEventListener('click', function () {
        collapsed.set(g.sessionId, !g.collapsed)
        rerender()
      })
      sec.appendChild(head)
    }
    if (!g.collapsed) {
      var items = el('div', 'av-sessions-items')
      g.rows.forEach(function (r) {
        items.appendChild(renderRow(r, g, actions))
      })
      sec.appendChild(items)
    }
    return sec
  }

  function render(rootEl, vm, actions) {
    var rerender = function () {
      render(rootEl, vm, actions)
    }
    rootEl.textContent = ''
    var lay = layout(vm)
    var wrap = el('div', 'av-sessions')
    if (!lay.groups.length) {
      wrap.appendChild(el('div', 'av-empty', 'Nothing here yet.'))
    } else {
      lay.groups.forEach(function (g) {
        wrap.appendChild(renderGroup(g, rerender, actions))
      })
    }
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
