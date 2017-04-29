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
var mime = require('mime-types')
var ident = require('pull-identify-filetype')
var htime = require('human-time')
var ph = require('pull-hyperscript')

module.exports = Serve

var emojiDir = path.join(require.resolve('emoji-named-characters'), '../pngs')

var urlIdRegex = /^(?:\/+(([%&@]|%25)(?:[A-Za-z0-9\/+]|%2[Ff]|%2[Bb]){43}(?:=|%3D)\.(?:sha256|ed25519))(?:\.([^?]*))?|(\/.*?))(?:\?(.*))?$/

function isMsgEncrypted(msg) {
  var c = msg && msg.value.content
  return typeof c === 'string'
}

function ctype(name) {
  switch (name && /[^.\/]*$/.exec(name)[0] || 'html') {
    case 'html': return 'text/html'
    case 'txt': return 'text/plain'
    case 'js': return 'text/javascript'
    case 'css': return 'text/css'
    case 'png': return 'image/png'
    case 'json': return 'application/json'
    case 'ico': return 'image/x-icon'
  }
}

function encodeDispositionFilename(fname) {
  fname = fname.replace(/\/g/, '\\\\').replace(/"/, '\\\"')
  return '"' + encodeURIComponent(fname) + '"'
}

function uniques() {
  var set = {}
  return function (item) {
    if (set[item]) return false
    return set[item] = true
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

  this.res.setTimeout(0)

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
          if (size === 0 && !filename) return cb()
          data[fieldname] = {link: id, name: filename, type: mimetype, size: size}
          cb()
        })
      })
      busboy.on('field', function (fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
        if (!(fieldname in data)) data[fieldname] = val
        else if (Array.isArray(data[fieldname])) data[fieldname].push(val)
        else data[fieldname] = [data[fieldname], val]
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
    self.data = data
    if (err) next(err)
    else if (data.action === 'publish') self.publishJSON(next)
    else if (data.action === 'vote') self.publishVote(next)
    else if (data.action === 'contact') self.publishContact(next)
    else next()
  }

  function next(err) {
    if (err) {
      self.res.writeHead(400, {'Content-Type': 'text/plain'})
      self.res.end(err.stack)
    } else {
      self.handle()
    }
  }
}

Serve.prototype.publishJSON = function (cb) {
  var content
  try {
    content = JSON.parse(this.data.content)
  } catch(e) {
    return cb(e)
  }
  this.publish(content, cb)
}

Serve.prototype.publishVote = function (cb) {
  var content = {
    type: 'vote',
    channel: this.data.channel || undefined,
    vote: {
      link: this.data.link,
      value: Number(this.data.value),
      expression: this.data.expression,
    }
  }
  if (this.data.recps) content.recps = this.data.recps.split(',')
  this.publish(content, cb)
}

Serve.prototype.publishContact = function (cb) {
  var content = {
    type: 'contact',
    contact: this.data.contact,
    following: !!this.data.following
  }
  this.publish(content, cb)
}

