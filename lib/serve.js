var fs = require('fs')
var qs = require('querystring')
var pull = require('pull-stream')
var path = require('path')
var paramap = require('pull-paramap')
var sort = require('ssb-sort')
var crypto = require('crypto')
var toPull = require('stream-to-pull-stream')
var serveEmoji = require('emoji-server')()
var u = require('./util')
var cat = require('pull-cat')
var h = require('hyperscript')
var paginate = require('pull-paginate')
var ssbMentions = require('ssb-mentions')
var multicb = require('multicb')
var pkg = require('../package')
var Busboy = require('busboy')

module.exports = Serve

var emojiDir = path.join(require.resolve('emoji-named-characters'), '../pngs')

var urlIdRegex = /^(?:\/+(([%&@]|%25)(?:[A-Za-z0-9\/+]|%2[Ff]|%2[Bb]){43}(?:=|%3D)\.(?:sha256|ed25519))(?:\.([^?]*))?|(\/.*?))(?:\?(.*))?$/

function isMsgReadable(msg) {
  var c = msg && msg.value.content
  return typeof c === 'object' && c !== null
}

function isMsgEncrypted(msg) {
  var c = msg && msg.value.content
  return typeof c === 'string'
}

function ctype(name) {
  switch (name && /[^.\/]*$/.exec(name)[0] || 'html') {
    case 'html': return 'text/html'
    case 'js': return 'text/javascript'
    case 'css': return 'text/css'
    case 'png': return 'image/png'
    case 'json': return 'application/json'
  }
}

function Serve(app, req, res) {
  this.app = app
  this.req = req
  this.res = res
  this.startDate = new Date()
}

Serve.prototype.go = function () {
  console.log(this.req.method, this.req.url)
  var self = this

  if (this.req.method === 'POST' || this.req.method === 'PUT') {
    if (/^multipart\/form-data/.test(this.req.headers['content-type'])) {
      var data = {}
      var erred
      var busboy = new Busboy({headers: this.req.headers})
      var filesCb = multicb({pluck: 1})
      busboy.on('finish', filesCb())
      filesCb(function (err) {
        gotData(err, data)
      })
      busboy.on('file', function (fieldname, file, filename, encoding, mimetype) {
        var done = multicb({pluck: 1, spread: true})
        var cb = filesCb()
        pull(
          toPull(file),
          u.pullLength(done()),
          self.app.addBlob(done())
        )
        done(function (err, size, id) {
          if (err) return cb(err)
          data[fieldname] = {link: id, name: filename, type: mimetype, size: size}
          cb()
        })
      })
      busboy.on('field', function (fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
        data[fieldname] = val
      })
      this.req.pipe(busboy)
    } else {
      pull(
        toPull(this.req),
        pull.collect(function (err, bufs) {
          var data
          if (!err) try {
            data = qs.parse(Buffer.concat(bufs).toString('ascii'))
          } catch(e) {
            err = e
          }
          gotData(err, data)
        })
      )
    }
  } else {
    gotData(null, {})
  }
  function gotData(err, data) {
    if (err) {
      self.req.writeHead(400, {'Content-Type': 'text/plain'})
      self.req.end(err.stack)
    } else {
      self.data = data
      self.handle()
    }
  }
}

Serve.prototype.handle = function () {
  var m = urlIdRegex.exec(this.req.url)
  this.query = m[5] ? qs.parse(m[5]) : {}
  switch (m[2]) {
    case '%25': m[2] = '%'; m[1] = decodeURIComponent(m[1])
    case '%': return this.id(m[1], m[3])
    case '@': return this.userFeed(m[1], m[3])
    case '&': return this.blob(m[1])
    default: return this.path(m[4])
  }
}

Serve.prototype.respond = function (status, message) {
  this.res.writeHead(status)
  this.res.end(message)
}

Serve.prototype.respondSink = function (status, headers, cb) {
  var self = this
  self.res.writeHead(status, headers)
  return toPull(self.res, cb || function (err) {
    if (err) self.error(err)
  })
}

