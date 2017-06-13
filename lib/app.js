var http = require('http')
var memo = require('asyncmemo')
var lru = require('hashlru')
var pkg = require('../package')
var u = require('./util')
var pull = require('pull-stream')
var hasher = require('pull-hash/ext/ssb')
var multicb = require('multicb')
var paramap = require('pull-paramap')
var Contacts = require('ssb-contact')
var About = require('./about')
var Serve = require('./serve')
var Render = require('./render')
var Git = require('./git')
var cat = require('pull-cat')

module.exports = App

function App(sbot, config) {
  this.sbot = sbot
  this.config = config

  var conf = config.patchfoo || {}
  this.port = conf.port || 8027
  this.host = conf.host || '::1'

  var base = conf.base || '/'
  this.opts = {
    base: base,
    blob_base: conf.blob_base || conf.img_base || base,
    img_base: conf.img_base || base,
    emoji_base: conf.emoji_base || (base + 'emoji/'),
  }

  sbot.get = memo({cache: lru(100)}, sbot.get)
  this.about = new About(this, sbot.id)
  this.getMsg = memo({cache: lru(100)}, getMsgWithValue, sbot)
  this.getAbout = memo({cache: this.aboutCache = lru(500)},
    this._getAbout.bind(this))
  this.unboxContent = memo({cache: lru(100)}, sbot.private.unbox)
  this.reverseNameCache = lru(500)
  this.reverseEmojiNameCache = lru(500)

  this.unboxMsg = this.unboxMsg.bind(this)

  this.render = new Render(this, this.opts)
  this.git = new Git(this)
}

App.prototype.go = function () {
  var self = this
  http.createServer(function (req, res) {
    new Serve(self, req, res).go()
  }).listen(self.port, self.host, function () {
    var host = /:/.test(self.host) ? '[' + self.host + ']' : self.host
    self.log('Listening on http://' + host + ':' + self.port)
  })

  // invalidate cached About info when new About messages come in
  pull(
    self.sbot.links({rel: 'about', old: false, values: true}),
    pull.drain(function (link) {
      self.aboutCache.remove(link.dest)
    }, function (err) {
      if (err) self.error('about:', err)
    })
  )
}

var logPrefix = '[' + pkg.name + ']'
App.prototype.log = console.log.bind(console, logPrefix)
App.prototype.error = console.error.bind(console, logPrefix)

App.prototype.unboxMsg = function (msg, cb) {
  var self = this
  var c = msg.value && msg.value.content
  if (typeof c !== 'string') cb(null, msg)
  else self.unboxContent(c, function (err, content) {
    if (err) {
      self.error('unbox:', err)
      return cb(null, msg)
    } else if (!content) {
      return cb(null, msg)
    }
    var m = {}
    for (var k in msg) m[k] = msg[k]
    m.value = {}
    for (var k in msg.value) m.value[k] = msg.value[k]
    m.value.content = content
    m.value.private = true
    cb(null, m)
  })
}

App.prototype.search = function (opts) {
  var search = this.sbot.fulltext && this.sbot.fulltext.search
  if (!search) return pull.error(new Error('Missing fulltext search plugin'))
  return search(opts)
}

App.prototype.advancedSearch = function (opts) {
  return pull(
    opts.dest ?
      this.sbot.links({
        values: true,
        dest: opts.dest,
        source: opts.source || undefined,
        reverse: true,
      })
    : opts.source ?
      this.sbot.createUserStream({
        reverse: true,
        id: opts.source
      })
    :
      this.sbot.createFeedStream({
        reverse: true,
      }),
    opts.text && pull.filter(filterByText(opts.text))
  )
}

function forSome(each) {
  return function some(obj) {
    if (obj == null) return false
    if (typeof obj === 'string') return each(obj)
    if (Array.isArray(obj)) return obj.some(some)
    if (typeof obj === 'object')
      for (var k in obj) if (some(obj[k])) return true
    return false
  }
}

