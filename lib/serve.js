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
var emojis = require('emoji-named-characters')
var jpeg = require('jpeg-autorotate')
var Catch = require('pull-catch')
var Diff = require('diff')
var split = require('pull-split')
var utf8 = require('pull-utf8-decoder')
var webresolve = require('ssb-web-resolver')

module.exports = Serve

var emojiDir = path.join(require.resolve('emoji-named-characters'), '../pngs')
var hlCssDir = path.join(require.resolve('highlight.js'), '../../styles')

var urlIdRegex = /^(?:\/+(([%&@]|%25)(?:[A-Za-z0-9\/+]|%2[Ff]|%2[Bb]){43}(?:=|%3D)\.(?:sha256|ed25519))([^?]*)?|(\/.*?))(?:\?(.*))?$/

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
  var conf = self.app.config.patchfoo || {}
  var authtok = conf.auth || null
  if (authtok) {
    var auth = this.req.headers['authorization']
    var tok = null
    //console.log('Authorization: ',auth)

    if (auth) {
      var a = auth.split(' ')
      if (a[0] == 'Basic') {
        tok = Buffer.from(a[1],'base64').toString('ascii')
      }
    }
    if (tok != authtok) {
      self.res.writeHead(401, {'WWW-Authenticate': 'Basic realm="Patchfoo"'})
      self.res.end('Not authorized')
      return
    }
  }

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
      function addField(name, value) {
        if (!(name in data)) data[name] = value
        else if (Array.isArray(data[name])) data[name].push(value)
        else data[name] = [data[name], value]
      }
      busboy.on('file', function (fieldname, file, filename, encoding, mimetype) {
        var cb = filesCb()
        var size = 0
        pull(
          toPull(file),
          pull.map(function (data) {
            size += data.length
            return data
          }),
          self.app.addBlob(!!data.private, function (err, link) {
            if (err) return cb(err)
            if (size === 0 && !filename) return cb()
            link.name = filename
            link.type = mimetype
            addField(fieldname, link)
            cb()
          })
        )
      })
      busboy.on('field', function (fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
        addField(fieldname, val)
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
    else if (data.action === 'contact') self.publishContact(next)
    else if (data.action === 'want-blobs') self.wantBlobs(next)
    else if (data.action_vote) self.publishVote(next)
    else if (data.action_attend) self.publishAttend(next)
    else next()
  }

  function next(err, publishedMsg) {
    if (err) {
      self.res.writeHead(400, {'Content-Type': 'text/plain'})
      self.res.end(err.stack)
    } else if (publishedMsg) {
      if (self.data.redirect_to_published_msg) {
        self.redirect(self.app.render.toUrl(publishedMsg.key))
      } else {
        self.publishedMsg = publishedMsg
        self.handle()
      }
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

Serve.prototype.publishVote = function (next) {
  var content = {
    type: 'vote',
    channel: this.data.channel || undefined,
    vote: {
      link: this.data.link,
      value: Number(this.data.vote_value),
      expression: this.data.vote_expression || undefined,
    }
  }
  if (this.data.recps) content.recps = this.data.recps.split(',')
  if (this.app.previewVotes) {
    var json = JSON.stringify(content, 0, 2)
    var q = qs.stringify({text: json, action: 'preview'})
    var url = this.app.render.toUrl('/compose?' + q)
    this.redirect(url)
  } else {
    this.publish(content, next)
  }
}

Serve.prototype.publishContact = function (next) {
  var content = {
    type: 'contact',
    contact: this.data.contact,
  }
  if (this.data.follow) content.following = true
  if (this.data.block) content.blocking = true
  if (this.data.unfollow) content.following = false
  if (this.data.unblock) content.blocking = false
  if (this.app.previewContacts) {
    var json = JSON.stringify(content, 0, 2)
    var q = qs.stringify({text: json, action: 'preview'})
    var url = this.app.render.toUrl('/compose?' + q)
    this.redirect(url)
  } else {
    this.publish(content, next)
  }
}

Serve.prototype.publishAttend = function (cb) {
  var content = {
    type: 'about',
    channel: this.data.channel || undefined,
    about: this.data.link,
    attendee: {
      link: this.app.sbot.id
    }
  }
  if (this.data.recps) content.recps = this.data.recps.split(',')
  this.publish(content, cb)
}

Serve.prototype.wantBlobs = function (cb) {
  var self = this
  if (!self.data.blob_ids) return cb()
  var ids = self.data.blob_ids.split(',')
  if (!ids.every(u.isRef)) return cb(new Error('bad blob ids ' + ids.join(',')))
  var done = multicb({pluck: 1})
  ids.forEach(function (id) {
    self.app.wantSizeBlob(id, done())
  })
  if (self.data.async_want) return cb()
  done(function (err) {
    if (err) return cb(err)
    // self.note = h('div', 'wanted blobs: ' + ids.join(', ') + '.')
    cb()
  })
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
      return cb(null, msg)
    })
  })
}

Serve.prototype.handle = function () {
  var m = urlIdRegex.exec(this.req.url)
  this.query = m[5] ? qs.parse(m[5]) : {}
  this.useOoo = this.query.ooo != null ?
    Boolean(this.query.ooo) : this.app.useOoo
  switch (m[2]) {
    case '%25': m[2] = '%'; m[1] = decodeURIComponent(m[1])
    case '%': return this.id(m[1], m[3])
    case '@': return this.userFeed(m[1], m[3])
    case '&': return this.blob(m[1], m[3])
    default: return this.path(m[4])
  }
}

Serve.prototype.respond = function (status, message) {
  this.res.writeHead(status)
  this.res.end(message)
}

Serve.prototype.respondSink = function (status, headers, cb) {
  var self = this
  if (status || headers)
    self.res.writeHead(status, headers || {'Content-Type': 'text/html'})
  return toPull(self.res, cb || function (err) {
    if (err) self.app.error(err)
  })
}

Serve.prototype.redirect = function (dest) {
  this.res.writeHead(302, {
    Location: dest
  })
  this.res.end()
}

Serve.prototype.path = function (url) {
  var m
  url = url.replace(/^\/+/, '/')
  switch (url) {
    case '/': return this.home()
    case '/robots.txt': return this.res.end('User-agent: *')
  }
  if (m = /^\/%23(.*)/.exec(url)) {
    return this.redirect(this.app.render.toUrl('/channel/'
      + decodeURIComponent(m[1])))
  }
  m = /^([^.]*)(?:\.(.*))?$/.exec(url)
  switch (m[1]) {
    case '/new': return this.new(m[2])
    case '/public': return this.public(m[2])
    case '/private': return this.private(m[2])
    case '/mentions': return this.mentions(m[2])
    case '/search': return this.search(m[2])
    case '/advsearch': return this.advsearch(m[2])
    case '/peers': return this.peers(m[2])
    case '/status': return this.status(m[2])
    case '/channels': return this.channels(m[2])
    case '/friends': return this.friends(m[2])
    case '/live': return this.live(m[2])
    case '/compose': return this.compose(m[2])
    case '/emojis': return this.emojis(m[2])
    case '/votes': return this.votes(m[2])
  }
  m = /^(\/?[^\/]*)(\/.*)?$/.exec(url)
  switch (m[1]) {
    case '/channel': return this.channel(m[2])
    case '/type': return this.type(m[2])
    case '/links': return this.links(m[2])
    case '/static': return this.static(m[2])
    case '/emoji': return this.emoji(m[2])
    case '/highlight': return this.highlight(m[2])
    case '/contacts': return this.contacts(m[2])
    case '/about': return this.about(m[2])
    case '/git': return this.git(m[2])
    case '/image': return this.image(m[2])
    case '/npm': return this.npm(m[2])
    case '/npm-prebuilds': return this.npmPrebuilds(m[2])
    case '/npm-readme': return this.npmReadme(m[2])
    case '/markdown': return this.markdown(m[2])
    case '/zip': return this.zip(m[2])
    case '/web': return this.web(m[2])
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
    filter: q.filter,
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
      self.renderThread(),
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
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    filter: q.filter,
  }

  pull(
    this.app.streamPrivate(opts),
    this.renderThreadPaginated(opts, null, q),
    this.wrapMessages(),
    this.wrapPrivate(opts),
    this.wrapPage('private'),
    this.respondSink(200, {
      'Content-Type': ctype(ext)
    })
  )
}

Serve.prototype.mentions = function (ext) {
  var self = this
  var q = self.query
  var opts = {
    reverse: !q.forwards,
    sortByTimestamp: q.sort === 'claimed',
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    filter: q.filter,
  }

  return pull(
    ph('section', {}, [
      ph('h3', 'Mentions'),
      pull(
        self.app.streamMentions(opts),
        self.app.unboxMessages(),
        self.renderThreadPaginated(opts, null, q),
        self.wrapMessages()
      )
    ]),
    self.wrapPage('mentions'),
    self.respondSink(200)
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
    return self.redirect(self.app.render.toUrl(searchQ))
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
  var hasQuery = q.text || q.source || q.dest || q.channel

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
              ph('td', 'channel'),
              ph('td', ['#', ph('input', {name: 'channel', placeholder: 'channel',
                class: 'id-input',
                value: q.channel || ''})
              ])
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
        self.renderThread({
          feed: q.source,
        }),
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
        filter: q.filter,
      }),
      pull.map(u.toHTML)
    )),
    self.wrapPage('live'),
    self.respondSink(200, {
      'Content-Type': ctype(ext),
    })
  )
}

Serve.prototype.compose = function (ext) {
  var self = this
  self.composer({
    channel: '',
    redirectToPublishedMsg: true,
  }, function (err, composer) {
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage('compose'),
      self.respondSink(500)
    )
    pull(
      pull.once(u.toHTML(composer)),
      self.wrapPage('compose'),
      self.respondSink(200, {
        'Content-Type': ctype(ext)
      })
    )
  })
}

