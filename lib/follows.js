var pull = require('pull-stream')
var memo = require('asyncmemo')
var lru = require('hashlru')

module.exports = Follows

function Follows(sbot, contacts) {
  if (!(this instanceof Follows)) return new Follows(sbot)

  this.sbot = sbot
  this.contacts = contacts
  var followsCache = lru(100)
  this.getFollows = memo({cache: followsCache}, this.getFollows)

  pull(
    sbot.messagesByType({type: 'contact', old: false}),
    pull.drain(function (msg) {
      var author = msg && msg.value && msg.value.author
      var c = msg && msg.value && msg.value.content
      var follows = author && followsCache.get(author)
      if (follows && c && c.contact) follows[c.contact] = c.following
    }, function (err) {
      if (err) console.trace(err)
    })
  )
}

Follows.prototype.getFollows = function (id, cb) {
  var follows = {}
  pull(
    this.contacts.createFollowsStream(id),
    pull.drain(function (feed) {
      follows[feed] = true
    }, function (err) {
      if (err) return cb(err)
      cb(null, follows)
    })
  )
}

Follows.prototype.close = function (cb) {
  this.sbot.close(cb)
}