Serve.prototype.path = function (url) {
  var m
  url = url.replace(/^\/+/, '/')
  switch (url) {
    case '/': return this.home()
    case '/robots.txt': return this.res.end('User-agent: *')
  }
  if (m = /^\/%23(.*)/.exec(url)) {
    return this.channel(decodeURIComponent(m[1]))
  }
  m = /^([^.]*)(?:\.(.*))?$/.exec(url)
  switch (m[1]) {
    case '/public': return this.public(m[2])
    case '/private': return this.private(m[2])
    case '/search': return this.search(m[2])
    case '/vote': return this.vote(m[2])
  }
  m = /^(\/?[^\/]*)(\/.*)?$/.exec(url)
  switch (m[1]) {
    case '/type': return this.type(m[2])
    case '/links': return this.links(m[2])
    case '/static': return this.static(m[2])
    case '/emoji': return this.emoji(m[2])
  }
  return this.respond(404, 'Not found')
}

Serve.prototype.home = function () {
  pull(
    pull.empty(),
    this.wrapPage('/'),
    this.respondSink(200, {
      'Content-Type': 'text/html'
    })
  )
}

Serve.prototype.public = function (ext) {
  var q = this.query
  var opts = {
    reverse: !q.forwards,
    sortByTimestamp: q.sort === 'claimed',
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    limit: Number(q.limit) || 12
  }

  pull(
    this.app.createLogStream(opts),
    this.renderThreadPaginated(opts, null, q),
    this.wrapMessages(),
    this.wrapPublic(),
    this.wrapPage('public'),
    this.respondSink(200, {
      'Content-Type': ctype(ext)
    })
  )
}

Serve.prototype.private = function (ext) {
  var q = this.query
  var opts = {
    reverse: !q.forwards,
    sortByTimestamp: q.sort === 'claimed',
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
  }
  var limit = Number(q.limit) || 12

  pull(
    this.app.createLogStream(opts),
    pull.filter(isMsgEncrypted),
    paramap(this.app.unboxMsg, 4),
    pull.filter(isMsgReadable),
    pull.take(limit),
    this.renderThreadPaginated(opts, null, q),
    this.wrapMessages(),
    this.wrapPrivate(opts),
    this.wrapPage('private'),
    this.respondSink(200, {
      'Content-Type': ctype(ext)
    })
  )
}

Serve.prototype.search = function (ext) {
  var searchQ = (this.query.q || '').trim()
  var self = this

  if (/^ssb:\/\//.test(searchQ)) {
    var maybeId = searchQ.substr(6)
    if (u.isRef(maybeId)) searchQ = maybeId
  }

  if (u.isRef(searchQ)) {
    self.res.writeHead(302, {
      Location: self.app.render.toUrl(searchQ)
    })
    return self.res.end()
  }

  pull(
    self.app.search(searchQ),
    self.renderThread(),
    self.wrapMessages(),
    self.wrapPage('search · ' + searchQ, searchQ),
    self.respondSink(200, {
      'Content-Type': ctype(ext),
    })
  )
}

Serve.prototype.type = function (path) {
  var q = this.query
  var type = path.substr(1)
  var opts = {
    reverse: !q.forwards,
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    limit: Number(q.limit) || 12,
    type: type,
  }

  pull(
    this.app.sbot.messagesByType(opts),
    this.renderThreadPaginated(opts, null, q),
    this.wrapMessages(),
    this.wrapType(type),
    this.wrapPage('type: ' + type),
    this.respondSink(200, {
      'Content-Type': ctype('html')
    })
  )
}

Serve.prototype.links = function (path) {
  var q = this.query
  var dest = path.substr(1)
  var opts = {
    dest: dest,
    reverse: true,
    values: true,
  }

  pull(
    this.app.sbot.links(opts),
    this.renderThread(opts, null, q),
    this.wrapMessages(),
    this.wrapLinks(dest),
    this.wrapPage('links: ' + dest),
    this.respondSink(200, {
      'Content-Type': ctype('html')
    })
  )
}