Serve.prototype.votes = function (path) {
  if (path) return pull(
    pull.once(u.renderError(new Error('Not implemented')).outerHTML),
    this.wrapPage('#' + channel),
    this.respondSink(404, {'Content-Type': ctype('html')})
  )

  var self = this
  var q = self.query
  var opts = {
    reverse: !q.forwards,
    limit: Number(q.limit) || 50,
  }
  var gt = Number(q.gt)
  if (gt) opts.gt = gt
  var lt = Number(q.lt)
  if (lt) opts.lt = lt

  self.app.getVoted(opts, function (err, voted) {
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage('#' + channel),
      self.respondSink(500, {'Content-Type': ctype('html')})
    )

    pull(
      ph('table', [
        ph('thead', [
          ph('tr', [
            ph('td', {colspan: 2}, self.syncPager({
              first: voted.firstTimestamp,
              last: voted.lastTimestamp,
            }))
          ])
        ]),
        ph('tbody', pull(
          pull.values(voted.items),
          paramap(function (item, cb) {
            cb(null, ph('tr', [
              ph('td', [String(item.value)]),
              ph('td', [
                self.phIdLink(item.id),
                pull.once(' dug by '),
                self.renderIdsList()(pull.values(item.feeds))
              ])
            ]))
          }, 8)
        )),
        ph('tfoot', {}, []),
      ]),
      self.wrapPage('votes'),
      self.respondSink(200, {
        'Content-Type': ctype('html')
      })
    )
  })
}

