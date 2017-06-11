var pull = require('pull-stream')
var paramap = require('pull-paramap')
var lru = require('hashlru')
var memo = require('asyncmemo')
var u = require('./util')
var packidx = require('pull-git-packidx-parser')
var Reader = require('pull-reader')
var toPull = require('stream-to-pull-stream')
var zlib = require('zlib')
var looper = require('looper')
var multicb = require('multicb')
var kvdiff = require('pull-kvdiff')

var ObjectNotFoundError = u.customError('ObjectNotFoundError')

var types = {
  blob: true,
  commit: true,
  tree: true,
}
var emptyBlobHash = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'

module.exports = Git

function Git(app) {
  this.app = app

  this.findObject = memo({
    cache: lru(5),
    asString: function (opts) {
      return opts.obj + opts.headMsgId
    }
  }, this._findObject.bind(this))

  this.findObjectInMsg = memo({
    cache: lru(5),
    asString: function (opts) {
      return opts.obj + opts.msg
    }
  }, this._findObjectInMsg.bind(this))

  this.getPackIndex = memo({
    cache: lru(4),
    asString: JSON.stringify
  }, this._getPackIndex.bind(this))
}

// open, read, buffer and callback an object
Git.prototype.getObject = function (opts, cb) {
  var self = this
  self.openObject(opts, function (err, obj) {
    if (err) return cb(err)
    pull(
      self.readObject(obj),
      u.pullConcat(cb)
    )
  })
}

// get a message that pushed an object
Git.prototype.getObjectMsg = function (opts, cb) {
  this.findObject(opts, function (err, loc) {
    if (err) return cb(err)
    cb(null, loc.msg)
  })
}

Git.prototype.openObject = function (opts, cb) {
  var self = this
  self.findObjectInMsg(opts, function (err, loc) {
    if (err) return cb(err)
    self.app.ensureHasBlobs([loc.packLink], function (err) {
      if (err) return cb(err)
      cb(null, {
        type: opts.type,
        length: opts.length,
        offset: loc.offset,
        next: loc.next,
        packLink: loc.packLink,
        idx: loc.idx,
        msg: loc.msg,
      })
    })
  })
}

Git.prototype.readObject = function (obj) {
  if (obj.offset === obj.next) return pull.empty()
  return pull(
    this.app.readBlobSlice(obj.packLink, {start: obj.offset, end: obj.next}),
    this.decodeObject({
      type: obj.type,
      length: obj.length,
      packLink: obj.packLink,
      idx: obj.idx,
    })
  )
}

// find which packfile contains a git object, and where in the packfile it is
// located
Git.prototype._findObject = function (opts, cb) {
  if (!opts.headMsgId) return cb(new TypeError('missing head message id'))
  if (!opts.obj) return cb(new TypeError('missing object id'))
  var self = this
  var objId = opts.obj
  if (objId === emptyBlobHash) {
    // special case: the empty blob may be found anywhere
    self.app.getMsgDecrypted(opts.headMsgId, function (err, msg) {
      if (err) return cb(err)
      return cb(null, {
        offset: 0,
        next: 0,
        packLink: null,
        idx: null,
        msg: msg,
      })
    })
  }
  self.findObjectMsgs(opts, function (err, msgs) {
    if (err) return cb(err)
    if (msgs.length === 0)
      return cb(new ObjectNotFoundError('unable to find git object ' + objId))
    self.findObjectInMsgs(objId, msgs, cb)
  })
}

Git.prototype._findObjectInMsg = function (opts, cb) {
  if (!opts.msg) return cb(new TypeError('missing message id'))
  if (!opts.obj) return cb(new TypeError('missing object id'))
  var self = this
  self.app.getMsgDecrypted(opts.msg, function (err, msg) {
    if (err) return cb(err)
    self.findObjectInMsgs(opts.obj, [msg], cb)
  })
}

Git.prototype.findObjectInMsgs = function (objId, msgs, cb) {
  var self = this
  var objIdBuf = new Buffer(objId, 'hex')
  // if blobs may need to be fetched, try to ask the user about as many of them
  // at one time as possible
  var packidxs = [].concat.apply([], msgs.map(function (msg) {
    var c = msg.value.content
    var idxs = u.toArray(c.indexes).map(u.toLink)
    return u.toArray(c.packs).map(u.toLink).map(function (pack, i) {
      var idx = idxs[i]
      if (pack && idx) return {
        msg: msg,
        packLink: pack,
        idxLink: idx,
      }
    })
  })).filter(Boolean)
  var blobLinks = packidxs.length === 1
    ? [packidxs[0].idxLink, packidxs[0].packLink]
    : packidxs.map(function (packidx) {
      return packidx.idxLink
    })
  self.app.ensureHasBlobs(blobLinks, function (err) {
    if (err) return cb(err)
    pull(
      pull.values(packidxs),
      paramap(function (pack, cb) {
        self.getPackIndex(pack.idxLink, function (err, idx) {
          if (err) return cb(err)
          var offset = idx.find(objIdBuf)
          if (!offset) return cb()
          cb(null, {
            offset: offset.offset,
            next: offset.next,
            packLink: pack.packLink,
            idx: idx,
            msg: pack.msg,
          })
        })
      }, 4),
      pull.filter(),
      pull.take(1),
      pull.collect(function (err, offsets) {
        if (err) return cb(err)
        if (offsets.length === 0)
          return cb(new ObjectNotFoundError('unable to find git object '
            + objId + ' in ' + msgs.length + ' messages'))
        cb(null, offsets[0])
      })
    )
  })
}

