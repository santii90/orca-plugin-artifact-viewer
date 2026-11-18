/* List view: dense rows grouped by date or session. All DOM via createElement/textContent. */
;(function () {
  var AV = (window.AV = window.AV || {})
  AV.views = AV.views || {}
  var M = AV.model

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

  function fact(dl, label, value, mono) {
    if (!value) return
    dl.appendChild(el('dt', null, label))
    dl.appendChild(el('dd', mono ? 'av-mono' : null, value))
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
    var dl = el('dl', 'av-list-facts')
    var titles = (item.sessionIds || []).map(function (id) { return sessionTitle(vm, id) })
    fact(dl, titles.length > 1 ? 'Sessions' : 'Session', titles.join(', '))
    var lastId = (item.sessionIds || [])[(item.sessionIds || []).length - 1]
    var ls = lastId && vm.sessions && vm.sessions[lastId]
    fact(dl, 'Branch', ls && ls.gitBranch, true)
    fact(dl, 'Updated', M.fullTime(item.updatedAt))
    if (item.kind === 'claude') fact(dl, 'Host', M.hostOf(item.url), true)
    else fact(dl, 'File', M.fileName(item.filePath), true)
    d.appendChild(dl)
    var vers = (item.versions || []).slice(-5)
    if (vers.length > 1 || item.publishCount > 1) {
      var ul = el('ul', 'av-list-vers')
      ul.setAttribute('aria-label', 'Versions')
      var total = Math.max(item.publishCount || 0, vers.length)
      for (var i = vers.length - 1; i >= 0; i--) {
        var v = vers[i]
        var li = el('li')
        li.appendChild(el('span', 'av-v', 'v' + (total - (vers.length - 1 - i))))
        li.appendChild(el('span', 'av-t', M.relTime(v.at, vm.now)))
        li.appendChild(el('span', null, v.action === 'create' ? 'created' : 'updated'))
        ul.appendChild(li)
      }
      d.appendChild(ul)
    }
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
    var meta = el('span', 'av-list-meta')
    if (vm.pins && vm.pins.has(key)) {
      meta.appendChild(AV.icon('pin', 'sm'))
    }
    meta.appendChild(el('span', 'av-list-wt', M.worktreeLabel(item.lastCwd, vm.context && vm.context.worktrees)))
    meta.appendChild(el('span', 'av-list-sep', '•'))
    var t = el('span', null, M.relTime(item.updatedAt, vm.now))
    t.title = M.fullTime(item.updatedAt)
    meta.appendChild(t)
    var vb = M.versionBadge(item)
    if (vb) meta.appendChild(el('span', 'av-badge', vb))
    body.appendChild(meta)
    row.appendChild(kind)
    row.appendChild(body)

    row.addEventListener('click', function () {
      actions.select(key)
      actions.open(key)
    })
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      actions.menu(key, row)
    })
    row.addEventListener('keydown', function (e) {
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault()
        actions.menu(key, row)
      } else if (e.key === 'Escape' && selected) {
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
    if (item.kind === 'claude' && vm.canOpenExternal) acts.appendChild(iconBtn('external', 'Open in browser', function () { actions.openExternal(key) }))
    acts.appendChild(iconBtn('copy', item.kind === 'claude' ? 'Copy link' : 'Copy path', function () { actions.copy(key) }))
    var more = iconBtn('more', 'More', function (b) { actions.menu(key, b) })
    more.setAttribute('aria-haspopup', 'menu')
    acts.appendChild(more)
    wrap.appendChild(acts)

    if (selected) wrap.appendChild(buildDetail(item, vm, actions))
    return wrap
  }

  function buildGroups(vm) {
    if (vm.groupBy === 'session') {
      return M.groupBySession(vm.items, vm.sessions).map(function (g) {
        var s = g.session
        return {
          id: 's:' + g.sessionId,
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
    buildGroups(vm).forEach(function (g) {
      var sec = el('section', 'av-list-group')
      var head = el('div', 'av-list-ghead')
      if (g.id === 'pinned') head.appendChild(AV.icon('pin', 'sm'))
      head.appendChild(el('span', 'av-list-gtitle', g.label))
      head.appendChild(el('span', 'av-n', String(g.items.length)))
      if (g.sub) head.appendChild(el('span', 'av-gsub', g.sub))
      sec.appendChild(head)
      g.items.forEach(function (item) {
        sec.appendChild(buildItem(item, vm, actions))
      })
      list.appendChild(sec)
    })
    root.appendChild(list)
  }

  AV.views.list = { id: 'list', label: 'List', render: render }
})()
