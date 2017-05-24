var pull = require('pull-stream')
var paramap = require('pull-paramap')
var lru = require('hashlru')
var memo = require('asyncmemo')
var u = require('./util')
var packidx = require('pull-git-packidx-parser')
var Reader = require('pull-reader')
var toPull = require('stream-to-pull-stream')
var zlib = require('zlib')

module.exports = Git

function Git(app) {
  this.app = app
  this.findObject = memo({
    cache: false,
    asString: function (opts) {
      return opts.id + opts.headMsgId
    }
  }, this._findObject.bind(this))
}

Git.prototype.getObject = function (opts, cb) {
  pull(
    this.readObject(opts),
    u.pullConcat(cb)
  )
}

// get a message that pushed an object
Git.prototype.getObjectMsg = function (opts) {
  this.findObject(opts, function (err, loc) {
    if (err) return cb(err)
    cb(null, loc.msg)
  })
}

Git.prototype.readObject = function (opts) {
  var self = this
  return u.readNext(function (cb) {
    self.findObject(opts, function (err, loc) {
      if (err) return cb(err)
      self.app.ensureHasBlobs([loc.packLink], function (err) {
        if (err) return cb(err)
        cb(null, pull(
          self.app.readBlob(loc.packLink, {start: loc.offset, end: loc.next}),
          self.decodeObject({
            type: opts.type,
            length: opts.length,
            packLink: loc.packLink,
            idx: loc.idx,
          })
        ))
      })
    })
  })
}

// find which packfile contains a git object, and where in the packfile it is
// located
Git.prototype._findObject = function (opts, cb) {
  var self = this
  var objId = opts.id
  var objIdBuf = new Buffer(objId, 'hex')
  self.findObjectMsgs(opts, function (err, msgs) {
    if (err) return cb(err)
    if (msgs.length === 0)
      return cb(new Error('unable to find git object ' + objId))
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
          console.error('get idx', pack.idxLink)
          self.getPackIndex(pack.idxLink, function (err, idx) {
            if (err) return cb(err)
            var offset = idx.find(objIdBuf)
            // console.error('got idx', err, pack.idxId, offset)
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
            return cb(new Error('unable to find git object ' + objId +
              ' in ' + msgs.length + ' messages'))
          cb(null, offsets[0])
        })
      )
    })
  })
}

// given an object id and ssb msg id, get a set of messages of which at least one pushed the object.
Git.prototype.findObjectMsgs = function (opts, cb) {
  var self = this
  var id = opts.id
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
    console.error('get msg', id)
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
        // console.error('found', msg.key)
      } else if (!c.object_ids) {
        // the object might be here
        maybeMsgs.push(msg)
      }
      // traverse the DAG to keep looking for the object
      u.toArray(c.repoBranch).filter(u.isRef).forEach(getMsg)
      if (waiting === 0) {
        // console.error('trying messages', maybeMsgs.map(function (msg) { return msg.key}))
        cbOnce(null, maybeMsgs)
      }
    })
  })(headMsgId)
}

Git.prototype.getPackIndex = function (idxBlobLink, cb) {
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
      console.error('read from ref delta')
      reader.read(20, function (end, sourceHash) {
        if (end) return cb(end)
        var inflatedReader = Reader()
        pull(reader.read(), inflate, inflatedReader)
        readVarInt(inflatedReader, function (err, expectedSourceLength) {
          if (err) return cb(err)
          readVarInt(inflatedReader, function (err, expectedTargetLength) {
            if (err) return cb(err)
            // console.error('getting object', sourceHash)
            var offset = opts.idx.find(sourceHash)
            if (!offset) return cb(null, 'missing source object ' +
              sourcehash.toString('hex'))
            console.error('get pack', opts.packLink, offset.offset, offset.next)
            var readSource = pull(
              self.app.readBlob(opts.packLink, {
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
            // console.error('patching', length, expectedTargetLength)
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
  // console.error('patching', deltaLength, targetLength)

  return u.readNext(function (cb) {
    pull(readSource, u.pullConcat(function (err, buf) {
      if (err) return cb(err)
      srcBuf = buf
      cb(null, read)
    }))
  })

  function read(abort, cb) {
    // console.error('pa', abort, ended)
    if (ended) return cb(ended)
    deltaReader.read(1, function (end, dBuf) {
      // console.error("read", end, dBuf)
      // if (ended = end) return console.error('patched', deltaLength, targetLength, end),  cb(end)
      if (ended = end) return cb(end)
      var cmd = dBuf[0]
      // console.error('cmd', cmd & 0x80, cmd)
      if (cmd & 0x80)
        // skip a variable amount and then pass through a variable amount
        readOffsetSize(cmd, deltaReader, function (err, offset, size) {
        // console.error('offset', err, offset, size)
          if (err) return earlyEnd(err)
          var buf = srcBuf.slice(offset, offset + size)
        // console.error('buf', buf)
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

Git.prototype.getCommit = function (opts, cb) {
  this.getObject(opts, function (err, buf) {
    if (err) return cb(err)
    var commit = {
      body: buf.toString('ascii')
    }
    cb(null, commit)
  })
}
