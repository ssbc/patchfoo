var http = require('http')
var memo = require('asyncmemo')
var lru = require('hashlru')
var pkg = require('../package')
var u = require('./util')
var pull = require('pull-stream')
var ssbAvatar = require('ssb-avatar')
var hasher = require('pull-hash/ext/ssb')
var multicb = require('multicb')

var Serve = require('./serve')
var Render = require('./render')

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
  this.getMsg = memo({cache: lru(100)}, getMsgWithValue, sbot)
  this.getAbout = memo({cache: this.aboutCache = lru(100)},
    getAbout.bind(this), sbot, sbot.id)
  this.unboxContent = memo({cache: lru(100)}, sbot.private.unbox)
  this.reverseNameCache = lru(100)

  this.unboxMsg = this.unboxMsg.bind(this)

  this.render = new Render(this, this.opts)
}

App.prototype.go = function () {
  var self = this
  http.createServer(function (req, res) {
    new Serve(self, req, res).go()
  }).listen(self.port, self.host, function () {
    self.log('Listening on http://' + self.host + ':' + self.port)
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
    } else if (content === false) {
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

App.prototype.getReverseNameSync = function (name) {
  var id = this.reverseNameCache.get(name)
  return id
}

function getMsgWithValue(sbot, id, cb) {
  if (!id) return cb()
  sbot.get(id, function (err, value) {
    if (err) return cb(err)
    cb(null, {key: id, value: value})
  })
}

function getAbout(sbot, src, id, cb) {
  var self = this
  ssbAvatar(sbot, src, id, function (err, about) {
    if (err) return cb(err)
    var sigil = id && id[0] || '@'
    if (about.name && about.name[0] !== sigil) {
      about.name = sigil + about.name
    }
    self.reverseNameCache.set(about.name, id)
    cb(null, about)
  })
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

App.prototype.getFollows = function (id, cb) {
  var self = this
  pull(
    self.sbot.links({source: id, rel: 'contact', values: true}),
    pull.filter(function (msg) {
      var c = msg && msg.value && msg.value.content
      return c && c.type === 'contact' && msg.value.author === id
    }),
    pull.reduce(function (acc, msg) {
      var c = msg.value.content
      if (c.following) acc[c.contact] = true
      else delete acc[c.contact]
      return acc
    }, {}, cb)
  )
}

App.prototype.getFollowers = function (id, cb) {
  var self = this
  pull(
    self.sbot.links({dest: id, rel: 'contact', values: true}),
    pull.filter(function (msg) {
      var c = msg && msg.value && msg.value.content
      return c && c.type === 'contact' && c.contact === id
    }),
    pull.reduce(function (acc, msg) {
      var c = msg.value.content
      if (c.following) acc[msg.value.author] = true
      else delete acc[msg.value.author]
      return acc
    }, {}, cb)
  )
}

App.prototype.getFriendInfo = function (id, cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  self.getFollows(id, done())
  self.getFollowers(id, done())
  done(function (err, followsObj, followersObj) {
    if (err) return cb(err)
    var friends = []
    var follows = []
    var followers = []
    for (var k in followsObj) {
      if (followersObj[k]) friends.push(k)
      else follows.push(k)
    }
    for (var k in followersObj) {
      if (!followsObj[k]) followers.push(k)
    }
    cb(null, {
      friends: friends,
      follows: follows,
      followers: followers,
    })
  })
}