Serve.prototype.syncPager = function (opts) {
  var q = this.query
  var reverse = !q.forwards
  var min = (reverse ? opts.last : opts.first) || Number(q.gt)
  var max = (reverse ? opts.first : opts.last) || Number(q.lt)
  var minDate = new Date(min)
  var maxDate = new Date(max)
  var qOlder = u.mergeOpts(q, {lt: min, gt: undefined, forwards: undefined})
  var qNewer = u.mergeOpts(q, {gt: max, lt: undefined, forwards: 1})
  var atNewest = reverse ? !q.lt : !max
  var atOldest = reverse ? !min : !q.gt
  if (atNewest && !reverse) qOlder.lt++
  if (atOldest && reverse) qNewer.gt--
  return h('div',
    atOldest ? 'oldest' : [
      h('a', {href: '?' + qs.stringify(qOlder)}, '<<'), ' ',
      h('span', {title: minDate.toString()}, htime(minDate)), ' ',
    ],
    ' - ',
    atNewest ? 'now' : [
      h('span', {title: maxDate.toString()}, htime(maxDate)), ' ',
      h('a', {href: '?' + qs.stringify(qNewer)}, '>>')
    ]
  ).outerHTML
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

Serve.prototype.status = function (ext) {
  var self = this

  if (!self.app.sbot.status) return pull(
    pull.once('missing sbot status method'),
    this.wrapPage('status'),
    self.respondSink(400)
  )

  pull(
    ph('section', [
      ph('h3', 'Status'),
      pull(
        u.readNext(function (cb) {
          self.app.sbot.status(function (err, status) {
            cb(err, status && pull.once(status))
          })
        }),
        pull.map(function (status) {
          return h('pre', self.app.render.linkify(JSON.stringify(status, 0, 2))).outerHTML
        })
      )
    ]),
    this.wrapPage('status'),
    this.respondSink(200)
  )
}

Serve.prototype.channels = function (ext) {
  var self = this
  var id = self.app.sbot.id

  function renderMyChannels() {
    return pull(
      self.app.streamMyChannels(id),
      paramap(function (channel, cb) {
        // var subscribed = false
        cb(null, [
          h('a', {href: self.app.render.toUrl('/channel/' + channel)}, '#' + channel),
          ' '
        ])
      }, 8),
      pull.map(u.toHTML),
      self.wrapMyChannels()
    )
  }

  function renderNetworkChannels() {
    return pull(
      self.app.streamChannels(),
      paramap(function (channel, cb) {
        // var subscribed = false
        cb(null, [
          h('a', {href: self.app.render.toUrl('/channel/' + channel)}, '#' + channel),
          ' '
        ])
      }, 8),
      pull.map(u.toHTML),
      self.wrapChannels()
    )
  }

  pull(
    cat([
      ph('section', {}, [
        ph('h3', {}, 'Channels:'),
        renderMyChannels(),
        renderNetworkChannels()
      ])
    ]),
    this.wrapPage('channels'),
    this.respondSink(200, {
      'Content-Type': ctype(ext)
    })
  )
}

function renderFriendsList(app) {
}

Serve.prototype.contacts = function (path) {
  var self = this
  var id = String(path).substr(1)
  var contacts = self.app.contacts.createContactStreams(id)
  var render = self.app.render

  pull(
    cat([
      ph('section', {}, [
        ph('h3', {}, ['Contacts: ', self.phIdLink(id)]),
        ph('h4', {}, 'Friends'),
        render.friendsList('/contacts/')(contacts.friends),
        ph('h4', {}, 'Follows'),
        render.friendsList('/contacts/')(contacts.follows),
        ph('h4', {}, 'Followers'),
        render.friendsList('/contacts/')(contacts.followers),
        ph('h4', {}, 'Blocks'),
        render.friendsList('/contacts/')(contacts.blocks),
        ph('h4', {}, 'Blocked by'),
        render.friendsList('/contacts/')(contacts.blockers)
      ])
    ]),
    this.wrapPage('contacts: ' + id),
    this.respondSink(200, {
      'Content-Type': ctype('html')
    })
  )
}

Serve.prototype.about = function (path) {
  var self = this
  var id = decodeURIComponent(String(path).substr(1))
  var abouts = self.app.createAboutStreams(id)
  var render = self.app.render

  function renderAboutOpImage(link) {
    if (!link) return
    if (!u.isRef(link.link)) return ph('code', {}, JSON.stringify(link))
    return ph('img', {
      class: 'ssb-avatar-image',
      src: render.imageUrl(link.link),
      alt: link.link
        + (link.size ? ' (' + render.formatSize(link.size) + ')' : '')
    })
  }

  function renderAboutOpValue(value) {
    if (!value) return
    if (u.isRef(value.link)) return self.phIdLink(value.link)
    if (value.epoch) return new Date(value.epoch).toUTCString()
    return ph('code', {}, JSON.stringify(value))
  }

  function renderAboutOpContent(op) {
    if (op.prop === 'image')
      return renderAboutOpImage(u.toLink(op.value))
    if (op.prop === 'description')
      return h('div', {innerHTML: render.markdown(op.value)}).outerHTML
    if (op.prop === 'title')
      return h('strong', op.value).outerHTML
    if (op.prop === 'name')
      return h('u', op.value).outerHTML
    return renderAboutOpValue(op.value)
  }

  function renderAboutOp(op) {
    return ph('tr', {}, [
      ph('td', self.phIdLink(op.author)),
      ph('td',
        ph('a', {href: render.toUrl(op.id)},
          htime(new Date(op.timestamp)))),
      ph('td', op.prop),
      ph('td', renderAboutOpContent(op))
    ])
  }

  pull(
    cat([
      ph('section', {}, [
        ph('h3', {}, ['About: ', self.phIdLink(id)]),
        ph('table', {},
          pull(abouts.scalars, pull.map(renderAboutOp))
        ),
        pull(
          abouts.sets,
          pull.map(function (op) {
            return h('pre', JSON.stringify(op, 0, 2))
          }),
          pull.map(u.toHTML)
        )
      ])
    ]),
    this.wrapPage('about: ' + id),
    this.respondSink(200, {
      'Content-Type': ctype('html')
    })
  )
}

Serve.prototype.type = function (path) {
  var q = this.query
  var type = decodeURIComponent(path.substr(1))
  var opts = {
    reverse: !q.forwards,
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    type: type,
    filter: q.filter,
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
    this.renderThread(),
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

  self.getMsgDecryptedMaybeOoo(id, function (err, msg) {
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

Serve.prototype.channel = function (path) {
  var channel = decodeURIComponent(String(path).substr(1))
  var q = this.query
  var gt = Number(q.gt) || -Infinity
  var lt = Number(q.lt) || Date.now()
  var opts = {
    reverse: !q.forwards,
    lt: lt,
    gt: gt,
    channel: channel,
    filter: q.filter,
  }

  pull(
    this.app.streamChannel(opts),
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

Serve.prototype.streamThreadWithComposer = function (opts) {
  var self = this
  var id = opts.root
  return ph('table', {class: 'ssb-msgs'}, u.readNext(next))
  function next(cb) {
    self.getMsgDecryptedMaybeOoo(id, function (err, rootMsg) {
      if (err && err.name === 'NotFoundError') err = null, rootMsg = {
        key: id, value: {content: false}}
      if (err) return cb(new Error(err.stack))
      if (!rootMsg) {
        console.log('id', id, 'opts', opts)
      }
      var rootContent = rootMsg && rootMsg.value && rootMsg.value.content
      var recps = rootContent && rootContent.recps
        || (rootMsg.value.private
          ? [rootMsg.value.author, self.app.sbot.id].filter(uniques())
          : undefined)
      var threadRootId = rootContent && rootContent.root || id
      var channel = opts.channel

      pull(
        cat([pull.once(rootMsg), self.app.sbot.links({dest: id, values: true})]),
        pull.unique('key'),
        self.app.unboxMessages(),
        pull.through(function (msg) {
          var c = msg && msg.value.content
          if (!channel && c.channel) channel = c.channel
        }),
        pull.collect(function (err, links) {
          if (err) return gotLinks(err)
          if (!self.useOoo) return gotLinks(null, links)
          self.app.expandOoo({msgs: links, dest: id}, gotLinks)
        })
      )
      function gotLinks(err, links) {
        if (err) return cb(new Error(err.stack))
        cb(null, pull(
          pull.values(sort(links)),
          self.renderThread({
            msgId: id,
          }),
          self.wrapMessages(),
          self.wrapThread({
            recps: recps,
            root: threadRootId,
            post: id,
            branches: threadHeads(links, threadRootId),
            postBranches: threadRootId !== id && threadHeads(links, id),
            placeholder: opts.placeholder,
            channel: channel,
          })
        ))
      }
    })
  }
}

Serve.prototype.id = function (id, path) {
  var self = this
  if (self.query.raw != null) return self.rawId(id)
  pull(
    self.streamThreadWithComposer({root: id}),
    self.wrapPage(id),
    self.respondSink(200)
  )
}

Serve.prototype.userFeed = function (id, path) {
  var self = this
  var q = self.query
  var opts = {
    id: id,
    reverse: !q.forwards,
    lt: Number(q.lt) || Date.now(),
    gt: Number(q.gt) || -Infinity,
    feed: id,
    filter: q.filter,
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
      self.respondSink(200)
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

Serve.prototype.highlight = function (dirs) {
  this.file(path.join(hlCssDir, dirs))
}

Serve.prototype.blob = function (id, path) {
  var self = this
  var unbox = typeof this.query.unbox === 'string' && this.query.unbox.replace(/\s/g, '+')
  var etag = id + (path || '') + (unbox || '')
  if (self.req.headers['if-none-match'] === etag) return self.respond(304)
  var key
  if (path) {
    try { path = decodeURIComponent(path) } catch(e) {}
    if (path[0] === '#') {
      unbox = path.substr(1)
    } else {
      return self.respond(400, 'Bad blob request')
    }
  }
  if (unbox) {
    try {
      key = new Buffer(unbox, 'base64')
    } catch(err) {
      return self.respond(400, err.message)
    }
    if (key.length !== 32) {
      return self.respond(400, 'Bad blob key')
    }
  }
  self.app.wantSizeBlob(id, function (err, size) {
    if (err) {
      if (/^invalid/.test(err.message)) return self.respond(400, err.message)
      else return self.respond(500, err.message || err)
    }
    pull(
      self.app.getBlob(id, key),
      pull.map(Buffer),
      ident(gotType),
      self.respondSink()
    )
    function gotType(type) {
      type = type && mime.lookup(type)
      if (type) self.res.setHeader('Content-Type', type)
      // don't serve size for encrypted blob, because it refers to the size of
      // the ciphertext
      if (typeof size === 'number' && !key)
        self.res.setHeader('Content-Length', size)
      if (self.query.name) self.res.setHeader('Content-Disposition',
        'inline; filename='+encodeDispositionFilename(self.query.name))
      self.res.setHeader('Cache-Control', 'public, max-age=315360000')
      self.res.setHeader('etag', etag)
      self.res.writeHead(200)
    }
  })
}

Serve.prototype.image = function (path) {
  var self = this
  var id, key
  var m = urlIdRegex.exec(path)
  if (m && m[2] === '&') id = m[1], path = m[3]
  var unbox = typeof this.query.unbox === 'string' && this.query.unbox.replace(/\s/g, '+')
  var etag = 'image-' + id + (path || '') + (unbox || '')
  if (self.req.headers['if-none-match'] === etag) return self.respond(304)
  if (path) {
    try { path = decodeURIComponent(path) } catch(e) {}
    if (path[0] === '#') {
      unbox = path.substr(1)
    } else {
      return self.respond(400, 'Bad blob request')
    }
  }
  if (unbox) {
    try {
      key = new Buffer(unbox, 'base64')
    } catch(err) {
      return self.respond(400, err.message)
    }
    if (key.length !== 32) {
      return self.respond(400, 'Bad blob key')
    }
  }
  self.app.wantSizeBlob(id, function (err, size) {
    if (err) {
      if (/^invalid/.test(err.message)) return self.respond(400, err.message)
      else return self.respond(500, err.message || err)
    }

    var done = multicb({pluck: 1, spread: true})
    var heresTheData = done()
    var heresTheType = done().bind(self, null)

    pull(
      self.app.getBlob(id, key),
      pull.map(Buffer),
      ident(heresTheType),
      pull.collect(onFullBuffer)
    )

    function onFullBuffer (err, buffer) {
      if (err) return heresTheData(err)
      buffer = Buffer.concat(buffer)

      try {
        jpeg.rotate(buffer, {}, function (err, rotatedBuffer, orientation) {
          if (!err) buffer = rotatedBuffer

          heresTheData(null, buffer)
          pull(
            pull.once(buffer),
            self.respondSink()
          )
        })
      } catch (err) {
        console.trace(err)
        self.respond(500, err.message || err)
      }
    }

    done(function (err, data, type) {
      if (err) {
        console.trace(err)
        self.respond(500, err.message || err)
      }
      type = type && mime.lookup(type)
      if (type) self.res.setHeader('Content-Type', type)
      self.res.setHeader('Content-Length', data.length)
      if (self.query.name) self.res.setHeader('Content-Disposition',
        'inline; filename='+encodeDispositionFilename(self.query.name))
      self.res.setHeader('Cache-Control', 'public, max-age=315360000')
      self.res.setHeader('etag', etag)
      self.res.writeHead(200)
    })
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

Serve.prototype.renderThread = function (opts) {
  return pull(
    this.app.render.renderFeeds({
      raw: false,
      full: this.query.full != null,
      feed: opts && opts.feed,
      msgId: opts && opts.msgId,
      filter: this.query.filter,
      limit: Number(this.query.limit),
      serve: this,
    }),
    pull.map(u.toHTML)
  )
}

Serve.prototype.renderThreadPaginated = function (opts, feedId, q) {
  var self = this
  function linkA(opts, name) {
    var q1 = u.mergeOpts(q, opts)
    return h('a', {href: '?' + qs.stringify(q1)}, name || q1.limit)
  }
  function links(opts) {
    var limit = opts.limit || q.limit || 10
    return h('tr', h('td.paginate', {colspan: 3},
      opts.forwards ? '↑ newer ' : '↓ older ',
      linkA(u.mergeOpts(opts, {limit: 1})), ' ',
      linkA(u.mergeOpts(opts, {limit: 10})), ' ',
      linkA(u.mergeOpts(opts, {limit: 100}))
    ))
  }

  return pull(
    paginate(
      function onFirst(msg, cb) {
        var num = feedId ? msg.value.sequence :
          opts.sortByTimestamp ? msg.value.timestamp :
          msg.timestamp || msg.ts
        if (q.forwards) {
          cb(null, links({
            lt: num,
            gt: null,
            forwards: null,
            filter: opts.filter,
          }))
        } else {
          cb(null, links({
            lt: null,
            gt: num,
            forwards: 1,
            filter: opts.filter,
          }))
        }
      },
      this.app.render.renderFeeds({
        raw: false,
        full: this.query.full != null,
        feed: opts && opts.feed,
        msgId: opts && opts.msgId,
        filter: this.query.filter,
        limit: Number(this.query.limit) || 12,
      }),
      function onLast(msg, cb) {
        var num = feedId ? msg.value.sequence :
          opts.sortByTimestamp ? msg.value.timestamp :
          msg.timestamp || msg.ts
        if (q.forwards) {
          cb(null, links({
            lt: null,
            gt: num,
            forwards: 1,
            filter: opts.filter,
          }))
        } else {
          cb(null, links({
            lt: num,
            gt: null,
            forwards: null,
            filter: opts.filter,
          }))
        }
      },
      function onEmpty(cb) {
        if (q.forwards) {
          cb(null, links({
            gt: null,
            lt: opts.gt + 1,
            forwards: null,
            filter: opts.filter,
          }))
        } else {
          cb(null, links({
            gt: opts.lt - 1,
            lt: null,
            forwards: 1,
            filter: opts.filter,
          }))
        }
      }
    ),
    pull.map(u.toHTML)
  )
}

Serve.prototype.renderRawMsgPage = function (id) {
  var showMarkdownSource = (this.query.raw === 'md')
  var raw = !showMarkdownSource
  return pull(
    this.app.render.renderFeeds({
      raw: raw,
      msgId: id,
      filter: this.query.filter,
      markdownSource: showMarkdownSource
    }),
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

function catchTextError() {
  return function (read) {
    var ended
    return function (abort, cb) {
      if (ended) return cb(ended)
      read(abort, function (end, data) {
        if (!end || end === true) return cb(end, data)
        ended = true
        cb(null, end.stack + '\n')
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
        h('link', {rel: 'icon', href: render.toUrl('/static/hermie.ico'), type: 'image/x-icon'}),
        h('style', styles()),
        h('link', {rel: 'stylesheet', href: render.toUrl('/highlight/foundation.css')})
      ),
      h('body',
        h('nav.nav-bar', h('form', {action: render.toUrl('/search'), method: 'get'},
          h('a', {href: render.toUrl('/new')}, 'new') , ' ',
          h('a', {href: render.toUrl('/public')}, 'public'), ' ',
          h('a', {href: render.toUrl('/private')}, 'private') , ' ',
          h('a', {href: render.toUrl('/mentions')}, 'mentions') , ' ',
          h('a', {href: render.toUrl('/peers')}, 'peers') , ' ',
          self.app.sbot.status ?
            [h('a', {href: render.toUrl('/status')}, 'status'), ' '] : '',
          h('a', {href: render.toUrl('/channels')}, 'channels') , ' ',
          h('a', {href: render.toUrl('/friends')}, 'friends'), ' ',
          h('a', {href: render.toUrl('/advsearch')}, 'search'), ' ',
          h('a', {href: render.toUrl('/live')}, 'live'), ' ',
          h('a', {href: render.toUrl('/compose')}, 'compose'), ' ',
          h('a', {href: render.toUrl('/votes')}, 'votes'), ' ',
          h('a', {href: render.toUrl('/emojis')}, 'emojis'), ' ',
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
        // self.note,
        content
      )))
      done(cb)
    })
  )
}

Serve.prototype.phIdLink = function (id) {
  return pull(
    pull.once(id),
    this.renderIdsList()
  )
}

Serve.prototype.phIdAvatar = function (id) {
  var self = this
  return u.readNext(function (cb) {
    var el = self.app.render.avatarImage(id, function (err) {
      if (err) return cb(err)
      cb(null, pull.once(u.toHTML(el)))
    })
  })
}

Serve.prototype.friends = function (path) {
  var self = this
  pull(
    self.app.sbot.friends.createFriendStream({hops: 1}),
    self.renderIdsList(),
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

Serve.prototype.renderIdsList = function () {
  var self = this
  return pull(
    paramap(function (id, cb) {
      self.app.render.getNameLink(id, cb)
    }, 8),
    pull.map(function (el) {
      return [el, ' ']
    }),
    pull.map(u.toHTML)
  )
}

Serve.prototype.aboutDescription = function (id) {
  var self = this
  return u.readNext(function (cb) {
    self.app.getAbout(id, function (err, about) {
      if (err) return cb(err)
      if (!about.description) return cb(null, pull.empty())
      cb(null, ph('div', self.app.render.markdown(about.description)))
    })
  })
}

Serve.prototype.followInfo = function (id, myId) {
  var self = this
  return u.readNext(function (cb) {
    var done = multicb({pluck: 1, spread: true})
    self.app.getContact(myId, id, done())
    self.app.getContact(id, myId, done())
    done(function (err, contactToThem, contactFromThem) {
      if (err) return cb(err)
      cb(null, ph('form', {action: '', method: 'post'}, [
        contactFromThem ? contactToThem ? 'friend ' : 'follows you ' :
        contactFromThem === false ? 'blocks you ' : '',
        ph('input', {type: 'hidden', name: 'action', value: 'contact'}),
        ph('input', {type: 'hidden', name: 'contact', value: id}),
        ph('input', {type: 'submit',
          name: contactToThem ? 'unfollow' : 'follow',
          value: contactToThem ? 'unfollow' : 'follow'}), ' ',
        ph('input', {type: 'submit',
          name: contactToThem === false ? 'unblock' : 'block',
          value: contactToThem === false ? 'unblock' : 'block'})
      ]))
    })
  })
}

Serve.prototype.friendInfo = function (id, myId) {
  var first = false
  return pull(
    this.app.contacts.createFollowedFollowersStream(myId, id),
    this.app.render.friendsList(),
    pull.map(function (html) {
      if (!first) {
        first = true
        return 'followed by your friends: ' + html
      }
      return html
    })
  )
}

Serve.prototype.wrapUserFeed = function (isScrolled, id) {
  var self = this
  var myId = self.app.sbot.id
  var render = self.app.render
  return function (thread) {
    return cat([
      ph('section', {class: 'ssb-feed'}, ph('table', [
        isScrolled ? '' : ph('tr', [
          ph('td', self.phIdAvatar(id)),
          ph('td', {class: 'feed-about'}, [
            ph('h3', {class: 'feed-name'},
              ph('strong', self.phIdLink(id))),
            ph('code', ph('small', id)),
            self.aboutDescription(id)
          ])
        ]),
        isScrolled ? '' : ph('tr', [
          ph('td'),
          ph('td', pull(
            self.app.getAddresses(id),
            pull.map(function (address) {
              return ph('div', [
                ph('code', address)
              ])
            })
          ))
        ]),
        ph('tr', [
          ph('td'),
          ph('td', [
            ph('a', {href: render.toUrl('/contacts/' + id)}, 'contacts'), ' ',
            ph('a', {href: render.toUrl('/about/' + id)}, 'about')
          ])
        ]),
        ph('tr', [
          ph('td'),
          ph('td',
            ph('form', {action: render.toUrl('/advsearch'), method: 'get'}, [
              ph('input', {type: 'hidden', name: 'source', value: id}),
              ph('input', {type: 'text', name: 'text', placeholder: 'text'}),
              ph('input', {type: 'submit', value: 'search'})
            ])
          )
        ]),
        isScrolled || id === myId ? '' : [
          ph('tr', [
            ph('td'),
            ph('td', {class: 'follow-info'}, self.followInfo(id, myId))
          ]),
          ph('tr', [
            ph('td'),
            ph('td', self.friendInfo(id, myId))
          ])
        ]
      ])),
      thread
    ])
  }
}

Serve.prototype.git = function (url) {
  var m = /^\/?([^\/]*)\/?(.*)?$/.exec(url)
  switch (m[1]) {
    case 'commit': return this.gitCommit(m[2])
    case 'tag': return this.gitTag(m[2])
    case 'tree': return this.gitTree(m[2])
    case 'blob': return this.gitBlob(m[2])
    case 'raw': return this.gitRaw(m[2])
    case 'diff': return this.gitDiff(m[2])
    case 'line-comment': return this.gitLineComment(m[2])
    default: return this.respond(404, 'Not found')
  }
}

Serve.prototype.gitRaw = function (rev) {
  var self = this
  if (!/[0-9a-f]{24}/.test(rev)) {
    return pull(
      pull.once('\'' + rev + '\' is not a git object id'),
      self.respondSink(400, {'Content-Type': 'text/plain'})
    )
  }
  if (!u.isRef(self.query.msg)) return pull(
    ph('div.error', 'missing message id'),
    self.wrapPage('git tree ' + rev),
    self.respondSink(400)
  )

  self.app.git.openObject({
    obj: rev,
    msg: self.query.msg,
  }, function (err, obj) {
    if (err && err.name === 'BlobNotFoundError')
      return self.askWantBlobs(err.links)
    if (err) return pull(
      pull.once(err.stack),
      self.respondSink(400, {'Content-Type': 'text/plain'})
    )
    pull(
      self.app.git.readObject(obj),
      catchTextError(),
      ident(function (type) {
        type = type && mime.lookup(type)
        if (type) self.res.setHeader('Content-Type', type)
        self.res.setHeader('Cache-Control', 'public, max-age=315360000')
        self.res.setHeader('etag', rev)
        self.res.writeHead(200)
      }),
      self.respondSink()
    )
  })
}

Serve.prototype.gitAuthorLink = function (author) {
  if (author.feed) {
    var myName = this.app.getNameSync(author.feed)
    var sigil = author.name === author.localpart ? '@' : ''
    return ph('a', {
      href: this.app.render.toUrl(author.feed),
      title: author.localpart + (myName ? ' (' + myName + ')' : '')
    }, u.escapeHTML(sigil + author.name))
  } else {
    return ph('a', {href: this.app.render.toUrl('mailto:' + author.email)},
      u.escapeHTML(author.name))
  }
}

Serve.prototype.gitCommit = function (rev) {
  var self = this
  if (!/[0-9a-f]{24}/.test(rev)) {
    return pull(
      ph('div.error', 'rev is not a git object id'),
      self.wrapPage('git'),
      self.respondSink(400)
    )
  }
  if (!u.isRef(self.query.msg)) return pull(
    ph('div.error', 'missing message id'),
    self.wrapPage('git commit ' + rev),
    self.respondSink(400)
  )

  if (self.query.search) {
    return self.app.git.getObjectMsg({
      obj: rev,
      headMsgId: self.query.msg,
    }, function (err, msg) {
      if (err && err.name === 'BlobNotFoundError')
        return self.askWantBlobs(err.links)
      if (err) return pull(
        pull.once(u.renderError(err).outerHTML),
        self.wrapPage('git commit ' + rev),
        self.respondSink(400)
      )
      var path = '/git/commit/' + rev
        + '?msg=' + encodeURIComponent(msg.key)
      return self.redirect(self.app.render.toUrl(path))
    })
  }

  self.app.git.openObject({
    obj: rev,
    msg: self.query.msg,
  }, function (err, obj) {
    if (err && err.name === 'BlobNotFoundError')
      return self.askWantBlobs(err.links)
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage('git commit ' + rev),
      self.respondSink(400)
    )
    var msgDate = new Date(obj.msg.value.timestamp)
    self.app.git.getCommit(obj, function (err, commit) {
      var missingBlobs
      if (err && err.name === 'BlobNotFoundError')
        missingBlobs = err.links, err = null
      if (err) return pull(
        pull.once(u.renderError(err).outerHTML),
        self.wrapPage('git commit ' + rev),
        self.respondSink(400)
      )
      pull(
        ph('section', [
          ph('h3', ph('a', {href: ''}, rev)),
          ph('div', [
            self.phIdLink(obj.msg.value.author), ' pushed ',
            ph('a', {
              href: self.app.render.toUrl(obj.msg.key),
              title: msgDate.toLocaleString(),
            }, htime(msgDate))
          ]),
          missingBlobs ? self.askWantBlobsForm(missingBlobs) : [
            ph('div', [
              self.gitAuthorLink(commit.committer),
              ' committed ',
              ph('span', {title: commit.committer.date.toLocaleString()},
                htime(commit.committer.date)),
              ' in ', commit.committer.tz
            ]),
            commit.author ? ph('div', [
              self.gitAuthorLink(commit.author),
              ' authored ',
              ph('span', {title: commit.author.date.toLocaleString()},
                htime(commit.author.date)),
              ' in ', commit.author.tz
            ]) : '',
            commit.parents.length ? ph('div', ['parents: ', pull(
              pull.values(commit.parents),
              self.gitObjectLinks(obj.msg.key, 'commit')
            )]) : '',
            commit.tree ? ph('div', ['tree: ', pull(
              pull.once(commit.tree),
              self.gitObjectLinks(obj.msg.key, 'tree')
            )]) : '',
            h('blockquote',
               self.app.render.gitCommitBody(commit.body)).outerHTML,
            ph('h4', 'files'),
            ph('table', pull(
              self.app.git.readCommitChanges(commit),
              pull.map(function (file) {
                var msg = file.msg || obj.msg
                return ph('tr', [
                  ph('td', ph('code', u.escapeHTML(file.name))),
                  ph('td', file.deleted ? 'deleted'
                         : file.created ?
                    ph('a', {href:
                      self.app.render.toUrl('/git/blob/'
                        + (file.hash[1] || file.hash[0])
                        + '?msg=' + encodeURIComponent(msg.key))
                        + '&commit=' + rev
                        + '&path=' + encodeURIComponent(file.name)
                    }, 'created')
                         : file.hash ?
                    ph('a', {href:
                      self.app.render.toUrl('/git/diff/'
                        + file.hash[0] + '..' + file.hash[1]
                        + '?msg=' + encodeURIComponent(msg.key))
                        + '&commit=' + rev
                        + '&path=' + encodeURIComponent(file.name)
                    }, 'changed')
                         : file.mode ? 'mode changed'
                         : JSON.stringify(file))
                ])
              }),
              Catch(function (err) {
                if (err && err.name === 'ObjectNotFoundError') return
                if (err && err.name === 'BlobNotFoundError') return self.askWantBlobsForm(err.links)
                  return false
              })
            ))
          ]
        ]),
        self.wrapPage('git commit ' + rev),
        self.respondSink(missingBlobs ? 409 : 200)
      )
    })
  })
}

Serve.prototype.gitTag = function (rev) {
  var self = this
  if (!/[0-9a-f]{24}/.test(rev)) {
    return pull(
      ph('div.error', 'rev is not a git object id'),
      self.wrapPage('git'),
      self.respondSink(400)
    )
  }
  if (!u.isRef(self.query.msg)) return pull(
    ph('div.error', 'missing message id'),
    self.wrapPage('git tag ' + rev),
    self.respondSink(400)
  )

  self.app.git.openObject({
    obj: rev,
    msg: self.query.msg,
  }, function (err, obj) {
    if (err && err.name === 'BlobNotFoundError')
      return self.askWantBlobs(err.links)
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage('git tag ' + rev),
      self.respondSink(400)
    )
    var msgDate = new Date(obj.msg.value.timestamp)
    self.app.git.getTag(obj, function (err, tag) {
      var missingBlobs
      if (err && err.name === 'BlobNotFoundError')
        missingBlobs = err.links, err = null
      if (err) return pull(
        pull.once(u.renderError(err).outerHTML),
        self.wrapPage('git tag ' + rev),
        self.respondSink(400)
      )
      pull(
        ph('section', [
          ph('h3', ph('a', {href: ''}, rev)),
          ph('div', [
            self.phIdLink(obj.msg.value.author), ' pushed ',
            ph('a', {
              href: self.app.render.toUrl(obj.msg.key),
              title: msgDate.toLocaleString(),
            }, htime(msgDate))
          ]),
          missingBlobs ? self.askWantBlobsForm(missingBlobs) : [
            ph('div', [
              self.gitAuthorLink(tag.tagger),
              ' tagged ',
              ph('span', {title: tag.tagger.date.toLocaleString()},
                htime(tag.tagger.date)),
              ' in ', tag.tagger.tz
            ]),
            tag.type, ' ',
            pull(
              pull.once(tag.object),
              self.gitObjectLinks(obj.msg.key, tag.type)
            ), ' ',
            ph('code', u.escapeHTML(tag.tag)),
            h('pre', self.app.render.linkify(tag.body)).outerHTML,
          ]
        ]),
        self.wrapPage('git tag ' + rev),
        self.respondSink(missingBlobs ? 409 : 200)
      )
    })
  })
}

Serve.prototype.gitTree = function (rev) {
  var self = this
  if (!/[0-9a-f]{24}/.test(rev)) {
    return pull(
      ph('div.error', 'rev is not a git object id'),
      self.wrapPage('git'),
      self.respondSink(400)
    )
  }
  if (!u.isRef(self.query.msg)) return pull(
    ph('div.error', 'missing message id'),
    self.wrapPage('git tree ' + rev),
    self.respondSink(400)
  )

  self.app.git.openObject({
    obj: rev,
    msg: self.query.msg,
  }, function (err, obj) {
    var missingBlobs
    if (err && err.name === 'BlobNotFoundError')
      missingBlobs = err.links, err = null
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage('git tree ' + rev),
      self.respondSink(400)
    )
    var msgDate = new Date(obj.msg.value.timestamp)
    pull(
      ph('section', [
        ph('h3', ph('a', {href: ''}, rev)),
        ph('div', [
          self.phIdLink(obj.msg.value.author), ' ',
          ph('a', {
            href: self.app.render.toUrl(obj.msg.key),
            title: msgDate.toLocaleString(),
          }, htime(msgDate))
        ]),
        missingBlobs ? self.askWantBlobsForm(missingBlobs) : ph('table', [
          pull(
            self.app.git.readTreeFull(obj),
            pull.map(function (item) {
              if (!item.msg) return ph('tr', [
                ph('td',
                  u.escapeHTML(item.name) + (item.type === 'tree' ? '/' : '')),
                ph('td', u.escapeHTML(item.hash)),
                ph('td', 'missing')
              ])
              var ext = item.name.replace(/.*\./, '')
              var path = '/git/' + item.type + '/' + item.hash
                + '?msg=' + encodeURIComponent(item.msg.key)
                + (ext ? '&ext=' + ext : '')
              var fileDate = new Date(item.msg.value.timestamp)
              return ph('tr', [
                ph('td',
                  ph('a', {href: self.app.render.toUrl(path)},
                    u.escapeHTML(item.name) + (item.type === 'tree' ? '/' : ''))),
                ph('td',
                  self.phIdLink(item.msg.value.author)),
                ph('td',
                  ph('a', {
                    href: self.app.render.toUrl(item.msg.key),
                    title: fileDate.toLocaleString(),
                  }, htime(fileDate))
                ),
              ])
            }),
            Catch(function (err) {
              if (err && err.name === 'ObjectNotFoundError') return
              if (err && err.name === 'BlobNotFoundError') return self.askWantBlobsForm(err.links)
              return false
            })
          )
        ]),
      ]),
      self.wrapPage('git tree ' + rev),
      self.respondSink(missingBlobs ? 409 : 200)
    )
  })
}

Serve.prototype.gitBlob = function (rev) {
  var self = this
  if (!/[0-9a-f]{24}/.test(rev)) {
    return pull(
      ph('div.error', 'rev is not a git object id'),
      self.wrapPage('git'),
      self.respondSink(400)
    )
  }
  if (!u.isRef(self.query.msg)) return pull(
    ph('div.error', 'missing message id'),
    self.wrapPage('git object ' + rev),
    self.respondSink(400)
  )

  self.getMsgDecryptedMaybeOoo(self.query.msg, function (err, msg) {
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage('git object ' + rev),
      self.respondSink(400)
    )
    var msgDate = new Date(msg.value.timestamp)
    self.app.git.openObject({
      obj: rev,
      msg: msg.key,
    }, function (err, obj) {
      var missingBlobs
      if (err && err.name === 'BlobNotFoundError')
        missingBlobs = err.links, err = null
      if (err) return pull(
        pull.once(u.renderError(err).outerHTML),
        self.wrapPage('git object ' + rev),
        self.respondSink(400)
      )
      pull(
        ph('section', [
          ph('h3', ph('a', {href: ''}, rev)),
          ph('div', [
            self.phIdLink(msg.value.author), ' ',
            ph('a', {
              href: self.app.render.toUrl(msg.key),
              title: msgDate.toLocaleString(),
            }, htime(msgDate))
          ]),
          missingBlobs ? self.askWantBlobsForm(missingBlobs) : pull(
            self.app.git.readObject(obj),
            self.wrapBinary({
              obj: obj,
              rawUrl: self.app.render.toUrl('/git/raw/' + rev
                + '?msg=' + encodeURIComponent(msg.key)),
              ext: self.query.ext
            })
          ),
        ]),
        self.wrapPage('git blob ' + rev),
        self.respondSink(200)
      )
    })
  })
}

Serve.prototype.gitDiff = function (revs) {
  var self = this
  var parts = revs.split('..')
  if (parts.length !== 2) return pull(
    ph('div.error', 'revs should be <rev1>..<rev2>'),
    self.wrapPage('git diff'),
    self.respondSink(400)
  )
  var rev1 = parts[0]
  var rev2 = parts[1]
  if (!/[0-9a-f]{24}/.test(rev1)) return pull(
    ph('div.error', 'rev 1 is not a git object id'),
    self.wrapPage('git diff'),
    self.respondSink(400)
  )
  if (!/[0-9a-f]{24}/.test(rev2)) return pull(
    ph('div.error', 'rev 2 is not a git object id'),
    self.wrapPage('git diff'),
    self.respondSink(400)
  )

  if (!u.isRef(self.query.msg)) return pull(
    ph('div.error', 'missing message id'),
    self.wrapPage('git diff'),
    self.respondSink(400)
  )

  var done = multicb({pluck: 1, spread: true})
  // the msg qs param should point to the message for rev2 object. the msg for
  // rev1 object we will have to look up.
  self.app.git.getObjectMsg({
    obj: rev1,
    headMsgId: self.query.msg,
    type: 'blob',
  }, done())
  self.getMsgDecryptedMaybeOoo(self.query.msg, done())
  done(function (err, msg1, msg2) {
    if (err && err.name === 'BlobNotFoundError')
      return self.askWantBlobs(err.links)
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.wrapPage('git diff ' + revs),
      self.respondSink(400)
    )
    var msg1Date = new Date(msg1.value.timestamp)
    var msg2Date = new Date(msg2.value.timestamp)
    var revsShort = rev1.substr(0, 8) + '..' + rev2.substr(0, 8)
    pull(
      ph('section', [
        ph('h3', ph('a', {href: ''}, revsShort)),
        ph('div', [
          ph('a', {
            href: self.app.render.toUrl('/git/blob/' + rev1 + '?msg=' + encodeURIComponent(msg1.key))
          }, rev1), ' ',
          self.phIdLink(msg1.value.author), ' ',
          ph('a', {
            href: self.app.render.toUrl(msg1.key),
            title: msg1Date.toLocaleString(),
          }, htime(msg1Date))
        ]),
        ph('div', [
          ph('a', {
            href: self.app.render.toUrl('/git/blob/' + rev2 + '?msg=' + encodeURIComponent(msg2.key))
          }, rev2), ' ',
          self.phIdLink(msg2.value.author), ' ',
          ph('a', {
            href: self.app.render.toUrl(msg2.key),
            title: msg2Date.toLocaleString(),
          }, htime(msg2Date))
        ]),
        u.readNext(function (cb) {
          var done = multicb({pluck: 1, spread: true})
          self.app.git.openObject({
            obj: rev1,
            msg: msg1.key,
          }, done())
          self.app.git.openObject({
            obj: rev2,
            msg: msg2.key,
          }, done())
          /*
          self.app.git.guessCommitAndPath({
            obj: rev2,
            msg: msg2.key,
          }, done())
          */
          done(function (err, obj1, obj2/*, info2*/) {
            if (err && err.name === 'BlobNotFoundError')
              return cb(null, self.askWantBlobsForm(err.links))
            if (err) return cb(err)

            var done = multicb({pluck: 1, spread: true})
            pull.collect(done())(self.app.git.readObject(obj1))
            pull.collect(done())(self.app.git.readObject(obj2))
            self.app.getLineComments({obj: obj2, hash: rev2}, done())
            done(function (err, bufs1, bufs2, lineComments) {
              if (err) return cb(err)
              var str1 = Buffer.concat(bufs1, obj1.length).toString('utf8')
              var str2 = Buffer.concat(bufs2, obj2.length).toString('utf8')
              var diff = Diff.structuredPatch('', '', str1, str2)
              cb(null, self.gitDiffTable(diff, lineComments, {
                obj: obj2,
                hash: rev2,
                commit: self.query.commit, // info2.commit,
                path: self.query.path, // info2.path,
              }))
            })
          })
        })
      ]),
      self.wrapPage('git diff'),
      self.respondSink(200)
    )
  })
}

Serve.prototype.gitDiffTable = function (diff, lineComments, lineCommentInfo) {
  var updateMsg = lineCommentInfo.obj.msg
  var self = this
  return pull(
    ph('table', [
      pull(
        pull.values(diff.hunks),
        pull.map(function (hunk) {
          var oldLine = hunk.oldStart
          var newLine = hunk.newStart
          return [
            ph('tr', [
              ph('td', {colspan: 3}),
              ph('td', ph('pre',
                '@@ -' + oldLine + ',' + hunk.oldLines + ' ' +
                '+' + newLine + ',' + hunk.newLines + ' @@'))
            ]),
            pull(
              pull.values(hunk.lines),
              pull.map(function (line) {
                var s = line[0]
                if (s == '\\') return
                var html = self.app.render.highlight(line)
                var lineNums = [s == '+' ? '' : oldLine++, s == '-' ? '' : newLine++]
                var hash = lineCommentInfo.hash
                var newLineNum = lineNums[lineNums.length-1]
                var id = hash + '-' + (newLineNum || (lineNums[0] + '-'))
                var idEnc = encodeURIComponent(id)
                var allowComment = s !== '-'
                  && self.query.commit && self.query.path
                return [
                  ph('tr', {
                    class: s == '+' ? 'diff-new' : s == '-' ? 'diff-old' : ''
                  }, [
                    lineNums.map(function (num, i) {
                      return ph('td', [
                        ph('a', {
                          name: i === 0 ? idEnc : undefined,
                          href: '#' + idEnc
                        }, String(num))
                      ])
                    }),
                    ph('td',
                      allowComment ? ph('a', {
                        href: '?msg=' +
                          encodeURIComponent(self.query.msg)
                          + '&comment=' + idEnc
                          + '&commit=' + encodeURIComponent(self.query.commit)
                          + '&path=' + encodeURIComponent(self.query.path)
                          + '#' + idEnc
                      }, '…') : ''
                    ),
                    ph('td', ph('pre', u.escapeHTML(html)))
                  ]),
                  (lineComments[newLineNum] ?
                    ph('tr',
                      ph('td', {colspan: 4},
                        self.renderLineCommentThread(lineComments[newLineNum], id)
                      )
                    )
                  : newLineNum && lineCommentInfo && self.query.comment === id ?
                    ph('tr',
                      ph('td', {colspan: 4},
                        self.renderLineCommentForm({
                          id: id,
                          line: newLineNum,
                          updateId: updateMsg.key,
                          blobId: hash,
                          repoId: updateMsg.value.content.repo,
                          commitId: lineCommentInfo.commit,
                          filePath: lineCommentInfo.path,
                        })
                      )
                    )
                  : '')
                ]
              })
            )
          ]
        })
      )
    ])
  )
}

Serve.prototype.renderLineCommentThread = function (lineComment, id) {
  return this.streamThreadWithComposer({
    root: lineComment.msg.key,
    id: id,
    placeholder: 'reply to line comment thread'
  })
}

Serve.prototype.renderLineCommentForm = function (opts) {
  return [
    this.phComposer({
      placeholder: 'comment on this line',
      id: opts.id,
      lineComment: opts
    })
  ]
}

// return a composer, pull-hyperscript style
Serve.prototype.phComposer = function (opts) {
  var self = this
  return u.readNext(function (cb) {
    self.composer(opts, function (err, composer) {
      if (err) return cb(err)
      cb(null, pull.once(composer.outerHTML))
    })
  })
}

Serve.prototype.gitLineComment = function (path) {
  var self = this
  var id
  try {
    id = decodeURIComponent(String(path))
    if (id[0] === '%') {
      return self.getMsgDecryptedMaybeOoo(id, gotMsg)
    } else {
      msg = JSON.parse(id)
    }
  } catch(e) {
    return gotMsg(e)
  }
  gotMsg(null, msg)
  function gotMsg(err, msg) {
    if (err) return pull(
      pull.once(u.renderError(err).outerHTML),
      self.respondSink(400, {'Content-Type': ctype('html')})
    )
    var c = msg && msg.value && msg.value.content
    if (!c) return pull(
      pull.once('Missing message ' + id),
      self.respondSink(500, {'Content-Type': ctype('html')})
    )
    self.app.git.diffFile({
      msg: c.updateId,
      commit: c.commitId,
      path: c.filePath,
    }, function (err, file) {
      if (err && err.name === 'BlobNotFoundError')
        return self.askWantBlobs(err.links)
      if (err) return pull(
        pull.once(err.stack),
        self.respondSink(400, {'Content-Type': 'text/plain'})
      )
      var path
      if (file.created) {
        path = '/git/blob/' + file.hash[1]
          + '?msg=' + encodeURIComponent(c.updateId)
          + '&commit=' + c.commitId
          + '&path=' + encodeURIComponent(c.filePath)
          + '#' + file.hash[1] + '-' + c.line
      } else {
        path = '/git/diff/' + file.hash[0] + '..' + file.hash[1]
          + '?msg=' + encodeURIComponent(c.updateId)
          + '&commit=' + c.commitId
          + '&path=' + encodeURIComponent(c.filePath)
          + '#' + file.hash[1] + '-' + c.line
      }
      var url = self.app.render.toUrl(path)
      /*
      return pull(
        ph('a', {href: url}, path),
        self.wrapPage(id),
        self.respondSink(200)
      )
      */
      self.redirect(url)
    })
  }
}

Serve.prototype.gitObjectLinks = function (headMsgId, type) {
  var self = this
  return paramap(function (id, cb) {
    self.app.git.getObjectMsg({
      obj: id,
      headMsgId: headMsgId,
      type: type,
    }, function (err, msg) {
      if (err && err.name === 'BlobNotFoundError')
        return cb(null, self.askWantBlobsForm(err.links))
      if (err && err.name === 'ObjectNotFoundError')
        return cb(null, [
          ph('code', u.escapeHTML(id.substr(0, 8))), '(missing)'])
      if (err) return cb(err)
      var path = '/git/' + type + '/' + id
        + '?msg=' + encodeURIComponent(msg.key)
      cb(null, [ph('code', ph('a', {
        href: self.app.render.toUrl(path)
      }, u.escapeHTML(id.substr(0, 8)))), ' '])
    })
  }, 8)
}

Serve.prototype.npm = function (url) {
  var self = this
  var parts = url.split('/')
  var author = parts[1] && parts[1][0] === '@'
    ? u.unescapeId(parts.splice(1, 1)[0]) : null
  var name = parts[1]
  var version = parts[2]
  var distTag = parts[3]
  var prefix = 'npm:' +
    (name ? name + ':' +
      (version ? version + ':' +
        (distTag ? distTag + ':' : '') : '') : '')

  var render = self.app.render
  var base = '/npm/' + (author ? u.escapeId(author) + '/' : '')
  var pathWithoutAuthor = '/npm' +
    (name ? '/' + name +
      (version ? '/' + version +
        (distTag ? '/' + distTag : '') : '') : '')
  return pull(
    ph('section', {}, [
      ph('h3', [ph('a', {href: render.toUrl('/npm/')}, 'npm'), ' : ',
        author ? [
          self.phIdLink(author), ' ',
          ph('sub', ph('a', {href: render.toUrl(pathWithoutAuthor)}, '&times;')),
          ' : '
        ] : '',
        name ? [ph('a', {href: render.toUrl(base + name)}, name), ' : '] : '',
        version ? [ph('a', {href: render.toUrl(base + name + '/' + version)}, version), ' : '] : '',
        distTag ? [ph('a', {href: render.toUrl(base + name + '/' + version + '/' + distTag)}, distTag)] : ''
      ]),
      ph('table', [
        ph('thead', ph('tr', [
          ph('th', 'publisher'),
          ph('th', 'package'),
          ph('th', 'version'),
          ph('th', 'tag'),
          ph('th', 'size'),
          ph('th', 'tarball'),
          ph('th', 'readme')
        ])),
        ph('tbody', pull(
          self.app.blobMentions({
            name: {$prefix: prefix},
            author: author,
          }),
          distTag && !version && pull.filter(function (link) {
            return link.name.split(':')[3] === distTag
          }),
          paramap(function (link, cb) {
            self.app.render.npmPackageMention(link, {
              withAuthor: true,
              author: author,
              name: name,
              version: version,
              distTag: distTag,
            }, cb)
          }, 4),
          pull.map(u.toHTML)
        ))
      ])
    ]),
    self.wrapPage(prefix),
    self.respondSink(200)
  )
}

Serve.prototype.npmPrebuilds = function (url) {
  var self = this
  var parts = url.split('/')
  var author = parts[1] && parts[1][0] === '@'
    ? u.unescapeId(parts.splice(1, 1)[0]) : null
  var name = parts[1]
  var version = parts[2]
  var prefix = 'prebuild:' +
    (name ? name + '-' +
      (version ? version + '-' : '') : '')

  var render = self.app.render
  var base = '/npm-prebuilds/' + (author ? u.escapeId(author) + '/' : '')
  return pull(
    ph('section', {}, [
      ph('h3', [ph('a', {href: render.toUrl('/npm-prebuilds/')}, 'npm prebuilds'), ' : ',
        name ? [ph('a', {href: render.toUrl(base + name)}, name), ' : '] : '',
        version ? [ph('a', {href: render.toUrl(base + name + '/' + version)}, version)] : '',
      ]),
      ph('table', [
        ph('thead', ph('tr', [
          ph('th', 'publisher'),
          ph('th', 'name'),
          ph('th', 'version'),
          ph('th', 'runtime'),
          ph('th', 'abi'),
          ph('th', 'platform+libc'),
          ph('th', 'arch'),
          ph('th', 'size'),
          ph('th', 'tarball')
        ])),
        ph('tbody', pull(
          self.app.blobMentions({
            name: {$prefix: prefix},
            author: author,
          }),
          paramap(function (link, cb) {
            self.app.render.npmPrebuildMention(link, {
              withAuthor: true,
              author: author,
              name: name,
              version: version,
            }, cb)
          }, 4),
          pull.map(u.toHTML)
        ))
      ])
    ]),
    self.wrapPage(prefix),
    self.respondSink(200)
  )
}

Serve.prototype.npmReadme = function (url) {
  var self = this
  var id = decodeURIComponent(url.substr(1))
  return pull(
    ph('section', {}, [
      ph('h3', [
        'npm readme for ',
        ph('a', {href: '/links/' + id}, id.substr(0, 8) + '…')
      ]),
      ph('blockquote', u.readNext(function (cb) {
        self.app.getNpmReadme(id, function (err, readme, isMarkdown) {
          if (err) return cb(null, ph('div', u.renderError(err).outerHTML))
          cb(null, isMarkdown
            ? ph('div', self.app.render.markdown(readme))
            : ph('pre', readme))
        })
      }))
    ]),
    self.wrapPage('npm readme'),
    self.respondSink(200)
  )
}

Serve.prototype.markdown = function (url) {
  var self = this
  var id = decodeURIComponent(url.substr(1))
  var blobs = self.app.sbot.blobs
  return pull(
    ph('section', {}, [
      ph('h3', [
        ph('a', {href: '/links/' + id}, id.substr(0, 8) + '…')
      ]),
      u.readNext(function (cb) {
        blobs.size(id, function (err, size) {
          if (size == null) return cb(null, self.askWantBlobsForm([id]))
          pull(blobs.get(id), pull.collect(function (err, chunks) {
            if (err) return cb(null, ph('div', u.renderError(err).outerHTML))
            var text = Buffer.concat(chunks).toString()
            cb(null, ph('blockquote', self.app.render.markdown(text)))
          }))
        })
      })
    ]),
    self.wrapPage('markdown'),
    self.respondSink(200)
  )
}

Serve.prototype.zip = function (url) {
  var self = this
  var parts = url.split('/').slice(1)
  var id = decodeURIComponent(parts.shift())
  var filename = parts.join('/')
  var blobs = self.app.sbot.blobs
  var etag = id + filename
  var index = filename === '' || /\/$/.test(filename)
  var indexFilename = index && (filename + 'index.html')
  if (filename === '/' || /\/\/$/.test(filename)) {
    // force directory listing if path ends in //
    filename = filename.replace(/\/$/, '')
    indexFilename = false
  }
  var files = index && []
  if (self.req.headers['if-none-match'] === etag) return self.respond(304)
  blobs.size(id, function (err, size) {
    if (size == null) return askWantBlobsForm([id])
    if (err) {
      if (/^invalid/.test(err.message)) return self.respond(400, err.message)
      else return self.respond(500, err.message || err)
    }
    var unzip = require('unzip')
    var parseUnzip = unzip.Parse()
    var gotEntry = false
    parseUnzip.on('entry', function (entry) {
      if (index) {
        if (!gotEntry) {
          if (entry.path === indexFilename) {
            gotEntry = true
            return serveFile(entry)
          } else if (entry.path.substr(0, filename.length) === filename) {
            files.push({path: entry.path, type: entry.type, props: entry.props})
          }
        }
      } else {
        if (!gotEntry && entry.path === filename) {
          gotEntry = true
          // if (false && entry.type === 'Directory') return serveDirectory(entry)
          return serveFile(entry)
        }
      }
      entry.autodrain()
    })
    parseUnzip.on('close', function () {
      if (gotEntry) return
      if (!index) return self.respond(404, 'Entry not found')
      pull(
        ph('section', {}, [
          ph('h3', [
            ph('a', {href: self.app.render.toUrl('/links/' + id)}, id.substr(0, 8) + '…'),
            ' ',
            ph('a', {href: self.app.render.toUrl('/zip/' + encodeURIComponent(id) + '/' + filename)}, filename || '/'),
          ]),
          pull(
            pull.values(files),
            pull.map(function (file) {
              var path = '/zip/' + encodeURIComponent(id) + '/' + file.path
              return ph('li', [
                ph('a', {href: self.app.render.toUrl(path)}, file.path)
              ])
            })
          )
        ]),
        self.wrapPage(id + filename),
        self.respondSink(200)
      )
      gotEntry = true // so that the handler on error event does not run
    })
    parseUnzip.on('error', function (err) {
      if (!gotEntry) return self.respond(400, err.message)
    })
    var size
    function serveFile(entry) {
      size = entry.size
      pull(
        toPull.source(entry),
        ident(gotType),
        self.respondSink()
      )
    }
    pull(
      self.app.getBlob(id),
      toPull(parseUnzip)
    )
    function gotType(type) {
      type = type && mime.lookup(type)
      if (type) self.res.setHeader('Content-Type', type)
      if (size) self.res.setHeader('Content-Length', size)
      self.res.setHeader('Cache-Control', 'public, max-age=315360000')
      self.res.setHeader('etag', etag)
      self.res.writeHead(200)
    }
  })
}

Serve.prototype.web = function (url) {
  var self = this
  var id = decodeURIComponent(url.substr(1))

  var components = url.split('/')
  if (components[0] === '') components.shift()
  components[0] = decodeURIComponent(components[0])

  var type = mime.lookup(components[components.length - 1])
  webresolve(this.app.sbot, components, function (err, res) {
    if (err) {
      return pull(
        pull.once(err.toString()),
        self.respondSink(404)
      )
    }
    return pull(
      pull.once(res),
      self.respondSink(200, {'content-type': type, 'content-length': res.length})
    )
  })
}

// wrap a binary source and render it or turn into an embed
Serve.prototype.wrapBinary = function (opts) {
  var self = this
  var ext = opts.ext
  var hash = opts.obj.hash
  return function (read) {
    var readRendered, type
    read = ident(function (_ext) {
      if (_ext) ext = _ext
      type = ext && mime.lookup(ext) || 'text/plain'
    })(read)
    return function (abort, cb) {
      if (readRendered) return readRendered(abort, cb)
      if (abort) return read(abort, cb)
      if (!type) read(null, function (end, buf) {
        if (end) return cb(end)
        if (!type) return cb(new Error('unable to get type'))
        readRendered = pickSource(type, cat([pull.once(buf), read]))
        readRendered(null, cb)
      })
    }
  }
  function pickSource(type, read) {
    if (/^image\//.test(type)) {
      read(true, function (err) {
        if (err && err !== true) console.trace(err)
      })
      return ph('img', {
        src: opts.rawUrl
      })
    }
    if (type === 'text/markdown') {
      // TODO: rewrite links to files/images to be correct
      return ph('blockquote', u.readNext(function (cb) {
        pull.collect(function (err, bufs) {
          if (err) return cb(pull.error(err))
          var text = Buffer.concat(bufs).toString('utf8')
          return cb(null, pull.once(self.app.render.markdown(text)))
        })(read)
      }))
    }
    var i = 1
    var updateMsg = opts.obj.msg
    var commitId = self.query.commit
    var filePath = self.query.path
    var lineComments = opts.lineComments || {}
    return u.readNext(function (cb) {
      if (commitId && filePath) {
        self.app.getLineComments({
          obj: opts.obj,
          hash: hash,
        }, gotLineComments)
      } else {
        gotLineComments(null, {})
      }
      function gotLineComments(err, lineComments) {
        if (err) return cb(err)
        cb(null, ph('table',
          pull(
            read,
            utf8(),
            split(),
            pull.map(function (line) {
              var lineNum = i++
              var id = hash + '-' + lineNum
              var idEnc = encodeURIComponent(id)
              var allowComment = self.query.commit && self.query.path
              return [
                ph('tr', [
                  ph('td',
                    allowComment ? ph('a', {
                      href: '?msg=' + encodeURIComponent(self.query.msg)
                        + '&commit=' + encodeURIComponent(self.query.commit)
                        + '&path=' + encodeURIComponent(self.query.path)
                        + '&comment=' + idEnc
                        + '#' + idEnc
                    }, '…') : ''
                  ),
                  ph('td', ph('a', {
                    name: id,
                    href: '#' + idEnc
                  }, String(lineNum))),
                  ph('td', ph('pre', self.app.render.highlight(line, ext)))
                ]),
                lineComments[lineNum] ? ph('tr',
                  ph('td', {colspan: 4},
                    self.renderLineCommentThread(lineComments[lineNum], id)
                  )
                ) : '',
                self.query.comment === id ? ph('tr',
                  ph('td', {colspan: 4},
                    self.renderLineCommentForm({
                      id: id,
                      line: lineNum,
                      updateId: updateMsg.key,
                      repoId: updateMsg.value.content.repo,
                      commitId: commitId,
                      blobId: hash,
                      filePath: filePath,
                    })
                  )
                ) : ''
              ]
            })
          )
        ))
      }
    })
  }
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

Serve.prototype.askWantBlobsForm = function (links) {
  var self = this
  return ph('form', {action: '', method: 'post'}, [
    ph('section', [
      ph('h3', 'Missing blobs'),
      ph('p', 'The application needs these blobs to continue:'),
      ph('table', links.map(u.toLink).map(function (link) {
        if (!u.isRef(link.link)) return
        return ph('tr', [
          ph('td', ph('code', link.link)),
          !isNaN(link.size) ? ph('td', self.app.render.formatSize(link.size)) : '',
        ])
      })),
      ph('input', {type: 'hidden', name: 'action', value: 'want-blobs'}),
      ph('input', {type: 'hidden', name: 'blob_ids',
        value: links.map(u.linkDest).join(',')}),
      ph('p', ph('input', {type: 'submit', value: 'Want Blobs'}))
    ])
  ])
}

Serve.prototype.askWantBlobs = function (links) {
  var self = this
  pull(
    self.askWantBlobsForm(links),
    self.wrapPage('missing blobs'),
    self.respondSink(409)
  )
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
        placeholder: opts.placeholder
          || (recps ? 'private reply' : 'reply'),
        id: 'reply',
        root: opts.root,
        post: opts.post,
        channel: opts.channel || '',
        branches: opts.branches,
        postBranches: opts.postBranches,
        recps: recps,
        private: opts.recps != null,
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
            h('a', {href: self.app.render.toUrl('/channel/' + channel)}, '#' + channel)
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
        h('h4', 'Network')
      ),
      h('section',
        channels
      )
    ])
  })
}

Serve.prototype.wrapMyChannels = function (opts) {
  var self = this
  return u.hyperwrap(function (channels, cb) {
    cb(null, [
      h('section',
        h('h4', 'Subscribed')
      ),
      h('section',
        channels
      )
    ])
  })
}

Serve.prototype.composer = function (opts, cb) {
  var self = this
  opts = opts || {}
  var data = self.data
  var myId = self.app.sbot.id

  if (opts.id && data.composer_id && opts.id !== data.composer_id) {
    // don't share data between multiple composers
    data = {}
  }

  if (!data.text && self.query.text) data.text = self.query.text
  if (!data.action && self.query.action) data.action = self.query.action

  var blobs = u.tryDecodeJSON(data.blobs) || {}
  if (data.upload && typeof data.upload === 'object') {
    blobs[data.upload.link] = {
      type: data.upload.type,
      size: data.upload.size,
      key: data.upload.key,
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

  var formEmojiNames = {}
  var emojiIds = u.toArray(data.emoji_id)
  var emojiNames = u.toArray(data.emoji_name)
  for (var i = 0; i < emojiIds.length && i < emojiNames.length; i++) {
    var upload = data['emoji_upload_' + i]
    formEmojiNames[emojiNames[i]] =
      (upload && upload.link) || u.extractBlobIds(emojiIds[i])[0]
    if (upload) blobs[upload.link] = {
      type: upload.type,
      size: upload.size,
    }
  }

  if (data.upload) {
    var href = data.upload.link
      + (data.upload.key ? '?unbox=' + data.upload.key + '.boxs': '')
    // TODO: be able to change the content-type
    var isImage = /^image\//.test(data.upload.type)
    data.text = (data.text ? data.text + '\n' : '')
      + (isImage ? '!' : '')
      + '[' + data.upload.name + '](' + href + ')'
  }

  // get bare feed names
  var unknownMentionNames = {}
  var mentions = ssbMentions(data.text, {bareFeedNames: true, emoji: true})
  var unknownMentions = mentions
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

  var emoji = mentions
    .filter(function (mention) { return mention.emoji })
    .map(function (mention) { return mention.name })
    .filter(uniques())
    .map(function (name) {
      // 1. check emoji-image mapping for this message
      var id = formEmojiNames[name]
      if (id) return {name: name, id: id}
      // 2. TODO: check user's preferred emoji-image mapping
      // 3. check builtin emoji
      var link = self.getBuiltinEmojiLink(name)
      if (link) {
        return {name: name, id: link.link}
        blobs[id] = {type: link.type, size: link.size}
      }
      // 4. check recently seen emoji
      id = self.app.getReverseEmojiNameSync(name)
      return {name: name, id: id}
    })

  // strip content other than names and feed ids from the recps field
  if (data.recps) {
    data.recps = recpsToFeedIds(data.recps)
  }

  var done = multicb({pluck: 1, spread: true})
  done()(null, h('section.composer',
    h('form', {method: 'post', action: opts.id ? '#' + opts.id : '',
      enctype: 'multipart/form-data'},
      h('input', {type: 'hidden', name: 'blobs',
        value: JSON.stringify(blobs)}),
      h('input', {type: 'hidden', name: 'composer_id', value: opts.id}),
      opts.recps ? self.app.render.privateLine(opts.recps, done()) :
      opts.private ? h('div', h('input.recps-input', {name: 'recps',
        value: data.recps || '', placeholder: 'recipient ids'})) : '',
      channel != null ?
        h('div', '#', h('input', {name: 'channel', placeholder: 'channel',
          value: channel})) : '',
      opts.root !== opts.post ? h('div',
        h('label', {for: 'fork_thread'},
          h('input', {id: 'fork_thread', type: 'checkbox', name: 'fork_thread', value: 'post', checked: data.fork_thread || undefined}),
          ' fork thread'
        )
      ) : '',
      h('textarea', {
        id: opts.id,
        name: 'text',
        rows: Math.max(4, u.rows(data.text)),
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
            h('input.id-input', {name: 'mention_id', size: 60,
              value: mention.id, placeholder: '@id'}))
        }))
      ] : '',
      emoji.length > 0 ? [
        h('div', h('em', 'emoji:')),
        h('ul.mentions', emoji.map(function (link, i) {
          return h('li',
            h('code', link.name), ': ',
            h('input', {name: 'emoji_name', type: 'hidden',
              value: link.name}),
            h('input.id-input', {name: 'emoji_id', size: 60,
              value: link.id, placeholder: '&id'}), ' ',
            h('input', {type: 'file', name: 'emoji_upload_' + i}))
        }))
      ] : '',
      h('table.ssb-msgs',
        h('tr.msg-row',
          h('td.msg-left', {colspan: 2},
            opts.private ?
              h('input', {type: 'hidden', name: 'private', value: '1'}) : '',
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

  function recpsToFeedIds (recps) {
    var res = data.recps.split(',')
      .map(function (str) {
        str = str.trim()
        var ids = u.extractFeedIds(str).filter(uniques())
        if (ids.length >= 1) {
          return ids[0]
        } else {
          ids = u.extractFeedIds(self.app.getReverseNameSync(str))
          if (ids.length >= 1) {
            return ids[0]
          } else {
            return null
          }
        }
      })
      .filter(Boolean)
    return res.join(', ')
  }

  function prepareContent(cb) {
    var done = multicb({pluck: 1})
    content = {
      type: 'post',
      text: String(data.text).replace(/\r\n/g, '\n'),
    }
    if (opts.lineComment) {
      content.type = 'line-comment'
      content.updateId = opts.lineComment.updateId
      content.repo = opts.lineComment.repoId
      content.commitId = opts.lineComment.commitId
      content.filePath = opts.lineComment.filePath
      content.blobId = opts.lineComment.blobId
      content.line = opts.lineComment.line
    }
    var mentions = ssbMentions(data.text, {bareFeedNames: true, emoji: true})
      .filter(function (mention) {
        if (mention.emoji) {
          mention.link = formEmojiNames[mention.name]
          if (!mention.link) {
            var link = self.getBuiltinEmojiLink(mention.name)
            if (link) {
              mention.link = link.link
              mention.size = link.size
              mention.type = link.type
            } else {
              mention.link = self.app.getReverseEmojiNameSync(mention.name)
              if (!mention.link) return false
            }
          }
        }
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
        if (mention.link && mention.link[0] === '&' && mention.size == null) {
          var linkCb = done()
          self.app.sbot.blobs.size(mention.link, function (err, size) {
            if (!err && size != null) mention.size = size
            linkCb()
          })
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
    if (data.fork_thread) {
      content.root = opts.post || undefined
      content.branch = u.fromArray(opts.postBranches) || undefined
    } else {
      content.root = opts.root || undefined
      content.branch = u.fromArray(opts.branches) || undefined
    }
    if (channel) content.channel = data.channel

    done(function (err) {
      cb(err, content)
    })
  }

  function preview(raw, cb) {
    var msgContainer = h('table.ssb-msgs')
    var contentInput = h('input', {type: 'hidden', name: 'content'})
    var warningsContainer = h('div')
    var sizeEl = h('span')

    var content
    try { content = JSON.parse(data.text) }
    catch (err) {}
    if (content) gotContent(null, content)
    else prepareContent(gotContent)

    function gotContent(err, content) {
      if (err) return cb(err)
      contentInput.value = JSON.stringify(content)
      var msg = {
        value: {
          author: myId,
          timestamp: Date.now(),
          content: content
        }
      }
      if (content.recps) msg.value.private = true

      var warnings = []
      u.toLinkArray(content.mentions).forEach(function (link) {
        if (link.emoji && link.size >= 10e3) {
          warnings.push(h('li',
            'emoji ', h('q', link.name),
            ' (', h('code', String(link.link).substr(0, 8) + '…'), ')'
            + ' is >10KB'))
        } else if (link.link[0] === '&' && link.size >= 10e6 && link.type) {
          // if link.type is set, we probably just uploaded this blob
          warnings.push(h('li',
            'attachment ',
            h('code', String(link.link).substr(0, 8) + '…'),
            ' is >10MB'))
        }
      })

      var draftMsg = {
        key: '%0000000000000000000000000000000000000000000=.sha256',
        value: {
          previous: '%0000000000000000000000000000000000000000000=.sha256',
          author: '@0000000000000000000000000000000000000000000=.ed25519',
          sequence: 1000,
          timestamp: 1000000000000,
          hash: 'sha256',
          content: content
        }
      }
      var estSize = JSON.stringify(draftMsg, null, 2).length
      sizeEl.innerHTML = self.app.render.formatSize(estSize)
      if (estSize > 8192) warnings.push(h('li', 'message is too long'))

      if (warnings.length) {
        warningsContainer.appendChild(h('div', h('em', 'warning:')))
        warningsContainer.appendChild(h('ul.mentions', warnings))
      }

      pull(
        pull.once(msg),
        self.app.unboxMessages(),
        self.app.render.renderFeeds({
          raw: raw,
          filter: self.query.filter,
        }),
        pull.drain(function (el) {
          msgContainer.appendChild(h('tbody', el))
        }, cb)
      )
    }

    return [
      contentInput,
      opts.redirectToPublishedMsg ? h('input', {type: 'hidden',
        name: 'redirect_to_published_msg', value: '1'}) : '',
      warningsContainer,
      h('div', h('em', 'draft:'), ' ', sizeEl),
      msgContainer,
      h('div.composer-actions',
        h('input', {type: 'submit', name: 'action', value: 'publish'})
      )
    ]
  }

}

function hashBuf(buf) {
  var hash = crypto.createHash('sha256')
  hash.update(buf)
  return '&' + hash.digest('base64') + '.sha256'
}

Serve.prototype.getBuiltinEmojiLink = function (name) {
  if (!(name in emojis)) return
  var file = path.join(emojiDir, name + '.png')
  var fileBuf = fs.readFileSync(file)
  var id = hashBuf(fileBuf)
  // seed the builtin emoji
  pull(pull.once(fileBuf), this.app.sbot.blobs.add(id, function (err) {
    if (err) console.error('error adding builtin emoji as blob', err)
  }))
  return {
    link: id,
    type: 'image/png',
    size: fileBuf.length,
  }
}

Serve.prototype.getMsgDecryptedMaybeOoo = function (key, cb) {
  if (this.useOoo) this.app.getMsgDecryptedOoo(key, cb)
  else this.app.getMsgDecrypted(key, cb)
}

Serve.prototype.emojis = function (path) {
  var self = this
  var seen = {}
  pull(
    ph('section', [
      ph('h3', 'Emojis'),
      ph('ul', {class: 'mentions'}, pull(
        self.app.streamEmojis(),
        pull.map(function (emoji) {
          if (!seen[emoji.name]) {
            // cache the first use, so that our uses take precedence over other feeds'
            self.app.reverseEmojiNameCache.set(emoji.name, emoji.link)
            seen[emoji.name] = true
          }
          return ph('li', [
            ph('a', {href: self.app.render.toUrl('/links/' + emoji.link)},
              ph('img', {
                class: 'ssb-emoji',
                src: self.app.render.imageUrl(emoji.link),
                size: 32,
              })
            ), ' ',
            u.escapeHTML(emoji.name)
          ])
        })
      ))
    ]),
    this.wrapPage('emojis'),
    this.respondSink(200)
  )
}
