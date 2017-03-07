var pull = require('pull-stream')
var cat = require('pull-cat')
var h = require('hyperscript')
var u = exports

u.ssbRefRegex = /((?:@|%|&|ssb:\/\/%)[A-Za-z0-9\/+]{43}=\.[\w\d]+)/g

u.isRef = function (str) {
  u.ssbRefRegex.lastIndex = 0
  return u.ssbRefRegex.test(str)
}

u.readNext = function (fn) {
  var next
  return function (end, cb) {
    if (next) return next(end, cb)
    fn(function (err, _next) {
      if (err) return cb(err)
      next = _next
      next(null, cb)
    })
  }
}

u.pullReverse = function () {
  return function (read) {
    return u.readNext(function (cb) {
      pull(read, pull.collect(function (err, items) {
        cb(err, items && pull.values(items.reverse()))
      }))
    })
  }
}

u.toHTML = function (el) {
  if (!el) return ''
  if (typeof el === 'string' || Array.isArray(el)) {
    return h('div', el).innerHTML
  }
  var html = el.outerHTML || String(el)
  if (el.nodeName === 'html') html = '<!doctype html>' + html + '\n'
  return html
}

u.hyperwrap = function (fn) {
  var token = '__HYPERWRAP_' + Math.random() + '__'
  return function (read) {
    return u.readNext(function (cb) {
      fn(token, function (err, el) {
        if (err) return cb(err)
        var parts = u.toHTML(el).split(token)
        switch (parts.length) {
          case 0: return cb(null, pull.empty())
          case 1: return cb(null, pull.once(parts[0]))
          case 2: return cb(null,
            cat([pull.once(parts[0]), read, pull.once(parts[1])]))
          default: return cb(new Error('duplicate wrap'))
        }
      })
    })
  }
}

u.linkDest = function (link) {
  return typeof link === 'string' ? link : link && link.link || link
}

u.toArray = function (x) {
  return !x ? [] : Array.isArray(x) ? x : [x]
}

u.fromArray = function (arr) {
  return Array.isArray(arr) && arr.length === 1 ? arr[0] : arr
}

u.renderError = function(err) {
  return h('div.error',
    h('h3', err.name),
    h('pre', err.stack))
}

u.pullLength = function (cb) {
  var len = 0
  return pull.through(function (data) {
    len += data.length
  }, function (err) {
    cb(err, len)
  })
}

u.tryDecodeJSON = function (json) {
  try {
    return JSON.parse(json)
  } catch(e) {
    return null
  }
}

u.extractFeedIds = function (str) {
  var ids = []
  String(str).replace(u.ssbRefRegex, function (id) {
    ids.push(id)
  })
  return ids
}
