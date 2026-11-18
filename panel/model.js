/* Pure helpers and icons shared by the panel views. Classic script; also loadable from Node tests. */
;(function () {
  var root = typeof window !== 'undefined' ? window : globalThis
  var AV = (root.AV = root.AV || {})
  var MIN = 60000
  var HOUR = 3600000
  var DAY = 86400000
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  function toSet(pins) {
    if (!pins) return new Set()
    return pins instanceof Set ? pins : new Set(pins)
  }

  function fileName(p) {
    if (!p) return ''
    var parts = String(p).split(/[\\/]+/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : ''
  }

  function hostOf(url) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(url || ''))
    if (!m) return ''
    return m[1].replace(/^.*@/, '').replace(/:\d+$/, '')
  }

  function kindLabel(kind) {
    return kind === 'visual' ? 'Visual' : 'Artifact'
  }

  function filterItems(items, opts, pins) {
    opts = opts || {}
    var q = String(opts.q || '').trim().toLowerCase()
    var kind = opts.kind || 'all'
    var pinSet = toSet(pins)
    return (items || []).filter(function (it) {
      if (kind !== 'all' && it.kind !== kind) return false
      if (opts.pinsOnly && !pinSet.has(it.key)) return false
      if (!q) return true
      var hay = [it.title, it.description, it.url, fileName(it.filePath)]
      for (var i = 0; i < hay.length; i++) {
        if (hay[i] && String(hay[i]).toLowerCase().indexOf(q) >= 0) return true
      }
      return false
    })
  }

  /** Only claude.ai artifact links may ever reach shell.openExternal. */
  function isClaudeArtifactUrl(url) {
    return typeof url === 'string' && /^https:\/\/claude\.ai\/(?:code\/)?artifact\//.test(url)
  }

  /** Pure decision for the main area. Returns { state, message? }. */
  function panelState(o) {
    o = o || {}
    var data = o.data
    if (!data) {
      if (o.loading) return { state: 'skeleton' }
      return { state: 'error', message: o.requestError || 'No data yet.' }
    }
    if (!data.context || !data.context.worktreePath) {
      return { state: 'no-workspace', message: data.error || 'Focus a workspace to see the artifacts Claude made for it.' }
    }
    var all = data.items || []
    if (all.length === 0) return { state: data.indexing ? 'skeleton' : 'empty-index' }
    var shown = filterItems(all, { q: o.query, kind: o.kind, pinsOnly: o.pinsOnly }, data.pins)
    if (shown.length === 0) return { state: 'no-results' }
    return { state: 'items' }
  }

  function byUpdatedDesc(a, b) {
    return b.updatedAt - a.updatedAt
  }

  /** Pinned items go to the first group (and are not repeated); `pins` is a Set or array of keys. */
  function groupByDate(items, now, pins) {
    now = now == null ? Date.now() : now
    var pinSet = toSet(pins)
    var d = new Date(now)
    var startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    var startWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime()
    var groups = [
      { id: 'pinned', label: 'Pinned', items: [] },
      { id: 'today', label: 'Today', items: [] },
      { id: 'week', label: 'This week', items: [] },
      { id: 'older', label: 'Older', items: [] }
    ]
    ;(items || []).slice().sort(byUpdatedDesc).forEach(function (it) {
      var g = pinSet.has(it.key) ? 0 : it.updatedAt >= startToday ? 1 : it.updatedAt >= startWeek ? 2 : 3
      groups[g].items.push(it)
    })
    return groups.filter(function (g) { return g.items.length > 0 })
  }

  function groupBySession(items, sessions) {
    sessions = sessions || {}
    var map = {}
    var order = []
    ;(items || []).forEach(function (it) {
      var ids = it.sessionIds && it.sessionIds.length ? it.sessionIds : ['']
      ids.forEach(function (id) {
        if (!map[id]) {
          map[id] = { sessionId: id, session: sessions[id], items: [], lastAt: 0 }
          order.push(id)
        }
        map[id].items.push(it)
      })
    })
    var out = order.map(function (id) {
      var g = map[id]
      g.items.sort(byUpdatedDesc)
      var last = g.session && g.session.lastAt ? g.session.lastAt : 0
      g.items.forEach(function (it) { if (it.updatedAt > last) last = it.updatedAt })
      g.lastAt = last
      return g
    })
    out.sort(function (a, b) { return b.lastAt - a.lastAt })
    return out
  }

  function relTime(ms, now) {
    now = now == null ? Date.now() : now
    var diff = now - ms
    if (diff < MIN) return 'now'
    if (diff < HOUR) return Math.floor(diff / MIN) + 'm'
    if (diff < DAY) return Math.floor(diff / HOUR) + 'h'
    if (diff < 7 * DAY) return Math.floor(diff / DAY) + 'd'
    var d = new Date(ms)
    var s = MONTHS[d.getMonth()] + ' ' + d.getDate()
    return d.getFullYear() === new Date(now).getFullYear() ? s : s + ', ' + d.getFullYear()
  }

  function fullTime(ms) {
    var d = new Date(ms)
    var pad = function (n) { return n < 10 ? '0' + n : '' + n }
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  function worktreeLabel(cwd, worktrees) {
    var c = normPath(cwd)
    var best = null
    var bestLen = -1
    ;(worktrees || []).forEach(function (w) {
      var wp = normPath(w.path)
      if (!wp) return
      if ((c === wp || c.indexOf(wp + '/') === 0) && wp.length > bestLen) {
        best = w
        bestLen = wp.length
      }
    })
    return best ? best.name : fileName(cwd)
  }

  function versionBadge(item) {
    return item && item.publishCount > 1 ? 'v' + item.publishCount : ''
  }

  // lucide-style 24x24 stroke icons
  var ICONS = {
    artifact: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    visual: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    cards: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    sessions: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    browser: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'
  }

  function icon(name, size) {
    var NS = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('class', 'av-icon' + (size ? ' av-icon-' + size : ''))
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    // Static, trusted markup from the table above (never data).
    svg.innerHTML = ICONS[name] || ICONS.artifact
    return svg
  }

  AV.icon = icon
  AV.model = {
    filterItems: filterItems,
    isClaudeArtifactUrl: isClaudeArtifactUrl,
    panelState: panelState,
    groupByDate: groupByDate,
    groupBySession: groupBySession,
    relTime: relTime,
    fullTime: fullTime,
    kindLabel: kindLabel,
    hostOf: hostOf,
    fileName: fileName,
    worktreeLabel: worktreeLabel,
    versionBadge: versionBadge
  }
  if (typeof module !== 'undefined') module.exports = AV.model
})()
