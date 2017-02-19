var http = require('http')
var memo = require('asyncmemo')
var lru = require('lrucache')
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
  this.getAbout = memo({cache: lru(100)}, getAbout, sbot, sbot.id)
  this.unboxContent = memo({cache: lru(100)}, sbot.private.unbox)

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
}

var logPrefix = '[' + pkg.name + ']'
App.prototype.log = console.log.bind(console, logPrefix)
App.prototype.error = console.error.bind(console, logPrefix)

App.prototype.unboxMsg = function (msg, cb) {
  var self = this
  var c = msg.value.content
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
  if (Array.isArray(content.recps)) {
    recps = content.recps.map(u.linkDest)
    this.sbot.private.publish(content, recps, cb)
  } else {
    this.sbot.publish(content, cb)
  }
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

function getMsgWithValue(sbot, id, cb) {
  sbot.get(id, function (err, value) {
    if (err) return cb(err)
    cb(null, {key: id, value: value})
  })
}

function getAbout(sbot, src, id, cb) {
  ssbAvatar(sbot, src, id, function (err, about) {
    if (err) return cb(err)
    var sigil = id && id[0] || '@'
    if (about.name && about.name[0] !== sigil) {
      about.name = sigil + about.name
    }
    cb(null, about)
  })
}

App.prototype.createLogStream = function (opts) {
  opts = opts || {}
  return opts.sortByTimestamp
    ? this.sbot.createFeedStream(opts)
    : this.sbot.createLogStream(opts)
}