// given an object id and ssb msg id, get a set of messages of which at least one pushed the object.
Git.prototype.findObjectMsgs = function (opts, cb) {
  var self = this
  var id = opts.obj
  var headMsgId = opts.headMsgId
  var ended = false
  var waiting = 0
  var maybeMsgs = []

  function cbOnce(err, msgs) {
    if (ended) return
    ended = true
    cb(err, msgs)
  }

  function objectMatches(commit) {
    return commit && (commit === id || commit.sha1 === id)
  }

  if (!headMsgId) return cb(new TypeError('missing head message id'))
  if (!u.isRef(headMsgId))
    return cb(new TypeError('bad head message id \'' + headMsgId + '\''))

  ;(function getMsg(id) {
    waiting++
    self.app.getMsgDecrypted(id, function (err, msg) {
      waiting--
      if (ended) return
      if (err && err.name == 'NotFoundError')
        return cbOnce(new Error('missing message ' + headMsgId))
      if (err) return cbOnce(err)
      var c = msg.value.content
      if (typeof c === 'string')
        return cbOnce(new Error('unable to decrypt message ' + msg.key))
      if ((u.toArray(c.object_ids).some(objectMatches))
      || (u.toArray(c.tags).some(objectMatches))
      || (u.toArray(c.commits).some(objectMatches))) {
        // found the object
        return cbOnce(null, [msg])
      } else if (!c.object_ids) {
        // the object might be here
        maybeMsgs.push(msg)
      }
      // traverse the DAG to keep looking for the object
      u.toArray(c.repoBranch).filter(u.isRef).forEach(getMsg)
      if (waiting === 0) {
        cbOnce(null, maybeMsgs)
      }
    })
  })(headMsgId)
}

Git.prototype._getPackIndex = function (idxBlobLink, cb) {
  pull(this.app.readBlob(idxBlobLink), packidx(cb))
}

var objectTypes = [
  'none', 'commit', 'tree', 'blob',
  'tag', 'unused', 'ofs-delta', 'ref-delta'
]

function readTypedVarInt(reader, cb) {
  var type, value, shift
  reader.read(1, function (end, buf) {
    if (ended = end) return cb(end)
    var firstByte = buf[0]
    type = objectTypes[(firstByte >> 4) & 7]
    value = firstByte & 15
    shift = 4
    checkByte(firstByte)
  })

  function checkByte(byte) {
    if (byte & 0x80)
      reader.read(1, gotByte)
    else
      cb(null, type, value)
  }

  function gotByte(end, buf) {
    if (ended = end) return cb(end)
    var byte = buf[0]
    value += (byte & 0x7f) << shift
    shift += 7
    checkByte(byte)
  }
}

function readVarInt(reader, cb) {
  var value = 0, shift = 0
  reader.read(1, function gotByte(end, buf) {
    if (ended = end) return cb(end)
    var byte = buf[0]
    value += (byte & 0x7f) << shift
    shift += 7
    if (byte & 0x80)
      reader.read(1, gotByte)
    else
      cb(null, value)
  })
}

function inflate(read) {
  return toPull(zlib.createInflate())(read)
}

