/* List view (mock 1): dense rows in collapsible date or session groups. All DOM via createElement/textContent. */
;(function () {
  var AV = (window.AV = window.AV || {})
  AV.views = AV.views || {}
  var M = AV.model
  // group id -> true when collapsed. Survives re-renders.
  var collapsed = new Map()

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function iconBtn(name, title, onClick) {
    var b = el('button', 'av-iconbtn')
    b.type = 'button'
    b.title = title
    b.setAttribute('aria-label', title)
    b.appendChild(AV.icon(name, 'sm'))
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      onClick(b)
    })
    return b
  }

  function sessionTitle(vm, id) {
    var s = vm.sessions && vm.sessions[id]
    return (s && s.title) || (id ? 'Session ' + id.slice(0, 8) : 'Unknown session')
  }

  var ENTRY = { orca: 'in Orca', cli: 'CLI', 'claude-desktop': 'Desktop', 'sdk-cli': 'SDK' }

  /** Second line of the selected row: session · source, then file name / host and branch. */
  function buildSub(item, vm) {
    var sub = el('span', 'av-list-sub')
    var ids = item.sessionIds || []
    var lastId = ids[ids.length - 1]
    var ls = lastId && vm.sessions && vm.sessions[lastId]
    if (lastId) {
      var sess = el('span', 'av-list-sess')
      sess.appendChild(AV.icon('message', 'sm'))
      sess.appendChild(el('span', null, sessionTitle(vm, lastId)))
      if (ids.length > 1) sess.title = ids.map(function (id) { return sessionTitle(vm, id) }).join('\n')
      sub.appendChild(sess)
    }
    var src = ls && ls.entrypoint ? ENTRY[ls.entrypoint] || ls.entrypoint : ''
    sub.appendChild(el('span', null, '· Claude' + (src ? ' ' + src : '')))
    sub.appendChild(el('code', null, item.kind === 'claude' ? M.hostOf(item.url) : M.fileName(item.filePath)))
    if (ls && ls.gitBranch) sub.appendChild(el('code', null, ls.gitBranch))
    return sub
  }

  function buildDetail(item, vm, actions) {
    var d = el('div', 'av-list-detail')
    var tu = vm.thumbUrl && vm.thumbUrl(item.key)
    if (vm.thumbUrl && actions && actions.wantThumb) actions.wantThumb(item.key)
    if (tu) {
      var img = document.createElement('img')
      img.className = 'av-list-thumb'
      img.alt = ''
      img.decoding = 'async'
      img.addEventListener('error', function () { img.remove() })
      img.src = tu
      d.appendChild(img)
    }
    if (item.description) d.appendChild(el('div', 'av-list-desc', item.description))
    var vers = (item.versions || []).slice(-4)
    if (vers.length > 1 || item.publishCount > 1) {
      var ul = el('ul', 'av-list-vers')
      ul.setAttribute('aria-label', 'Versions')
      var total = Math.max(item.publishCount || 0, vers.length)
      for (var i = vers.length - 1; i >= 0; i--) {
        var v = vers[i]
        var li = el('li', i === vers.length - 1 ? 'is-cur' : null)
        li.appendChild(el('span', 'av-v', 'v' + (total - (vers.length - 1 - i))))
        var foreign = (item.sessionIds || []).length > 1 ? ' · ' + sessionTitle(vm, v.sessionId) : ''
        li.appendChild(el('span', 'av-l', (v.action === 'create' ? 'Created' : 'Updated') + foreign))
        var t = el('span', 'av-t', M.relTime(v.at, vm.now))
        t.title = M.fullTime(v.at)
        li.appendChild(t)
        ul.appendChild(li)
      }
      d.appendChild(ul)
    }
    if (!d.firstChild) return null
    return d
  }

  function buildItem(item, vm, actions) {
    var key = item.key
    var selected = vm.selectedKey === key
    var wrap = el('div', 'av-list-item' + (selected ? ' is-sel' : ''))
    wrap.setAttribute('data-key', key)
    wrap.setAttribute('role', 'listitem')

    var row = el('button', 'av-list-row')
    row.type = 'button'
    row.setAttribute('data-key', key)
    row.setAttribute('aria-expanded', selected ? 'true' : 'false')
    row.title = item.title
    var kind = el('span', 'av-list-kind ' + (item.kind === 'visual' ? 'av-kind-visual' : 'av-kind-claude'))
    kind.appendChild(AV.icon(item.kind === 'visual' ? 'visual' : 'artifact'))
    var body = el('span', 'av-list-body')
    body.appendChild(el('span', 'av-list-title', item.title))
    if (selected) body.appendChild(buildSub(item, vm))
    row.appendChild(kind)
    row.appendChild(body)
    // pinned items already sit in the Pinned group when grouping by date
    if (vm.pins && vm.pins.has(key) && vm.groupBy === 'session') {
      var pm = AV.icon('pin', 'sm', 'av-icon-filled av-list-pin')
      row.appendChild(pm)
    }
    var vb = M.versionBadge(item)
    if (vb) {
      var vbe = el('span', 'av-list-ver', vb)
      vbe.title = M.plural(item.publishCount, 'publish', 'publishes')
      row.appendChild(vbe)
    }
    var t = el('span', 'av-list-time', M.relTime(item.updatedAt, vm.now))
    t.title = M.fullTime(item.updatedAt)
    row.appendChild(t)

    row.addEventListener('click', function () {
      actions.select(key)
      actions.open(key)
    })
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      actions.menu(key, row)
    })
    row.addEventListener('keydown', function (e) {
      if (actions.keydown && actions.keydown(e, key, row)) return
      if (e.key === 'Escape' && selected) {
        actions.select(null)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var rows = Array.prototype.slice.call(wrap.closest('.av-list-root').querySelectorAll('.av-list-row'))
        var next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]
        if (next) {
          e.preventDefault()
          next.focus()
        }
      }
    })
    wrap.appendChild(row)

    var acts = el('div', 'av-list-acts')
    if (item.kind === 'claude' && vm.canOpenExternal) acts.appendChild(iconBtn('external', 'Open in external browser', function () { actions.openExternal(key) }))
    acts.appendChild(iconBtn('copy', item.kind === 'claude' ? 'Copy link' : 'Copy file path', function () { actions.copy(key) }))
    var more = iconBtn('more', 'More actions', function (b) { actions.menu(key, b) })
    more.setAttribute('aria-haspopup', 'menu')
    acts.appendChild(more)
    wrap.appendChild(acts)

    if (selected) {
      var det = buildDetail(item, vm, actions)
      if (det) wrap.appendChild(det)
    }
    return wrap
  }

  function buildGroups(vm) {
    if (vm.groupBy === 'session') {
      return M.groupBySession(vm.items, vm.sessions).map(function (g) {
        var s = g.session
        return {
          id: 's:' + g.sessionId,
          session: true,
          label: sessionTitle(vm, g.sessionId),
          sub: (s && s.gitBranch ? s.gitBranch + ' · ' : '') + M.relTime(g.lastAt, vm.now),
          items: g.items
        }
      })
    }
    return M.groupByDate(vm.items, vm.now, vm.pins)
  }

  function render(root, vm, actions) {
    var list = el('div', 'av-list-root')
    list.setAttribute('role', 'list')
    var rerender = function () {
      root.textContent = ''
      render(root, vm, actions)
    }
    buildGroups(vm).forEach(function (g) {
      var sec = el('section', 'av-list-group')
      var isCollapsed = collapsed.get(g.id) === true
      var head = el('button', 'av-list-ghead' + (g.session ? ' is-session' : ''))
      head.type = 'button'
      head.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true')
      head.setAttribute('data-gid', g.id)
      head.appendChild(AV.icon('chevron', 'sm', 'av-icon-chev'))
      if (g.id === 'pinned') head.appendChild(AV.icon('pin', 'sm', 'av-icon-filled av-list-pin'))
      head.appendChild(el('span', 'av-list-gtitle', g.label))
      head.appendChild(el('span', 'av-n', String(g.items.length)))
      if (g.sub) head.appendChild(el('span', 'av-gsub', g.sub))
      head.addEventListener('click', function () {
        collapsed.set(g.id, !isCollapsed)
        rerender()
        var heads = root.querySelectorAll('.av-list-ghead')
        for (var i = 0; i < heads.length; i++) if (heads[i].getAttribute('data-gid') === g.id) heads[i].focus()
      })
      sec.appendChild(head)
      if (!isCollapsed) {
        g.items.forEach(function (item) {
          sec.appendChild(buildItem(item, vm, actions))
        })
      }
      list.appendChild(sec)
    })
    root.appendChild(list)
  }

  AV.views.list = { id: 'list', label: 'List', render: render, _collapsed: collapsed }
})()