function filterByText(str) {
  if (!str) return function () { return true }
  var search = new RegExp(str, 'i')
  var matches = forSome(search.test.bind(search))
  return function (msg) {
    var c = msg.value.content
    return c && matches(c)
  }
}

App.prototype.getMsgDecrypted = function (key, cb) {
  var self = this
  this.getMsg(key, function (err, msg) {
    if (err) return cb(err)
    self.unboxMsg(msg, cb)
  })
}

App.prototype.publish = function (content, cb) {
  var self = this
  function tryPublish(triesLeft) {
    if (Array.isArray(content.recps)) {
      recps = content.recps.map(u.linkDest)
      self.sbot.private.publish(content, recps, next)
    } else {
      self.sbot.publish(content, next)
    }
    function next(err, msg) {
      if (err) {
        if (triesLeft > 0) {
          if (/^expected previous:/.test(err.message)) {
            return tryPublish(triesLeft-1)
          }
        }
      }
      return cb(err, msg)
    }
  }
  tryPublish(2)
}

App.prototype.wantSizeBlob = function (id, cb) {
  var blobs = this.sbot.blobs
  blobs.size(id, function (err, size) {
    if (size != null) return cb(null, size)
    blobs.want(id, function (err) {
      if (err) return cb(err)
      blobs.size(id, cb)
    })
  })
}

App.prototype.addBlob = function (cb) {
  var done = multicb({pluck: 1, spread: true})
  var hashCb = done()
  var addCb = done()
  done(function (err, hash, add) {
    cb(err, hash)
  })
  return pull(
    hasher(hashCb),
    this.sbot.blobs.add(addCb)
  )
}

App.prototype.pushBlob = function (id, cb) {
  console.error('pushing blob', id)
  this.sbot.blobs.push(id, cb)
}

App.prototype.readBlob = function (link) {
  link = u.toLink(link)
  return this.sbot.blobs.get({
    hash: link.link,
    size: link.size,
  })
}

App.prototype.readBlobSlice = function (link, opts) {
  if (this.sbot.blobs.getSlice) return this.sbot.blobs.getSlice({
    hash: link.link,
    size: link.size,
    start: opts.start,
    end: opts.end,
  })
  return pull(
    this.readBlob(link),
    u.pullSlice(opts.start, opts.end)
  )
}

App.prototype.ensureHasBlobs = function (links, cb) {
  var self = this
  var done = multicb({pluck: 1})
  links.forEach(function (link) {
    var cb = done()
    self.sbot.blobs.size(link.link, function (err, size) {
      if (err) cb(err)
      else if (size == null) cb(null, link)
      else cb()
    })
  })
  done(function (err, missingLinks) {
    if (err) console.trace(err)
    missingLinks = missingLinks.filter(Boolean)
    if (missingLinks.length == 0) return cb()
    return cb({name: 'BlobNotFoundError', links: missingLinks})
  })
}

App.prototype.getReverseNameSync = function (name) {
  var id = this.reverseNameCache.get(name)
  return id
}

App.prototype.getReverseEmojiNameSync = function (name) {
  return this.reverseEmojiNameCache.get(name)
}

App.prototype.getNameSync = function (name) {
  var about = this.aboutCache.get(name)
  return about && about.name
}

function getMsgWithValue(sbot, id, cb) {
  if (!id) return cb()
  sbot.get(id, function (err, value) {
    if (err) return cb(err)
    cb(null, {key: id, value: value})
  })
}

App.prototype._getAbout = function (id, cb) {
  var self = this
  if (!u.isRef(id)) return cb(null, {})
  self.about.get(id, function (err, about) {
    if (err) return cb(err)
    var sigil = id[0] || '@'
    if (about.name && about.name[0] !== sigil) {
      about.name = sigil + about.name
    }
    self.reverseNameCache.set(about.name, id)
    cb(null, about)
  })
}

