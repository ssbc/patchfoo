var pull = require('pull-stream')
var multicb = require('multicb')
var cat = require('pull-cat')
var u = require('./util')

module.exports = About

function About(app, myId) {
  this.app = app
  this.myId = myId
}

About.prototype.createAboutOpStream = function (id) {
  return pull(
    this.app.sbot.links({dest: id, rel: 'about', values: true, reverse: true}),
    pull.map(function (msg) {
      var c = msg.value.content || {}
      return Object.keys(c).filter(function (key) {
        return key !== 'about'
          && key !== 'type'
          && key !== 'recps'
      }).map(function (key) {
        var value = c[key]
        return {
          id: msg.key,
          author: msg.value.author,
          timestamp: msg.value.timestamp,
          prop: key,
          value: value,
          remove: value && value.remove,
        }
      })
    }),
    pull.flatten()
  )
}

About.prototype.createAboutStreams = function (id) {
  var ops = this.createAboutOpStream(id)
  var scalars = {/* author: {prop: value} */}
  var sets = {/* author: {prop: {link}} */}

  var setsDone = multicb({pluck: 1, spread: true})
  setsDone()(null, pull.values([]))
  return {
    scalars: pull(
      ops,
      pull.unique(function (op) {
        return op.author + '-' + op.prop + '-'
      }),
      pull.filter(function (op) {
        return !op.remove
      })
    ),
    sets: u.readNext(setsDone)
  }
}

function computeTopAbout(aboutByFeed) {
  var propValueCounts = {/* prop: {value: count} */}
  var topValues = {/* prop: value */}
  var topValueCounts = {/* prop: count */}
  for (var feed in aboutByFeed) {
    var feedAbout = aboutByFeed[feed]
    for (var prop in feedAbout) {
      var value = feedAbout[prop]
      var valueCounts = propValueCounts[prop] || (propValueCounts[prop] = {})
      var count = (valueCounts[value] || 0) + 1
      valueCounts[value] = count
      if (count > (topValueCounts[prop] || 0)) {
        topValueCounts[prop] = count
        topValues[prop] = value
      }
    }
  }
  return topValues
}

About.prototype.get = function (dest, cb) {
  var self = this
  var aboutByFeed = {}
  pull(
    cat([
      dest[0] === '%' && self.app.pullGetMsg(dest),
      self.app.sbot.links({
        rel: 'about',
        dest: dest,
        values: true,
      })
    ]),
    self.app.unboxMessages(),
    pull.drain(function (msg) {
      var author = msg.value.author
      var c = msg.value.content
      if (!c) return
      var about = aboutByFeed[author] || (aboutByFeed[author] = {})
      if (c.name) about.name = c.name
      if (c.title) about.title = c.title
      if (c.image) about.image = u.linkDest(c.image)
      if (c.description) about.description = c.description
    }, function (err) {
      if (err) return cb(err)
      // bias the author's choices by giving them an extra vote
      aboutByFeed._author = aboutByFeed[dest]
      var about = {}
      var myAbout = aboutByFeed[self.myId] || {}
      var topAbout = computeTopAbout(aboutByFeed)
      for (var k in topAbout) about[k] = topAbout[k]
      // always prefer own choices
      for (var k in myAbout) about[k] = myAbout[k]
      cb(null, about)
    })
  )
}
