var pull = require('pull-stream')
var multicb = require('multicb')

function accumulateNonNull(a, b) {
  return b == null ? a : b
}

module.exports = function (sbot, id, cb) {
  var followed = {}, followedBy = {}, blocked = {}, blockedBy = {}
  var done = multicb({pluck: 1})
  pull(
    sbot.links2.read({
      reverse: true, // oldest first. ssb-links has this switched
      query: [
        {$filter: {
          source: id,
          rel: [{$prefix: 'contact'}]
        }},
        {$reduce: {
          id: 'dest',
          following: {$collect: ['rel', 1]},
          blocking: {$collect: ['rel', 2]}
        }}
      ]
    }),
    pull.drain(function (op) {
      var following = op.following.reduce(accumulateNonNull, null)
      var blocking = op.blocking.reduce(accumulateNonNull, null)
      if (following != null) followed[op.id] = following
      if (blocking != null) blocked[op.id] = blocking
    }, done())
  )
  pull(
    sbot.links2.read({
      reverse: true, // oldest first. ssb-links has this switched
      query: [
        {$filter: {
          dest: id,
          rel: [{$prefix: 'contact'}]
        }},
        {$reduce: {
          id: 'source',
          following: {$collect: ['rel', 1]},
          blocking: {$collect: ['rel', 2]}
        }}
      ]
    }),
    pull.drain(function (op) {
      var following = op.following.reduce(accumulateNonNull, null)
      var blocking = op.blocking.reduce(accumulateNonNull, null)
      if (following != null) followedBy[op.id] = following
      if (blocking != null) blockedBy[op.id] = blocking
    }, done())
  )

  done(function (err) {
    if (err) return cb(new Error(err.stack || err))
    var id
    var friendsList = []
    var followingList = []
    var blockingList = []
    var followedByList = []
    var blockedByList = []

    for (id in followed) {
      if (followed[id]) {
        if (followedBy[id]) friendsList.push(id)
        else followingList.push(id)
      }
    }
    for (id in followedBy) {
      if (followedBy[id] && !followed[id]) {
        followedByList.push(id)
      }
    }
    for (id in blocked) {
      if (blocked[id]) blockingList.push(id)
    }
    for (id in blockedBy) {
      if (blockedBy[id]) blockedByList.push(id)
    }

    cb(null, {
      follows: followingList,
      followers: followedByList,
      friends: friendsList,
      blocks: blockingList,
      blockers: blockedByList
    })
  })
}