Serve.prototype.vote = function (ext) {
  var self = this

  var content = {
    type: 'vote',
    vote: {
      link: self.data.link,
      value: self.data.value,
      expression: self.data.expression,
    }
  }
  if (self.data.recps) content.recps = self.data.recps.split(',')
  self.app.publish(content, function (err, msg) {
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage(content.vote.expression),
      self.respondSink(500, {
        'Content-Type': ctype(ext)
      })
    )

    pull(
      pull.once(msg),
      pull.asyncMap(self.app.unboxMsg),
      self.app.render.renderFeeds(false),
      pull.map(u.toHTML),
      self.wrapMessages(),
      u.hyperwrap(function (content, cb) {
        cb(null, h('div',
          'published:',
          content
        ))
      }),
      self.wrapPage('published'),
      self.respondSink(302, {
        'Content-Type': ctype(ext),
        'Location': self.app.render.toUrl(msg.key)
      })
    )
  })
}

Serve.prototype.rawId = function (id) {
  var self = this

  self.app.getMsgDecrypted(id, function (err, msg) {
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.respondSink(400, {'Content-Type': ctype('html')})
    )
    return pull(
      pull.once(msg),
      self.renderRawMsgPage(id),
      self.respondSink(200, {
        'Content-Type': ctype('html'),
      })
    )
  })
}

Serve.prototype.channel = function (channel) {
  var q = this.query
  var gt = Number(q.gt) || -Infinity
  var lt = Number(q.lt) || Date.now()
  var opts = {
    reverse: !q.forwards,
    lt: lt,
    gt: gt,
    limit: Number(q.limit) || 12,
    query: [{$filter: {
      value: {content: {channel: channel}},
      timestamp: {
        $gt: gt,
        $lt: lt,
      }
    }}]
  }

  pull(
    this.app.sbot.query.read(opts),
    this.renderThreadPaginated(opts, null, q),
    this.wrapMessages(),
    this.wrapChannel(channel),
    this.wrapPage('#' + channel),
    this.respondSink(200, {
      'Content-Type': ctype('html')
    })
  )
}

function threadHeads(msgs, rootId) {
  return sort.heads(msgs.filter(function (msg) {
    var c = msg.value.content
    return (c && c.root === rootId)
      || msg.key === rootId
  }))
}


Serve.prototype.id = function (id, ext) {
  var self = this
  if (self.query.raw != null) return self.rawId(id)

  this.app.getMsgDecrypted(id, function (err, rootMsg) {
    var rootContent = rootMsg && rootMsg.value.content
    var getRoot = err ? pull.error(err) : pull.once(rootMsg)
    var recps = rootContent && rootContent.recps
    var threadRootId = rootContent && rootContent.root || id
    var channel = rootContent && rootContent.channel

    pull(
      cat([getRoot, self.app.sbot.links({dest: id, values: true})]),
      pull.unique('key'),
      paramap(self.app.unboxMsg, 4),
      pull.collect(function (err, links) {
        if (err) return self.respond(500, err.stack || err)
        pull(
          pull.values(sort(links)),
          self.renderThread(),
          self.wrapMessages(),
          self.wrapThread({
            recps: recps,
            root: threadRootId,
            branches: id === threadRootId ? threadHeads(links, id) : id,
            channel: channel,
          }),
          self.wrapPage(id),
          self.respondSink(200, {
            'Content-Type': ctype(ext),
          })
        )
      })
    )
  })
}

Serve.prototype.userFeed = function (id, ext) {
  var self = this
  var q = self.query
  var opts = {
    id: id,
    reverse: !q.forwards,
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    limit: Number(q.limit) || 20
  }

  self.app.getAbout(id, function (err, about) {
    if (err) self.app.error(err)
    pull(
      self.app.sbot.createUserStream(opts),
      self.renderThreadPaginated(opts, id, q),
      self.wrapMessages(),
      self.wrapUserFeed(id),
      self.wrapPage(about.name),
      self.respondSink(200, {
        'Content-Type': ctype(ext)
      })
    )
  })
}

