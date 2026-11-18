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

  /** 'today' | 'week' (the 6 local days before today) | 'older' for a timestamp. */
  function dateBucket(ms, now) {
    now = now == null ? Date.now() : now
    var d = new Date(now)
    var startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    var startWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime()
    return ms >= startToday ? 'today' : ms >= startWeek ? 'week' : 'older'
  }
  var BUCKET_INDEX = { today: 1, week: 2, older: 3 }

  /** Pinned items go to the first group (and are not repeated); `pins` is a Set or array of keys. */
  function groupByDate(items, now, pins) {
    now = now == null ? Date.now() : now
    var pinSet = toSet(pins)
    var groups = [
      { id: 'pinned', label: 'Pinned', items: [] },
      { id: 'today', label: 'Today', items: [] },
      { id: 'week', label: 'This week', items: [] },
      { id: 'older', label: 'Older', items: [] }
    ]
    ;(items || []).slice().sort(byUpdatedDesc).forEach(function (it) {
      var g = pinSet.has(it.key) ? 0 : BUCKET_INDEX[dateBucket(it.updatedAt, now)]
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

  function isInside(p, root) {
    var c = normPath(p)
    var r = normPath(root)
    return !!r && (c === r || c.indexOf(r + '/') === 0)
  }

  /**
   * How many items have a publish cwd (latest cwd or any of their sessions' cwd) inside `worktreePath`.
   * Mirrors the worker's 'worktree' scope closely enough to label the scope toggle from a 'repo' answer.
   */
  function countInWorktree(items, sessions, worktreePath) {
    if (!worktreePath) return 0
    sessions = sessions || {}
    return (items || []).filter(function (it) {
      if (isInside(it.lastCwd, worktreePath)) return true
      return (it.sessionIds || []).some(function (id) {
        var s = sessions[id]
        return !!(s && isInside(s.cwd, worktreePath))
      })
    }).length
  }

  /** Footer status text: { text, tone: 'ok'|'busy'|'err' }. */
  function syncStatus(o) {
    o = o || {}
    if (o.error) return { text: 'Not synced', tone: 'err' }
    if (o.indexing) return { text: 'Indexing…', tone: 'busy' }
    if (!o.lastIndexedAt) return { text: 'Not indexed yet', tone: 'busy' }
    var t = relTime(o.lastIndexedAt, o.now)
    return { text: t === 'now' ? 'Synced just now' : /^\d/.test(t) ? 'Synced ' + t + ' ago' : 'Synced ' + t, tone: 'ok' }
  }

  /** "1 item" / "3 items". */
  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many || one + 's')
  }

  /**
   * Source rect for drawImage so the (crop of the) image fills outW x outH, cover-fit and top-anchored
   * (centered horizontally). `crop` is {x,y,w,h} in image px or null for the whole image.
   */
  function coverCropRect(imgW, imgH, crop, outW, outH) {
    var rx = 0
    var ry = 0
    var rw = imgW
    var rh = imgH
    if (crop && crop.w > 0 && crop.h > 0) {
      rx = Math.max(0, Math.min(imgW - 1, crop.x || 0))
      ry = Math.max(0, Math.min(imgH - 1, crop.y || 0))
      rw = Math.max(1, Math.min(imgW - rx, crop.w))
      rh = Math.max(1, Math.min(imgH - ry, crop.h))
    }
    var target = outW / outH
    var sw = rw
    var sh = rh
    var sx = rx
    if (rw / rh > target) {
      sw = rh * target
      sx = rx + (rw - sw) / 2
    } else {
      sh = rw / target
    }
    return { sx: sx, sy: ry, sw: sw, sh: sh }
  }

  /**
   * Should a preview be requested? `entry` is the panel's cache record
   * { want, rev, url, state: 'pending'|'ready'|'capturing'|'none' } or undefined.
   * `want` is the item.thumb seen when it was requested. Each (key, thumb rev) is asked once.
   */
  var CAPTURE_RECHECK_MS = 60000
  var ERROR_RETRY_MS = 30000
  var MAX_ATTEMPTS = 3

  /**
   * ctx = { now, listRev }. Entry: { want, state, at, listRev, attempts }.
   * - never while a request is in flight ('pending');
   * - item.thumb changed or vanished since the last ask -> again (stale rev replaced, visual lost its thumb);
   * - 'capturing' -> again after a newer list (artifacts.changed) or > 60 s;
   * - 'error' -> again after 30 s, at most 3 attempts per rev; 'none'/'ready' -> never until the rev changes.
   */
  function thumbNeeded(item, entry, ctx) {
    if (!item) return false
    ctx = ctx || {}
    var thumb = item.thumb || null
    if (!thumb && item.kind !== 'visual') return false
    if (!entry) return true
    if (entry.state === 'pending') return false
    if ((entry.want || null) !== thumb) return true
    var now = ctx.now == null ? Date.now() : ctx.now
    if (entry.state === 'capturing') {
      return (ctx.listRev != null && entry.listRev != null && ctx.listRev > entry.listRev) || now - entry.at > CAPTURE_RECHECK_MS
    }
    if (entry.state === 'error') return (entry.attempts || 0) < MAX_ATTEMPTS && now - entry.at >= ERROR_RETRY_MS
    return false
  }

  /** IntersectionObserver safety net: when no callback ever fired, request every card. */
  var IO_FALLBACK_MS = 1500
  function ioFallbackDue(ioFired, connected) {
    return !ioFired && !!connected
  }

  /**
   * Thumbnail request queue. opts: { request(method, params) -> Promise, downscale(res) -> Promise<dataUrl>,
   * now(), onChange(key), max, log }. Entries: key -> { want, rev, url, state, reason, at, listRev, attempts }.
   */
  function createThumbQueue(opts) {
    var request = opts.request
    var downscale = opts.downscale
    var now = opts.now || Date.now
    var onChange = opts.onChange || function () {}
    var max = opts.max || 3
    var log = opts.log || (typeof console !== 'undefined' ? console : { info: function () {}, warn: function () {} })
    var entries = new Map()
    var queue = []
    var inFlight = 0
    var listRev = 0
    var seenReasons = new Set()

    function fetchThumb(key) {
      return Promise.resolve(request('artifacts.thumb', { key: key })).then(function (res) {
        if (!res || typeof res !== 'object') return { state: 'none' }
        if (res.kind === 'ready' && res.dataUrl) return { state: 'ready', rev: res.rev, url: res.dataUrl }
        if (res.kind === 'raw' && res.dataUrl) {
          return Promise.resolve(downscale(res)).then(function (out) {
            // Show the downscaled image this session even when the worker refuses or fails to store it.
            return Promise.resolve(request('artifacts.thumbStore', { key: key, rev: res.rev, dataUrl: out })).then(function (r) {
              if (r && r.ok === false) log.warn('[artifacts] thumbStore refused', key, r.reason)
            }, function (err) {
              log.warn('[artifacts] thumbStore failed', key, err)
            }).then(function () {
              return { state: 'ready', rev: res.rev, url: out }
            })
          })
        }
        if (res.kind === 'capturing') return { state: 'capturing' }
        return { state: 'none', reason: res.reason ? String(res.reason) : undefined }
      })
    }

    function settle(key, entry, r) {
      if (entries.get(key) !== entry) return // a newer request owns this key now
      var prevUrl = entry.url
      var prevReason = entry.reason
      entry.state = r.state
      entry.at = now()
      entry.reason = r.state === 'none' ? r.reason : undefined
      if (r.url) {
        entry.url = r.url
        entry.rev = r.rev
      }
      if (r.state === 'none' && r.reason && !seenReasons.has(r.reason)) {
        seenReasons.add(r.reason)
        log.info('[artifacts] no preview', key, r.reason)
      }
      if (entry.url !== prevUrl || entry.reason !== prevReason) onChange(key)
    }

    function run(key, entry) {
      inFlight++
      var p
      try {
        p = fetchThumb(key)
      } catch (e) {
        p = Promise.reject(e)
      }
      p.then(null, function (err) {
        log.warn('[artifacts] thumb', key, err)
        return { state: 'error' }
      }).then(function (r) {
        settle(key, entry, r)
      }).then(null, function (err) {
        log.warn('[artifacts] thumb', key, err)
      }).then(function () {
        inFlight--
        pump()
      })
    }

    function pump() {
      while (inFlight < max && queue.length) {
        var key = queue.shift()
        var entry = entries.get(key)
        if (!entry || entry.state !== 'pending') continue
        run(key, entry)
      }
    }

    return {
      /** Call when a fresh list arrived (new list rev): lets 'capturing' entries re-ask. */
      bumpList: function () { listRev++ },
      want: function (item) {
        if (!item) return false
        var prev = entries.get(item.key)
        if (!thumbNeeded(item, prev, { now: now(), listRev: listRev })) return false
        var want = item.thumb || null
        var sameRev = prev && (prev.want || null) === want
        entries.set(item.key, {
          want: want,
          rev: prev ? prev.rev : null,
          url: prev ? prev.url : null,
          reason: undefined,
          state: 'pending',
          at: now(),
          listRev: listRev,
          attempts: (sameRev ? prev.attempts || 0 : 0) + 1
        })
        queue.push(item.key)
        pump()
        return true
      },
      url: function (key) { var e = entries.get(key); return (e && e.url) || null },
      reason: function (key) { var e = entries.get(key); return (e && e.reason) || null },
      get: function (key) { return entries.get(key) },
      inFlight: function () { return inFlight },
      clear: function () { entries.clear(); queue.length = 0 }
    }
  }

  /** Approximate decoded size of a base64 data URL. */
  function dataUrlBytes(url) {
    var i = String(url || '').indexOf(',')
    return i < 0 ? 0 : Math.floor(((url.length - i - 1) * 3) / 4)
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
    sessions: '<path d="M12 3v6"/><circle cx="12" cy="12" r="3"/><path d="M12 15v6"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    browser: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    claude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'
  }

  function icon(name, size, extraClass) {
    var NS = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('class', 'av-icon' + (size ? ' av-icon-' + size : '') + (extraClass ? ' ' + extraClass : ''))
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
    dateBucket: dateBucket,
    countInWorktree: countInWorktree,
    syncStatus: syncStatus,
    plural: plural,
    relTime: relTime,
    fullTime: fullTime,
    kindLabel: kindLabel,
    hostOf: hostOf,
    fileName: fileName,
    worktreeLabel: worktreeLabel,
    versionBadge: versionBadge,
    coverCropRect: coverCropRect,
    thumbNeeded: thumbNeeded,
    createThumbQueue: createThumbQueue,
    ioFallbackDue: ioFallbackDue,
    IO_FALLBACK_MS: IO_FALLBACK_MS,
    dataUrlBytes: dataUrlBytes
  }
  if (typeof module !== 'undefined') module.exports = AV.model
})()