App.prototype.pullGetMsg = function (id) {
  return pull.asyncMap(this.getMsg)(pull.once(id))
}

App.prototype.createLogStream = function (opts) {
  opts = opts || {}
  return opts.sortByTimestamp
    ? this.sbot.createFeedStream(opts)
    : this.sbot.createLogStream(opts)
}

var stateVals = {
  connected: 3,
  connecting: 2,
  disconnecting: 1,
}

function comparePeers(a, b) {
  var aState = stateVals[a.state] || 0
  var bState = stateVals[b.state] || 0
  return (bState - aState)
    || (b.stateChange|0 - a.stateChange|0)
}

App.prototype.streamPeers = function (opts) {
  var gossip = this.sbot.gossip
  return u.readNext(function (cb) {
    gossip.peers(function (err, peers) {
      if (err) return cb(err)
      if (opts) peers = peers.filter(function (peer) {
        for (var k in opts) if (opts[k] !== peer[k]) return false
        return true
      })
      peers.sort(comparePeers)
      cb(null, pull.values(peers))
    })
  })
}

App.prototype.getFollow = function (source, dest, cb) {
  var self = this
  pull(
    self.sbot.links({source: source, dest: dest, rel: 'contact', reverse: true,
      values: true, meta: false, keys: false}),
    pull.filter(function (value) {
      var c = value && value.content
      return c && c.type === 'contact'
    }),
    pull.take(1),
    pull.collect(function (err, msgs) {
      if (err) return cb(err)
      cb(null, msgs[0] && !!msgs[0].content.following)
    })
  )
}

App.prototype.unboxMessages = function () {
  return paramap(this.unboxMsg, 16)
}

App.prototype.streamChannels = function (opts) {
  return pull(
    this.sbot.messagesByType({type: 'channel', reverse: true}),
    this.unboxMessages(),
    pull.filter(function (msg) {
      return msg.value.content.subscribed
    }),
    pull.map(function (msg) {
      return msg.value.content.channel
    }),
    pull.unique()
  )
}

App.prototype.streamMyChannels = function (id, opts) {
  // use ssb-query plugin if it is available, since it has an index for
  // author + type
  if (this.sbot.query) return pull(
    this.sbot.query.read({
      reverse: true,
      query: [
        {$filter: {
          value: {
            author: id,
            content: {type: 'channel', subscribed: true}
          }
        }},
        {$map: ['value', 'content', 'channel']}
      ]
    }),
    pull.unique()
  )

  return pull(
    this.sbot.createUserStream({id: id, reverse: true}),
    this.unboxMessages(),
    pull.filter(function (msg) {
      if (msg.value.content.type == 'channel') {
        return msg.value.content.subscribed
      }
    }),
    pull.map(function (msg) {
      return msg.value.content.channel
    }),
    pull.unique()
  )
}

App.prototype.createContactStreams = function (id) {
  return new Contacts(this.sbot).createContactStreams(id)
}

function compareVoted(a, b) {
  return b.value - a.value
}

