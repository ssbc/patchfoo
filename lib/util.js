var pull = require('pull-stream')
var cat = require('pull-cat')
var h = require('hyperscript')
var b64url = require('base64-url')
var u = exports

u.ssbRefRegex = /((?:@|%|&|ssb:\/\/%)[A-Za-z0-9\/+]{43}=\.[\w\d]+)/g
u.ssbRefRegexOnly = /^(?:@|%|&|ssb:\/\/%)[A-Za-z0-9\/+]{43}=\.[\w\d]+$/
u.ssbRefEncRegex = /((?:ssb:\/\/)?(?:[@%&]|%26|%40|%25)(?:[A-Za-z0-9\/+]|%2[fF]|%2[bB]){43}(?:=|%3[dD])\.[\w\d]+)/g

u.isRef = function (str) {
  if (!str) return false
  u.ssbRefRegexOnly.lastIndex = 0
  return u.ssbRefRegexOnly.test(str)
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

u.ifString = function (str) {
  if (typeof str === 'string') return str
}

u.ifNumber = function (num) {
  if (!isNaN(num)) return num
}

u.toLink = function (link) {
  return typeof link === 'string' ? {link: link} : link || null
}

u.linkDest = function (link) {
  return link && (u.ifString(link) || u.ifString(link.link))
}

u.toArray = function (x) {
  return x == null ? [] : Array.isArray(x) ? x : [x]
}

u.fromArray = function (arr) {
  return Array.isArray(arr) && arr.length === 1 ? arr[0] : arr
}

u.toLinkArray = function (x) {
  return u.toArray(x).map(u.toLink).filter(u.linkDest)
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

u.extractRefs = function (str) {
  var ids = []
  String(str).replace(u.ssbRefRegex, function (id) {
    ids.push(id)
  })
  return ids
}

u.extractFeedIds = function (str) {
  return u.extractRefs(str).filter(function (ref) {
    return ref[0] === '@'
  })
}

u.extractBlobIds = function (str) {
  return u.extractRefs(str).filter(function (ref) {
    return ref[0] === '&'
  })
}

u.isMsgReadable = function (msg) {
  var c = msg && msg.value && msg.value.content
  return typeof c === 'object' && c !== null
}

u.isMsgEncrypted = function (msg) {
  var c = msg && msg.value.content
  return typeof c === 'string'
}

u.pullConcat = function (cb) {
  return pull.collect(function (err, bufs) {
    if (err) return cb(err)
    cb(null, Buffer.concat(bufs))
  })
}

u.customError = function (name) {
  return function (message) {
    var error = new Error(message)
    error.name = name
    error.stack = error.stack.replace(/^    at .*\n/m, '')
    return error
  }
}

u.escapeHTML = function (html) {
  if (!html) return ''
  return html.toString('utf8')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

u.pullSlice = function (start, end) {
  if (end == null) end = Infinity
  var offset = 0
  return function (read) {
    return function (abort, cb) {
      if (abort) read(abort, cb)
      else if (offset >= end) read(true, function (err) {
        cb(err || true)
      })
      else if (offset < start) read(null, function next(err, data) {
        if (err) return cb(err)
        offset += data.length
        if (offset <= start) read(null, next)
        else if (offset < end) cb(null,
          data.slice(data.length - (offset - start)))
        else cb(null, data.slice(data.length - (offset - start),
          data.length - (offset - end)))
      })
      else read(null, function (err, data) {
        if (err) return cb(err)
        offset += data.length
        if (offset <= end) cb(null, data)
          else cb(null, data.slice(0, data.length - (offset - end)))
      })
    }
  }
}

u.mergeOpts = function (a, b) {
  var obj = {}, k
  for (k in a) {
    obj[k] = a[k]
  }
  for (k in b) {
    if (b[k] != null) obj[k] = b[k]
    else delete obj[k]
  }
  return obj
}

u.escapeId = function (id) {
  return b64url.escape(id)
}

u.unescapeId = function (str) {
  var m = /^(.)(.*)(\..*)$/.exec(str)
  if (!m) return b64url.unescape(str)
  return m[1] + b64url.unescape(m[2]) + m[3]
}

u.rows = function (str) {
  return String(str).split(/[^\n]{150}|\n/).length
}
