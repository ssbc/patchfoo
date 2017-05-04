var pull = require('pull-stream')
// var defer = require('pull-defer')
// var many = require('pull-many')
var multicb = require('multicb')
var u = require('./util')

module.exports = About

function About(sbot) {
  if (!(this instanceof About)) return new About(sbot)
  this.sbot = sbot
}

About.prototype.createAboutOpStream = function (id) {
  return pull(
    this.sbot.links({dest: id, rel: 'about', values: true, reverse: true}),
    pull.map(function (msg) {
      var c = msg.value.content || {}
      return Object.keys(c).filter(function (key) {
        return key !== 'about'
          && key !== 'type'
          && key !== 'recps'
      }).map(function (key) {
        var value = c[key]
        if (u.isRef(value)) value = {link: value}
        return {
          id: msg.key,
          author: msg.value.author,
          timestamp: msg.value.timestamp,
          prop: key,
          value: value,
          remove: value && typeof value === 'object' && value.remove,
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
        return op.author + '-' + op.prop + '-' + (op.value ? op.value.link : '')
      }),
      pull.filter(function (op) {
        return !op.remove
      })
    ),
    sets: u.readNext(setsDone)
  }
}