Serve.prototype.file = function (file) {
  var self = this
  fs.stat(file, function (err, stat) {
    if (err && err.code === 'ENOENT') return self.respond(404, 'Not found')
    if (err) return self.respond(500, err.stack || err)
    if (!stat.isFile()) return self.respond(403, 'May only load files')
    if (self.ifModified(stat.mtime)) return self.respond(304, 'Not modified')
    self.res.writeHead(200, {
      'Content-Type': ctype(file),
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toGMTString()
    })
    fs.createReadStream(file).pipe(self.res)
  })
}

Serve.prototype.static = function (file) {
  this.file(path.join(__dirname, '../static', file))
}

Serve.prototype.emoji = function (emoji) {
  serveEmoji(this.req, this.res, emoji)
}

Serve.prototype.blob = function (id) {
  var self = this
  var blobs = self.app.sbot.blobs
  if (self.req.headers['if-none-match'] === id) return self.respond(304)
  blobs.want(id, function (err, has) {
    if (err) {
      if (/^invalid/.test(err.message)) return self.respond(400, err.message)
      else return self.respond(500, err.message || err)
    }
    if (!has) return self.respond(404, 'Not found')
    pull(
      blobs.get(id),
      pull.map(Buffer),
      self.respondSink(200, {
        'Cache-Control': 'public, max-age=315360000',
        'etag': id
      })
    )
  })
}

Serve.prototype.ifModified = function (lastMod) {
  var ifModSince = this.req.headers['if-modified-since']
  if (!ifModSince) return false
  var d = new Date(ifModSince)
  return d && Math.floor(d/1000) >= Math.floor(lastMod/1000)
}

Serve.prototype.wrapMessages = function () {
  return u.hyperwrap(function (content, cb) {
    cb(null, h('table.ssb-msgs', content))
  })
}

Serve.prototype.renderThread = function () {
  return pull(
    this.app.render.renderFeeds(false),
    pull.map(u.toHTML)
  )
}

function mergeOpts(a, b) {
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

Serve.prototype.renderThreadPaginated = function (opts, feedId, q) {
  function link(opts, name, cb) {
    cb(null, h('tr', h('td.paginate', {colspan: 2},
      h('a', {href: '?' + qs.stringify(mergeOpts(q, opts))}, name))))
  }
  return pull(
    paginate(
      function onFirst(msg, cb) {
        var num = feedId ? msg.value.sequence : msg.timestamp || msg.ts
        if (q.forwards) {
          link({
            lt: num,
            gt: null,
            forwards: null,
          }, '↓ older', cb)
        } else {
          link({
            lt: null,
            gt: num,
            forwards: 1,
          }, '↑ newer', cb)
        }
      },
      this.app.render.renderFeeds(),
      function onLast(msg, cb) {
        var num = feedId ? msg.value.sequence : msg.timestamp || msg.ts
        if (q.forwards) {
          link({
            lt: null,
            gt: num,
            forwards: 1,
          }, '↑ newer', cb)
        } else {
          link({
            lt: num,
            gt: null,
            forwards: null,
          }, '↓ older', cb)
        }
      },
      function onEmpty(cb) {
        if (q.forwards) {
          link({
            gt: null,
            lt: opts.gt + 1,
            forwards: null,
          }, '↓ older', cb)
        } else {
          link({
            gt: opts.lt - 1,
            lt: null,
            forwards: 1,
          }, '↑ newer', cb)
        }
      }
    ),
    pull.map(u.toHTML)
  )
}

Serve.prototype.renderRawMsgPage = function (id) {
  return pull(
    this.app.render.renderFeeds(true),
    pull.map(u.toHTML),
    this.wrapMessages(),
    this.wrapPage(id)
  )
}

function catchHTMLError() {
  return function (read) {
    var ended
    return function (abort, cb) {
      if (ended) return cb(ended)
      read(abort, function (end, data) {
        if (!end || end === true) return cb(end, data)
        ended = true
        cb(null, u.renderError(end).outerHTML)
      })
    }
  }
}

function styles() {
  return fs.readFileSync(path.join(__dirname, '../static/styles.css'), 'utf8')
}

Serve.prototype.appendFooter = function () {
  var self = this
  return function (read) {
    return cat([read, u.readNext(function (cb) {
      var ms = new Date() - self.startDate
      cb(null, pull.once(h('footer',
        h('a', {href: pkg.homepage}, pkg.name), ' · ',
        ms/1000 + 's'
      ).outerHTML))
    })])
  }
}

Serve.prototype.wrapPage = function (title, searchQ) {
  var self = this
  var render = self.app.render
  return pull(
    catchHTMLError(),
    self.appendFooter(),
    u.hyperwrap(function (content, cb) {
      var done = multicb({pluck: 1, spread: true})
      done()(null, h('html', h('head',
        h('meta', {charset: 'utf-8'}),
        h('title', title),
        h('meta', {name: 'viewport', content: 'width=device-width,initial-scale=1'}),
        h('style', styles())
      ),
      h('body',
        h('nav.nav-bar', h('form', {action: render.toUrl('/search'), method: 'get'},
          h('a', {href: render.toUrl('/public')}, 'public'), ' ',
          h('a', {href: render.toUrl('/private')}, 'private') , ' ',
          render.idLink(self.app.sbot.id, done()), ' ',
          h('input.search-input', {name: 'q', value: searchQ,
            placeholder: 'search'})
          // h('a', {href: '/convos'}, 'convos'), ' ',
          // h('a', {href: '/friends'}, 'friends'), ' ',
          // h('a', {href: '/git'}, 'git')
        )),
        content
      )))
      done(cb)
    })
  )
}

Serve.prototype.wrapUserFeed = function (id) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    self.app.getAbout(id, function (err, about) {
      if (err) return cb(err)
      var done = multicb({pluck: 1, spread: true})
      done()(null, [
        h('section.ssb-feed',
          h('table', h('tr',
            h('td', self.app.render.avatarImage(id, done())),
            h('td.feed-about',
              h('h3.feed-name',
                h('strong', self.app.render.idLink(id, done()))),
              h('code', h('small', id)),
            about.description ? h('div',
              {innerHTML: self.app.render.markdown(about.description)}) : ''
          )))
        ),
        thread
      ])
      done(cb)
    })
  })
}