Serve.prototype.publish = function (content, cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  u.toArray(content && content.mentions).forEach(function (mention) {
    if (mention.link && mention.link[0] === '&' && !isNaN(mention.size))
      self.app.pushBlob(mention.link, done())
  })
  done(function (err) {
    if (err) return cb(err)
    self.app.publish(content, function (err, msg) {
      if (err) return cb(err)
      delete self.data.text
      delete self.data.recps
      self.publishedMsg = msg
      return cb()
    })
  })
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
  if (status && headers) self.res.writeHead(status, headers)
  return toPull(self.res, cb || function (err) {
    if (err) self.app.error(err)
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
    case '/new': return this.new(m[2])
    case '/public': return this.public(m[2])
    case '/private': return this.private(m[2])
    case '/search': return this.search(m[2])
    case '/advsearch': return this.advsearch(m[2])
    case '/vote': return this.vote(m[2])
    case '/peers': return this.peers(m[2])
    case '/channels': return this.channels(m[2])
    case '/friends': return this.friends(m[2])
    case '/live': return this.live(m[2])
  }
  m = /^(\/?[^\/]*)(\/.*)?$/.exec(url)
  switch (m[1]) {
    case '/type': return this.type(m[2])
    case '/links': return this.links(m[2])
    case '/static': return this.static(m[2])
    case '/emoji': return this.emoji(m[2])
    case '/contacts': return this.contacts(m[2])
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

Serve.prototype.setCookie = function (key, value, options) {
  var header = key + '=' + value
  if (options) for (var k in options) {
    header += '; ' + k + '=' + options[k]
  }
  this.res.setHeader('Set-Cookie', header)
}

Serve.prototype.new = function (ext) {
  var self = this
  var q = self.query
  var latest = (/latest=([^;]*)/.exec(self.req.headers.cookie) || [])[1]
  var opts = {
    gt: Number(q.gt) || Number(latest) || Date.now(),
  }

  if (q.catchup) self.setCookie('latest', opts.gt, {'Max-Age': 86400000})

  var read = self.app.createLogStream(opts)
  self.req.on('closed', function () {
    console.error('closing')
    read(true, function (err) {
      console.log('closed')
      if (err && err !== true) console.error(new Error(err.stack))
    })
  })
  pull.collect(function (err, msgs) {
    if (err) return pull(
      pull.once(u.renderError(err, ext).outerHTML),
      self.wrapPage('peers'),
      self.respondSink(500, {'Content-Type': ctype(ext)})
    )
    sort(msgs)
    var maxTS = msgs.reduce(function (max, msg) {
      return Math.max(msg.timestamp, max)
    }, -Infinity)
    pull(
      pull.values(msgs),
      self.renderThread(opts, null, q),
      self.wrapNew({
        gt: isFinite(maxTS) ? maxTS : Date.now()
      }),
      self.wrapMessages(),
      self.wrapPage('new'),
      self.respondSink(200, {
        'Content-Type': ctype(ext)
      })
    )
  })(read)
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
    this.app.unboxMessages(),
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

  if (u.isRef(searchQ) || searchQ[0] === '#') {
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

Serve.prototype.advsearch = function (ext) {
  var self = this
  var q = this.query || {}

  if (q.source) q.source = u.extractFeedIds(q.source)[0]
  if (q.dest) q.dest = u.extractFeedIds(q.dest)[0]
  var hasQuery = q.text || q.source || q.dest

  pull(
    cat([
      ph('section', {}, [
        ph('form', {action: '', method: 'get'}, [
          ph('table', [
            ph('tr', [
              ph('td', 'text'),
              ph('td', ph('input', {name: 'text', placeholder: 'regex',
                class: 'id-input',
                value: q.text || ''}))
            ]),
            ph('tr', [
              ph('td', 'author'),
              ph('td', ph('input', {name: 'source', placeholder: '@id',
                class: 'id-input',
                value: q.source || ''}))
            ]),
            ph('tr', [
              ph('td', 'mentions'),
              ph('td', ph('input', {name: 'dest', placeholder: 'id',
                class: 'id-input',
                value: q.dest || ''}))
            ]),
            ph('tr', [
              ph('td', {colspan: 2}, [
                ph('input', {type: 'submit', value: 'search'})
              ])
            ]),
          ])
        ])
      ]),
      hasQuery && pull(
        self.app.advancedSearch(q),
        self.renderThread(),
        self.wrapMessages()
      )
    ]),
    self.wrapPage('advanced search'),
    self.respondSink(200, {
      'Content-Type': ctype(ext),
    })
  )
}

Serve.prototype.live = function (ext) {
  var self = this
  var q = self.query
  var opts = {
    live: true,
  }
  var gt = Number(q.gt)
  if (gt) opts.gt = gt
  else opts.old = false

  pull(
    ph('table', {class: 'ssb-msgs'}, pull(
      self.app.sbot.createLogStream(opts),
      self.app.render.renderFeeds({
        withGt: true,
      }),
      pull.map(u.toHTML)
    )),
    self.wrapPage('live'),
    self.respondSink(200, {
      'Content-Type': ctype(ext),
    })
  )
}

Serve.prototype.peers = function (ext) {
  var self = this
  if (self.data.action === 'connect') {
    return self.app.sbot.gossip.connect(self.data.address, function (err) {
      if (err) return pull(
        pull.once(u.renderError(err, ext).outerHTML),
        self.wrapPage('peers'),
        self.respondSink(400, {'Content-Type': ctype(ext)})
      )
      self.data = {}
      return self.peers(ext)
    })
  }

  pull(
    self.app.streamPeers(),
    paramap(function (peer, cb) {
      var done = multicb({pluck: 1, spread: true})
      var connectedTime = Date.now() - peer.stateChange
      var addr = peer.host + ':' + peer.port + ':' + peer.key
      done()(null, h('section',
        h('form', {method: 'post', action: ''},
          peer.client ? '→' : '←', ' ',
          h('code', peer.host, ':', peer.port, ':'),
          self.app.render.idLink(peer.key, done()), ' ',
          peer.stateChange ? [htime(new Date(peer.stateChange)), ' '] : '',
          peer.state === 'connected' ? 'connected' : [
            h('input', {name: 'action', type: 'submit', value: 'connect'}),
            h('input', {name: 'address', type: 'hidden', value: addr})
          ]
        )
        // h('div', 'source: ', peer.source)
        // JSON.stringify(peer, 0, 2)).outerHTML
      ))
      done(cb)
    }, 8),
    pull.map(u.toHTML),
    self.wrapPeers(),
    self.wrapPage('peers'),
    self.respondSink(200, {
      'Content-Type': ctype(ext)
    })
  )
}

Serve.prototype.channels = function (ext) {
  var self = this

  pull(
    self.app.streamChannels(),
    paramap(function (channel, cb) {
      var subscribed = false
      cb(null, [
        h('a', {href: self.app.render.toUrl('#' + channel)}, '#' + channel),
        ' '
      ])
    }, 8),
    pull.map(u.toHTML),
    self.wrapChannels(),
    self.wrapPage('channels'),
    self.respondSink(200, {
      'Content-Type': ctype(ext)
    })
  )
}

Serve.prototype.contacts = function (path) {
  var self = this
  var id = String(path).substr(1)
  var contacts = self.app.createContactStreams(id)

  function renderFriendsList() {
    return pull(
      paramap(function (id, cb) {
        self.app.getAbout(id, function (err, about) {
          var name = about && about.name || id.substr(0, 8) + '…'
          cb(null, h('a', {href: self.app.render.toUrl('/contacts/' + id)}, name))
        })
      }, 8),
      pull.map(function (el) {
        return [el, ' ']
      }),
      pull.flatten(),
      pull.map(u.toHTML)
    )
  }

  function idLink(id) {
    return pull(
      pull.once(id),
      pull.asyncMap(self.renderIdLink.bind(self)),
      pull.map(u.toHTML)
    )
  }

  pull(
    cat([
      ph('section', {}, [
        ph('h3', {}, ['Contacts: ', idLink(id)]),
        ph('h4', {}, 'Friends'),
        renderFriendsList()(contacts.friends),
        ph('h4', {}, 'Follows'),
        renderFriendsList()(contacts.follows),
        ph('h4', {}, 'Followers'),
        renderFriendsList()(contacts.followers)
      ])
    ]),
    this.wrapPage('contacts: ' + id),
    this.respondSink(200, {
      'Content-Type': ctype('html')
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
  if (q.rel) opts.rel = q.rel

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

  if (!this.app.sbot.query) return pull(
    pull.once(u.renderError(new Error('Missing ssb-query plugin')).outerHTML),
    this.wrapPage('#' + channel),
    this.respondSink(400, {'Content-Type': ctype('html')})
  )

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
    var c = msg.value && msg.value.content
    return (c && c.root === rootId)
      || msg.key === rootId
  }))
}


Serve.prototype.id = function (id, ext) {
  var self = this
  if (self.query.raw != null) return self.rawId(id)

  this.app.getMsgDecrypted(id, function (err, rootMsg) {
    if (err && err.name === 'NotFoundError') err = null, rootMsg = {key: id}
    if (err) return self.respond(500, err.stack || err)
    var rootContent = rootMsg && rootMsg.value && rootMsg.value.content
    var recps = rootContent && rootContent.recps
    var threadRootId = rootContent && rootContent.root || id
    var channel

    pull(
      cat([pull.once(rootMsg), self.app.sbot.links({dest: id, values: true})]),
      pull.unique('key'),
      self.app.unboxMessages(),
      pull.through(function (msg) {
        var c = msg && msg.value.content
        if (!channel && c.channel) channel = c.channel
      }),
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
  var isScrolled = q.lt || q.gt

  self.app.getAbout(id, function (err, about) {
    if (err) self.app.error(err)
    pull(
      self.app.sbot.createUserStream(opts),
      self.renderThreadPaginated(opts, id, q),
      self.wrapMessages(),
      self.wrapUserFeed(isScrolled, id),
      self.wrapPage(about.name || id),
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
      ident(function (type) {
        type = type && mime.lookup(type)
        if (type) self.res.setHeader('Content-Type', type)
        if (self.query.name) self.res.setHeader('Content-Disposition',
          'inline; filename='+encodeDispositionFilename(self.query.name))
        self.res.setHeader('Cache-Control', 'public, max-age=315360000')
        self.res.setHeader('etag', id)
        self.res.writeHead(200)
      }),
      self.respondSink()
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
  var self = this
  function linkA(opts, name) {
    var q1 = mergeOpts(q, opts)
    return h('a', {href: '?' + qs.stringify(q1)}, name || q1.limit)
  }
  function links(opts) {
    var limit = opts.limit || q.limit || 10
    return h('tr', h('td.paginate', {colspan: 3},
      opts.forwards ? '↑ newer ' : '↓ older ',
      linkA(mergeOpts(opts, {limit: 1})), ' ',
      linkA(mergeOpts(opts, {limit: 10})), ' ',
      linkA(mergeOpts(opts, {limit: 100}))
    ))
  }

  return pull(
    paginate(
      function onFirst(msg, cb) {
        var num = feedId ? msg.value.sequence : msg.timestamp || msg.ts
        if (q.forwards) {
          cb(null, links({
            lt: num,
            gt: null,
            forwards: null,
          }))
        } else {
          cb(null, links({
            lt: null,
            gt: num,
            forwards: 1,
          }))
        }
      },
      this.app.render.renderFeeds(),
      function onLast(msg, cb) {
        var num = feedId ? msg.value.sequence : msg.timestamp || msg.ts
        if (q.forwards) {
          cb(null, links({
            lt: null,
            gt: num,
            forwards: 1,
          }))
        } else {
          cb(null, links({
            lt: num,
            gt: null,
            forwards: null,
          }))
        }
      },
      function onEmpty(cb) {
        if (q.forwards) {
          cb(null, links({
            gt: null,
            lt: opts.gt + 1,
            forwards: null,
          }))
        } else {
          cb(null, links({
            gt: opts.lt - 1,
            lt: null,
            forwards: 1,
          }))
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
          h('a', {href: render.toUrl('/new')}, 'new') , ' ',
          h('a', {href: render.toUrl('/public')}, 'public'), ' ',
          h('a', {href: render.toUrl('/private')}, 'private') , ' ',
          h('a', {href: render.toUrl('/peers')}, 'peers') , ' ',
          h('a', {href: render.toUrl('/channels')}, 'channels') , ' ',
          h('a', {href: render.toUrl('/friends')}, 'friends'), ' ',
          h('a', {href: render.toUrl('/advsearch')}, 'search'), ' ',
          h('a', {href: render.toUrl('/live')}, 'live'), ' ',
          render.idLink(self.app.sbot.id, done()), ' ',
          h('input.search-input', {name: 'q', value: searchQ,
            placeholder: 'search'})
          // h('a', {href: '/convos'}, 'convos'), ' ',
          // h('a', {href: '/friends'}, 'friends'), ' ',
          // h('a', {href: '/git'}, 'git')
        )),
        self.publishedMsg ? h('div',
          'published ',
          self.app.render.msgLink(self.publishedMsg, done())
        ) : '',
        content
      )))
      done(cb)
    })
  )
}

Serve.prototype.renderIdLink = function (id, cb) {
  var render = this.app.render
  var el = render.idLink(id, function (err) {
    if (err || !el) {
      el = h('a', {href: render.toUrl(id)}, id)
    }
    cb(null, el)
  })
}

Serve.prototype.friends = function (path) {
  var self = this
  pull(
    self.app.sbot.friends.createFriendStream({hops: 1}),
    self.renderFriends(),
    pull.map(function (el) {
      return [el, ' ']
    }),
    pull.map(u.toHTML),
    u.hyperwrap(function (items, cb) {
      cb(null, [
        h('section',
          h('h3', 'Friends')
        ),
        h('section', items)
      ])
    }),
    this.wrapPage('friends'),
    this.respondSink(200, {
      'Content-Type': ctype('html')
    })
  )
}

Serve.prototype.renderFriends = function () {
  var self = this
  return paramap(function (id, cb) {
    self.renderIdLink(id, function (err, el) {
      if (err) el = u.renderError(err, ext)
      cb(null, el)
    })
  }, 8)
}

var relationships = [
  '',
  'followed',
  'follows you',
  'friend'
]

var relationshipActions = [
  'follow',
  'unfollow',
  'follow back',
  'unfriend'
]

Serve.prototype.wrapUserFeed = function (isScrolled, id) {
  var self = this
  var myId = self.app.sbot.id
  var render = self.app.render
  return u.hyperwrap(function (thread, cb) {
    var done = multicb({pluck: 1, spread: true})
    self.app.getAbout(id, done())
    self.app.getFollow(myId, id, done())
    self.app.getFollow(id, myId, done())
    done(function (err, about, weFollowThem, theyFollowUs) {
      if (err) return cb(err)
      var relationshipI = weFollowThem | theyFollowUs<<1
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
          )),
          h('tr',
            h('td'),
            h('td',
              h('a', {href: render.toUrl('/contacts/' + id)}, 'contacts')
            )
          ),
          h('tr',
            h('td'),
            h('td',
              h('form', {action: render.toUrl('/advsearch'), method: 'get'},
                h('input', {type: 'hidden', name: 'source', value: id}),
                h('input', {type: 'text', name: 'text', placeholder: 'text'}),
                h('input', {type: 'submit', value: 'search'})
              )
            )
          ),
          isScrolled ? '' : [
            id === myId ? '' : h('tr',
              h('td'),
              h('td.follow-info', h('form', {action: '', method: 'post'},
                relationships[relationshipI], ' ',
                h('input', {type: 'hidden', name: 'action', value: 'contact'}),
                h('input', {type: 'hidden', name: 'contact', value: id}),
                h('input', {type: 'hidden', name: 'following',
                  value: weFollowThem ? '' : 'following'}),
                h('input', {type: 'submit',
                  value: relationshipActions[relationshipI]})
              ))
            )
          ]
        )),
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

Serve.prototype.wrapNew = function (opts) {
  var self = this
  return u.hyperwrap(function (thread, cb) {
    self.composer({
      channel: '',
    }, function (err, composer) {
      if (err) return cb(err)
      cb(null, [
        composer,
        h('table.ssb-msgs',
          thread,
          h('tr', h('td.paginate.msg-left', {colspan: 3},
            h('form', {method: 'get', action: ''},
              h('input', {type: 'hidden', name: 'gt', value: opts.gt}),
              h('input', {type: 'hidden', name: 'catchup', value: '1'}),
              h('input', {type: 'submit', value: 'catchup'})
            )
          ))
        )
      ])
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

Serve.prototype.wrapPeers = function (opts) {
  var self = this
  return u.hyperwrap(function (peers, cb) {
    cb(null, [
      h('section',
        h('h3', 'Peers')
      ),
      peers
    ])
  })
}

Serve.prototype.wrapChannels = function (opts) {
  var self = this
  return u.hyperwrap(function (channels, cb) {
    cb(null, [
      h('section',
        h('h3', 'Channels')
      ),
      h('section',
        channels
      )
    ])
  })
}

function rows(str) {
  return String(str).split(/[^\n]{150}|\n/).length
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
  if (data.blob_type && blobs[data.blob_link]) {
    blobs[data.blob_link].type = data.blob_type
  }
  var channel = data.channel != null ? data.channel : opts.channel

  var formNames = {}
  var mentionIds = u.toArray(data.mention_id)
  var mentionNames = u.toArray(data.mention_name)
  for (var i = 0; i < mentionIds.length && i < mentionNames.length; i++) {
    formNames[mentionNames[i]] = u.extractFeedIds(mentionIds[i])[0]
  }

  if (data.upload) {
    // TODO: be able to change the content-type
    var isImage = /^image\//.test(data.upload.type)
    data.text = (data.text ? data.text + '\n' : '')
      + (isImage ? '!' : '')
      + '[' + data.upload.name + '](' + data.upload.link + ')'
  }

  // get bare feed names
  var unknownMentionNames = {}
  var unknownMentions = ssbMentions(data.text, {bareFeedNames: true})
    .filter(function (mention) {
      return mention.link === '@'
    })
    .map(function (mention) {
      return mention.name
    })
    .filter(uniques())
    .map(function (name) {
      var id = formNames[name] || self.app.getReverseNameSync('@' + name)
      return {name: name, id: id}
    })

  // strip content other than feed ids from the recps field
  if (data.recps) {
    data.recps = u.extractFeedIds(data.recps).filter(uniques()).join(', ')
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
      channel != null ?
        h('div', '#', h('input', {name: 'channel', placeholder: 'channel',
          value: channel})) : '',
      h('textarea', {
        id: opts.id,
        name: 'text',
        rows: Math.max(4, rows(data.text)),
        cols: 70,
        placeholder: opts.placeholder || 'public message',
      }, data.text || ''),
      unknownMentions.length > 0 ? [
        h('div', h('em', 'names:')),
        h('ul.mentions', unknownMentions.map(function (mention) {
          return h('li',
            h('code', '@' + mention.name), ': ',
            h('input', {name: 'mention_name', type: 'hidden',
              value: mention.name}),
            h('input.id-input', {name: 'mention_id',
              value: mention.id, placeholder: 'id'}))
        }))
      ] : '',
      h('table.ssb-msgs',
        h('tr.msg-row',
          h('td.msg-left', {colspan: 2},
            h('input', {type: 'file', name: 'upload'})
          ),
          h('td.msg-right',
            h('input', {type: 'submit', name: 'action', value: 'raw'}), ' ',
            h('input', {type: 'submit', name: 'action', value: 'preview'})
          )
        )
      ),
      data.action === 'preview' ? preview(false, done()) :
      data.action === 'raw' ? preview(true, done()) : ''
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
      var mentions = ssbMentions(data.text, {bareFeedNames: true})
        .filter(function (mention) {
          var blob = blobs[mention.link]
          if (blob) {
            if (!isNaN(blob.size))
              mention.size = blob.size
            if (blob.type && blob.type !== 'application/octet-stream')
              mention.type = blob.type
          } else if (mention.link === '@') {
            // bare feed name
            var name = mention.name
            var id = formNames[name] || self.app.getReverseNameSync('@' + name)
            if (id) mention.link = id
            else return false
          }
          return true
        })
      if (mentions.length) content.mentions = mentions
      if (data.recps != null) {
        if (opts.recps) return cb(new Error('got recps in opts and data'))
        content.recps = [myId]
        u.extractFeedIds(data.recps).forEach(function (recp) {
          if (content.recps.indexOf(recp) === -1) content.recps.push(recp)
        })
      } else {
        if (opts.recps) content.recps = opts.recps
      }
      if (opts.root) content.root = opts.root
      if (opts.branches) content.branch = u.fromArray(opts.branches)
      if (channel) content.channel = data.channel
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
      self.app.unboxMessages(),
      self.app.render.renderFeeds(raw),
      pull.drain(function (el) {
        msgContainer.appendChild(h('tbody', el))
      }, cb)
    )
    return [
      h('input', {type: 'hidden', name: 'content',
        value: JSON.stringify(content)}),
      h('div', h('em', 'draft:')),
      msgContainer,
      h('div.composer-actions',
        h('input', {type: 'submit', name: 'action', value: 'publish'})
      )
    ]
  }

}