App.prototype.getVoted = function (_opts, cb) {
  if (isNaN(_opts.limit)) return pull.error(new Error('missing limit'))
  var self = this
  var opts = {
    type: 'vote',
    limit: _opts.limit * 100,
    reverse: !!_opts.reverse,
    gt: _opts.gt || undefined,
    lt: _opts.lt || undefined,
  }

  var votedObj = {}
  var votedArray = []
  var numItems = 0
  var firstTimestamp, lastTimestamp
  pull(
    self.sbot.messagesByType(opts),
    self.unboxMessages(),
    pull.take(function () {
      return numItems < _opts.limit
    }),
    pull.drain(function (msg) {
      if (!firstTimestamp) firstTimestamp = msg.timestamp
      lastTimestamp = msg.timestamp
      var vote = msg.value.content.vote
      if (!vote) return
      var target = u.linkDest(vote)
      var votes = votedObj[target]
      if (!votes) {
        numItems++
        votes = {id: target, value: 0, feedsObj: {}, feeds: []}
        votedObj[target] = votes
        votedArray.push(votes)
      }
      if (msg.value.author in votes.feedsObj) {
        if (!opts.reverse) return // leave latest vote value as-is
        // remove old vote value
        votes.value -= votes.feedsObj[msg.value.author]
      } else {
        votes.feeds.push(msg.value.author)
      }
      var value = vote.value > 0 ? 1 : vote.value < 0 ? -1 : 0
      votes.feedsObj[msg.value.author] = value
      votes.value += value
    }, function (err) {
      if (err) return cb(err)
      var items = votedArray
      if (opts.reverse) items.reverse()
      items.sort(compareVoted)
      cb(null, {items: items,
        firstTimestamp: firstTimestamp,
        lastTimestamp: lastTimestamp})
    })
  )
}

App.prototype.createAboutStreams = function (id) {
  return this.about.createAboutStreams(id)
}

App.prototype.streamEmojis = function () {
  return pull(
    cat([
      this.sbot.links({
        rel: 'mentions',
        source: this.sbot.id,
        dest: '&',
        values: true
      }),
      this.sbot.links({rel: 'mentions', dest: '&', values: true})
    ]),
    this.unboxMessages(),
    pull.map(function (msg) { return msg.value.content.mentions }),
    pull.flatten(),
    pull.filter('emoji'),
    pull.unique('link')
  )
}

App.prototype.filter = function (plugin, opts, filter) {
  // work around flumeview-query not supporting $lt/$gt.
  // %FCIv0D7JQyERznC18p8Dc1KtN6SLeJAl1sR5DAIr/Ek=.sha256
  return pull(
    plugin.read({
      reverse: opts.reverse,
      limit: opts.limit && (opts.limit + 1),
      query: [{$filter: u.mergeOpts(filter, {
        timestamp: {
          $gte: opts.gt,
          $lte: opts.lt,
        }
      })}]
    }),
    pull.filter(function (msg) {
      return msg && msg.timestamp !== opts.lt && msg.timestamp !== opts.gt
    }),
    opts.limit && pull.take(opts.limit)
  )
}

App.prototype.streamChannel = function (opts) {
  // prefer ssb-backlinks to ssb-query because it also handles hashtag mentions
  if (this.sbot.backlinks) return this.filter(this.sbot.backlinks, opts, {
    dest: '#' + opts.channel,
    value: {
      // filter by message type to work around %b+QdyLFQ21UGYwvV3AiD8FEr7mKlB8w9xx3h8WzSUb0=.sha256
      content: {
        type: 'post'
      }
    }
  })

  if (this.sbot.query) return this.filter(this.sbot.query, opts, {
    value: {content: {channel: opts.channel}},
  })

  return pull.error(new Error(
    'Viewing channels/tags requires the ssb-backlinks or ssb-query plugin'))
}

App.prototype.streamMentions = function (opts) {
  if (!this.sbot.backlinks) return pull.error(new Error(
    'Viewing mentions requires the ssb-backlinks plugin'))

  if (this.sbot.backlinks) return this.filter(this.sbot.backlinks, opts, {
    dest: this.sbot.id,
    value: {
      // filter by message type to work around %b+QdyLFQ21UGYwvV3AiD8FEr7mKlB8w9xx3h8WzSUb0=.sha256
      content: {
        type: 'post'
      }
    }
  })
}

App.prototype.streamPrivate = function (opts) {
  if (this.sbot.private.read) return this.filter(this.sbot.private, opts, {})

  return pull(
    this.createLogStream(u.mergeOpts(opts, {limit: null})),
    pull.filter(u.isMsgEncrypted),
    this.unboxMessages(),
    pull.filter(u.isMsgReadable),
    pull.take(opts.limit)
  )
}