Serve.prototype.wrapPublic = function (opts) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    self.composer({
      channel: '',
    }, function (err, composer) {
      if (err) return cb(err)
      cb(null, [
        composer,
        thread
      ])
    })
  })
}

Serve.prototype.wrapPrivate = function (opts) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    self.composer({
      placeholder: 'private message',
      private: true,
    }, function (err, composer) {
      if (err) return cb(err)
      cb(null, [
        composer,
        thread
      ])
    })
  })
}

Serve.prototype.wrapThread = function (opts) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    self.app.render.prepareLinks(opts.recps, function (err, recps) {
      if (err) return cb(er)
      self.composer({
        placeholder: recps ? 'private reply' : 'reply',
        id: 'reply',
        root: opts.root,
        channel: opts.channel || '',
        branches: opts.branches,
        recps: recps,
      }, function (err, composer) {
        if (err) return cb(err)
        cb(null, [
          thread,
          composer
        ])
      })
    })
  })
}

Serve.prototype.wrapChannel = function (channel) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    self.composer({
      placeholder: 'public message in #' + channel,
      channel: channel,
    }, function (err, composer) {
      if (err) return cb(err)
      cb(null, [
        h('section',
          h('h3.feed-name',
            h('a', {href: self.app.render.toUrl('#' + channel)}, '#' + channel)
          )
        ),
        composer,
        thread
      ])
    })
  })
}

Serve.prototype.wrapType = function (type) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    cb(null, [
      h('section',
        h('h3.feed-name',
          h('a', {href: self.app.render.toUrl('/type/' + type)},
            h('code', type), 's'))
      ),
      thread
    ])
  })
}

Serve.prototype.wrapLinks = function (dest) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    cb(null, [
      h('section',
        h('h3.feed-name', 'links: ',
          h('a', {href: self.app.render.toUrl('/links/' + dest)},
            h('code', dest)))
      ),
      thread
    ])
  })
}

function rows(str) {
  return String(str).split(/[^\n]{70}|\n/).length
}