Git.prototype.decodeObject = function (opts) {
  var self = this
  var packLink = opts.packLink
  return function (read) {
    var reader = Reader()
    reader(read)
    return u.readNext(function (cb) {
      readTypedVarInt(reader, function (end, type, length) {
        if (end === true) cb(new Error('Missing object type'))
        else if (end) cb(end)
        else if (type === 'ref-delta') getObjectFromRefDelta(length, cb)
        else if (opts.type && type !== opts.type)
          cb(new Error('expected type \'' + opts.type + '\' ' +
            'but found \'' + type + '\''))
        else if (opts.length && length !== opts.length)
          cb(new Error('expected length ' + opts.length + ' ' +
            'but found ' + length))
          else cb(null, inflate(reader.read()))
      })
    })

    function getObjectFromRefDelta(length, cb) {
      reader.read(20, function (end, sourceHash) {
        if (end) return cb(end)
        var inflatedReader = Reader()
        pull(reader.read(), inflate, inflatedReader)
        readVarInt(inflatedReader, function (err, expectedSourceLength) {
          if (err) return cb(err)
          readVarInt(inflatedReader, function (err, expectedTargetLength) {
            if (err) return cb(err)
            var offset = opts.idx.find(sourceHash)
            if (!offset) return cb(null, 'missing source object ' +
              sourcehash.toString('hex'))
            var readSource = pull(
              self.app.readBlobSlice(opts.packLink, {
                start: offset.offset,
                end: offset.next
              }),
              self.decodeObject({
                type: opts.type,
                length: expectedSourceLength,
                packLink: opts.packLink,
                idx: opts.idx
              })
            )
            cb(null, patchObject(inflatedReader, length, readSource, expectedTargetLength))
          })
        })
      })
    }
  }
}

function readOffsetSize(cmd, reader, readCb) {
  var offset = 0, size = 0

  function addByte(bit, outPos, cb) {
    if (cmd & (1 << bit))
      reader.read(1, function (err, buf) {
        if (err) readCb(err)
        else cb(buf[0] << (outPos << 3))
      })
    else
      cb(0)
  }

  addByte(0, 0, function (val) {
    offset = val
    addByte(1, 1, function (val) {
      offset |= val
      addByte(2, 2, function (val) {
        offset |= val
        addByte(3, 3, function (val) {
          offset |= val
          addSize()
        })
      })
    })
  })
  function addSize() {
    addByte(4, 0, function (val) {
      size = val
      addByte(5, 1, function (val) {
        size |= val
        addByte(6, 2, function (val) {
          size |= val
          readCb(null, offset, size || 0x10000)
        })
      })
    })
  }
}

function patchObject(deltaReader, deltaLength, readSource, targetLength) {
  var srcBuf
  var ended

  return u.readNext(function (cb) {
    pull(readSource, u.pullConcat(function (err, buf) {
      if (err) return cb(err)
      srcBuf = buf
      cb(null, read)
    }))
  })

  function read(abort, cb) {
    if (ended) return cb(ended)
    deltaReader.read(1, function (end, dBuf) {
      if (ended = end) return cb(end)
      var cmd = dBuf[0]
      if (cmd & 0x80)
        // skip a variable amount and then pass through a variable amount
        readOffsetSize(cmd, deltaReader, function (err, offset, size) {
          if (err) return earlyEnd(err)
          var buf = srcBuf.slice(offset, offset + size)
          cb(end, buf)
        })
      else if (cmd)
        // insert `cmd` bytes from delta
        deltaReader.read(cmd, cb)
      else
        cb(new Error("unexpected delta opcode 0"))
    })

    function earlyEnd(err) {
      cb(err === true ? new Error('stream ended early') : err)
    }
  }
}

var gitNameRegex = /^(.*) <(([^>@]*)(@[^>]*)?)> (.*) (.*)$/
function parseName(line) {
  var m = gitNameRegex.exec(line)
  if (!m) return null
  return {
    name: m[1],
    email: m[2],
    localpart: m[3],
    feed: u.isRef(m[4]) && m[4] || undefined,
    date: new Date(m[5] * 1000),
    tz: m[6],
  }
}

Git.prototype.getCommit = function (obj, cb) {
  pull(this.readObject(obj), u.pullConcat(function (err, buf) {
    if (err) return cb(err)
    var commit = {
      msg: obj.msg,
      parents: [],
    }
    var authorLine, committerLine
    var lines = buf.toString('utf8').split('\n')
    for (var line; (line = lines.shift()); ) {
      var parts = line.split(' ')
      var prop = parts.shift()
      var value = parts.join(' ')
      switch (prop) {
        case 'tree':
          commit.tree = value
          break
        case 'parent':
          commit.parents.push(value)
          break
        case 'author':
          authorLine = value
          break
        case 'committer':
          committerLine = value
          break
        case 'gpgsig':
          var sigLines = [value]
          while (lines[0] && lines[0][0] == ' ')
            sigLines.push(lines.shift().slice(1))
          commit.gpgsig = sigLines.join('\n')
          break
        default:
          return cb(new TypeError('unknown git object property ' + prop))
      }
    }
    commit.committer = parseName(committerLine)
    if (authorLine !== committerLine) commit.author = parseName(authorLine)
    commit.body = lines.join('\n')
    cb(null, commit)
  }))
}