Serve.prototype.composer = function (opts, cb) {
  var self = this
  opts = opts || {}
  var data = self.data

  var blobs = u.tryDecodeJSON(data.blobs) || {}
  if (data.upload && typeof data.upload === 'object') {
    blobs[data.upload.link] = {
      type: data.upload.type,
      size: data.upload.size,
    }
  }

  var done = multicb({pluck: 1, spread: true})
  done()(null, h('section.composer',
    h('form', {method: 'post', action: opts.id ? '#' + opts.id : '',
      enctype: 'multipart/form-data'},
      h('input', {type: 'hidden', name: 'blobs',
        value: JSON.stringify(blobs)}),
      opts.recps ? self.app.render.privateLine(opts.recps, done()) :
      opts.private ? h('div', h('input.recps-input', {name: 'recps',
        value: data.recps || '', placeholder: 'recipient ids'})) : '',
      data.channel || opts.channel != null ?
        h('div', '#', h('input', {name: 'channel', placeholder: 'channel',
          value: data.channel || opts.channel || ''})) : '',
      h('textarea', {
        id: opts.id,
        name: 'text',
        rows: Math.max(4, rows(data.text)),
        cols: 70,
        placeholder: opts.placeholder || 'public message',
      }, data.text || ''),
      h('table.ssb-msgs',
        h('tr.msg-row',
          h('td.msg-left', {colspan: 2},
            h('input', {type: 'file', name: 'upload'}), ' ',
            h('input', {type: 'submit', name: 'action', value: 'attach'})
          ),
          h('td.msg-right',
            h('input', {type: 'submit', name: 'action', value: 'raw'}), ' ',
            h('input', {type: 'submit', name: 'action', value: 'preview'})
          )
        )
      ),
      data.upload ? [
        h('div', h('em', 'attach:')),
        h('pre', '[' + data.upload.name + '](' + data.upload.link + ')')
      ] : '',
      data.action === 'preview' ? preview(false, done()) :
      data.action === 'raw' ? preview(true, done()) :
      data.action === 'publish' ? publish(done()) : ''
    )
  ))
  done(cb)

  function preview(raw, cb) {
    var myId = self.app.sbot.id
    var content
    try {
      content = JSON.parse(data.text)
    } catch (err) {
      data.text = String(data.text).replace(/\r\n/g, '\n')
      content = {
        type: 'post',
        text: data.text,
      }
      var mentions = ssbMentions(data.text)
      if (mentions.length) {
        content.mentions = mentions.map(function (mention) {
          var blob = blobs[mention.link]
          if (blob) {
            if (!isNaN(blob.size))
              mention.size = blob.size
            if (blob.type && blob.type !== 'application/octet-stream')
              mention.type = blob.type
          }
          return mention
        })
      }
      if (data.recps != null) {
        if (opts.recps) return cb(new Error('got recps in opts and data'))
        content.recps = [myId]
        String(data.recps).replace(u.ssbRefRegex, function (recp) {
          if (content.recps.indexOf(recp) === -1) content.recps.push(recp)
        })
      } else {
        if (opts.recps) content.recps = opts.recps
      }
      if (opts.root) content.root = opts.root
      if (opts.branches) content.branch = u.fromArray(opts.branches)
      if (data.channel) content.channel = data.channel
    }
    var msg = {
      value: {
        author: myId,
        timestamp: Date.now(),
        content: content
      }
    }
    if (content.recps) msg.value.private = true
    var msgContainer = h('table.ssb-msgs')
    pull(
      pull.once(msg),
      pull.asyncMap(self.app.unboxMsg),
      self.app.render.renderFeeds(raw),
      pull.drain(function (el) {
        msgContainer.appendChild(el)
      }, cb)
    )
    return h('form', {method: 'post', action: '#reply'},
      h('input', {type: 'hidden', name: 'content',
        value: JSON.stringify(content)}),
      h('div', h('em', 'draft:')),
      msgContainer,
      h('div.composer-actions',
        h('input', {type: 'submit', name: 'action', value: 'publish'})
      )
    )
  }

  function publish(cb) {
    var content
    try {
      content = JSON.parse(self.data.content)
    } catch(e) {
      return cb(), u.renderError(e)
    }
    return self.app.render.publish(content, cb)
  }

}