Git.prototype.getTag = function (obj, cb) {
  pull(this.readObject(obj), u.pullConcat(function (err, buf) {
    if (err) return cb(err)
    var tag = {
      msg: obj.msg,
    }
    var authorLine, tagterLine
    var lines = buf.toString('utf8').split('\n')
    for (var line; (line = lines.shift()); ) {
      var parts = line.split(' ')
      var prop = parts.shift()
      var value = parts.join(' ')
      switch (prop) {
        case 'object':
          tag.object = value
          break
        case 'type':
          if (!types[value])
            return cb(new TypeError('unknown git object type ' + type))
          tag.type = value
          break
        case 'tag':
          tag.tag = value
          break
        case 'tagger':
          tag.tagger = parseName(value)
          break
        default:
          return cb(new TypeError('unknown git object property ' + prop))
      }
    }
    tag.body = lines.join('\n')
    cb(null, tag)
  }))
}

function readCString(reader, cb) {
  var chars = []
  var loop = looper(function () {
    reader.read(1, next)
  })
  function next(err, ch) {
    if (err) return cb(err)
    if (ch[0] === 0) return cb(null, Buffer.concat(chars).toString('utf8'))
    chars.push(ch)
    loop()
  }
  loop()
}

Git.prototype.readTree = function (obj) {
  var self = this
  var reader = Reader()
  reader(this.readObject(obj))
  return function (abort, cb) {
    if (abort) return reader.abort(abort, cb)
    readCString(reader, function (err, str) {
      if (err) return cb(err)
      var parts = str.split(' ')
      var mode = parseInt(parts[0], 8)
      var name = parts.slice(1).join(' ')
      reader.read(20, function (err, hash) {
        if (err) return cb(err)
        cb(null, {
          name: name,
          mode: mode,
          hash: hash.toString('hex'),
          type: mode === 0040000 ? 'tree' :
                mode === 0160000 ? 'commit' : 'blob',
        })
      })
    })
  }
}

Git.prototype.readCommitChanges = function (commit) {
  var self = this
  return u.readNext(function (cb) {
    var done = multicb({pluck: 1})
    commit.parents.forEach(function (rev) {
      var cb = done()
      self.getObjectMsg({
        obj: rev,
        headMsgId: commit.msg.key,
        type: 'commit',
      }, function (err, msg) {
        if (err) return cb(err)
        self.openObject({
          obj: rev,
          msg: msg.key,
        }, function (err, obj) {
          if (err) return cb(err)
          self.getCommit(obj, cb)
        })
      })
    })
    done()(null, commit)
    done(function (err, commits) {
      if (err) return cb(err)
      var done = multicb({pluck: 1})
      commits.forEach(function (commit) {
        var cb = done()
        if (!commit.tree) return cb(null, pull.empty())
        self.getObjectMsg({
          obj: commit.tree,
          headMsgId: commit.msg.key,
          type: 'tree',
        }, function (err, msg) {
          if (err) return cb(err)
          self.openObject({
            obj: commit.tree,
            msg: commit.msg.key,
          }, cb)
        })
      })
      done(function (err, trees) {
        if (err) return cb(err)
        cb(null, self.diffTreesRecursive(trees))
      })
    })
  })
}

Git.prototype.diffTrees = function (objs) {
  var self = this
  return pull(
    kvdiff(objs.map(function (obj) {
      return self.readTree(obj)
    }), 'name'),
    pull.map(function (item) {
      var diff = item.diff || {}
      var head = item.values[item.values.length-1]
      var created = true
      for (var k = 0; k < item.values.length-1; k++)
        if (item.values[k]) created = false
      return {
        name: item.key,
        hash: item.values.map(function (val) { return val.hash }),
        mode: diff.mode,
        type: item.values.map(function (val) { return val.type }),
        deleted: !head,
        created: created
      }
    })
  )
}

Git.prototype.diffTreesRecursive = function (objs) {
  var self = this
  return pull(
    self.diffTrees(objs),
    paramap(function (item, cb) {
      if (!item.type.some(function (t) { return t === 'tree' }))
        return cb(null, [item])
      var done = multicb({pluck: 1})
      item.type.forEach(function (type, i) {
        var cb = done()
        if (type !== 'tree') return cb(null, pull.once(item))
        var hash = item.hash[i]
        self.getObjectMsg({
          obj: hash,
          headMsgId: objs[i].msg.key,
        }, function (err, msg) {
          if (err) return cb(err)
          self.openObject({
            obj: hash,
            msg: msg.key,
          }, cb)
        })
      })
      done(function (err, objs) {
        if (err) return cb(err)
        cb(null, pull(
          self.diffTreesRecursive(objs),
          pull.map(function (f) {
            f.name = item.name + '/' + f.name
            return f
          })
        ))
      })
    }, 4),
    pull.flatten()
  )
}
