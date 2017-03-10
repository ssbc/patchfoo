var h = require('hyperscript')
var htime = require('human-time')
var multicb = require('multicb')
var u = require('./util')
var mdInline = require('./markdown-inline')

module.exports = RenderMsg

function RenderMsg(render, app, msg, opts) {
  this.render = render
  this.app = app
  this.msg = msg
  var opts = opts || {}
  this.shouldWrap = opts.wrap !== false

  this.c = msg.value.content || {}
}

RenderMsg.prototype.toUrl = function (href) {
  return this.render.toUrl(href)
}

RenderMsg.prototype.linkify = function (text) {
  var arr = text.split(u.ssbRefRegex)
  for (var i = 1; i < arr.length; i += 2) {
    arr[i] = h('a', {href: this.toUrl(arr[i])}, arr[i])
  }
  return arr
}

function token() {
  return '__' + Math.random().toString(36).substr(2) + '__'
}

RenderMsg.prototype.raw = function (cb) {
  // linkify various things in the JSON. TODO: abstract this better

  // clone the message for linkifying
  var m = {}, k
  for (k in this.msg) m[k] = this.msg[k]
  m.value = {}
  for (k in this.msg.value) m.value[k] = this.msg.value[k]
  var tokens = {}

  // link to feed starting from this message
  if (m.value.sequence) {
    var tok = token()
    tokens[tok] = h('a', {href:
      this.toUrl(m.value.author + '?gt=' + (m.value.sequence-1))},
      m.value.sequence)
    m.value.sequence = tok
  }

  if (typeof m.value.content === 'object' && m.value.content != null) {
    var c = m.value.content = {}
    for (k in this.c) c[k] = this.c[k]

    // link to messages of same type
    tok = token()
    tokens[tok] = h('a', {href: this.toUrl('/type/' + c.type)}, c.type)
    c.type = tok

    // link to channel
    if (c.channel) {
      tok = token()
      tokens[tok] = h('a', {href: this.toUrl('#' + c.channel)}, c.channel)
      c.channel = tok
    }
  }

  // link refs
  var els = this.linkify(JSON.stringify(m, 0, 2))

  // stitch it all together
  for (var i = 0; i < els.length; i++) {
    if (typeof els[i] === 'string') {
      for (var tok in tokens) {
        if (els[i].indexOf(tok) !== -1) {
          var parts = els[i].split(tok)
          els.splice(i, 1, parts[0], tokens[tok], parts[1])
          continue
        }
      }
    }
  }
  this.wrap(h('pre', els), cb)
}

RenderMsg.prototype.wrap = function (content, cb) {
  if (!this.shouldWrap) return cb(null, content)
  var date = new Date(this.msg.value.timestamp)
  var self = this
  var channel = this.c.channel ? '#' + this.c.channel : ''
  var done = multicb({pluck: 1, spread: true})
  done()(null, [h('tr.msg-row',
    h('td.msg-left', {rowspan: 2},
      h('div', this.render.avatarImage(this.msg.value.author, done())),
      h('div', this.render.idLink(this.msg.value.author, done())),
      this.recpsLine(done())
    ),
    h('td.msg-main',
      h('div.msg-header',
        h('a.ssb-timestamp', {
          title: date.toLocaleString(),
          href: this.msg.key ? this.toUrl(this.msg.key) : undefined
        }, htime(date)), ' ',
        h('code', h('a.ssb-id',
          {href: this.toUrl(this.msg.key)}, this.msg.key)),
        channel ? [' ', h('a', {href: this.toUrl(channel)}, channel)] : '')),
    h('td.msg-right', this.msg.key ?
      h('form', {method: 'post', action: ''},
        this.msg.rel ? [this.msg.rel, ' '] : '',
        h('a', {href: this.toUrl(this.msg.key) + '?raw'}, 'raw'), ' ',
        this.voteFormInner('dig')
    ) : [
      this.msg.rel ? [this.msg.rel, ' '] : ''
    ])
  ), h('tr',
    h('td.msg-content', {colspan: 2},
      this.issues(done()),
      content)
  )])
  done(cb)
}

RenderMsg.prototype.wrapMini = function (content, cb) {
  if (!this.shouldWrap) return cb(null, content)
  var date = new Date(this.msg.value.timestamp)
  var self = this
  var channel = this.c.channel ? '#' + this.c.channel : ''
  var done = multicb({pluck: 1, spread: true})
  done()(null, h('tr.msg-row',
    h('td.msg-left',
      this.render.idLink(this.msg.value.author, done()), ' ',
      this.recpsLine(done()),
      channel ? [h('a', {href: this.toUrl(channel)}, channel), ' '] : ''),
    h('td.msg-main',
      h('a.ssb-timestamp', {
        title: date.toLocaleString(),
        href: this.msg.key ? this.toUrl(this.msg.key) : undefined
      }, htime(date)), ' ',
      this.issues(done()),
      content),
    h('td.msg-right', this.msg.key ?
      h('form', {method: 'post', action: ''},
        this.msg.rel ? [this.msg.rel, ' '] : '',
        h('a', {href: this.toUrl(this.msg.key) + '?raw'}, 'raw'), ' ',
        this.voteFormInner('dig')
    ) : [
      this.msg.rel ? [this.msg.rel, ' '] : ''
    ])
  ))
  done(cb)
}

RenderMsg.prototype.recpsLine = function (cb) {
  if (!this.msg.value.private) return cb(), ''
  var author = this.msg.value.author
  var recpsNotSelf = u.toArray(this.c.recps).filter(function (link) {
    return u.linkDest(link) !== author
  })
  return this.render.privateLine(recpsNotSelf, cb)
}

RenderMsg.prototype.recpsIds = function () {
  return this.msg.value.private
    ? u.toArray(this.c.recps).map(u.linkDest)
    : []
}

RenderMsg.prototype.voteFormInner = function (expression) {
  return [
    h('input', {type: 'hidden', name: 'action', value: 'vote'}),
    h('input', {type: 'hidden', name: 'recps',
      value: this.recpsIds().join(',')}),
    h('input', {type: 'hidden', name: 'link', value: this.msg.key}),
    h('input', {type: 'hidden', name: 'value', value: 1}),
    h('input', {type: 'submit', name: 'expression', value: expression})]
}

RenderMsg.prototype.message = function (raw, cb) {
  if (raw) return this.raw(cb)
  if (typeof this.c === 'string') return this.encrypted(cb)
  switch (this.c.type) {
    case 'post': return this.post(cb)
    case 'ferment/like':
    case 'robeson/like':
    case 'vote': return this.vote(cb)
    case 'about': return this.about(cb)
    case 'contact': return this.contact(cb)
    case 'pub': return this.pub(cb)
    case 'channel': return this.channel(cb)
    case 'git-repo': return this.gitRepo(cb)
    case 'git-update': return this.gitUpdate(cb)
    case 'pull-request': return this.gitPullRequest(cb)
    case 'issue': return this.issue(cb)
    case 'issue-edit': return this.issueEdit(cb)
    case 'music-release-cc': return this.musicRelease(cb)
    case 'ferment/audio':
    case 'robeson/audio':
      return this.audio(cb)
    case 'ferment/repost':
    case 'robeson/repost':
      return this.repost(cb)
    case 'ferment/update':
    case 'robeson/update':
      return this.update(cb)
    case 'wifi-network': return this.wifiNetwork(cb)
    default: return this.object(cb)
  }
}

RenderMsg.prototype.encrypted = function (cb) {
  this.wrapMini(this.render.lockIcon(), cb)
}

RenderMsg.prototype.markdown = function (cb) {
  return this.render.markdown(this.c.text, this.c.mentions)
}

RenderMsg.prototype.post = function (cb) {
  var self = this
  self.link(self.c.root, function (err, a) {
    if (err) return self.wrap(u.renderError(err), cb)
    self.wrap(h('div.ssb-post',
      a ? h('div', h('small', 're: ', a)) : '',
      h('div.ssb-post-text', {innerHTML: self.markdown()})
    ), cb)
  })
}

RenderMsg.prototype.vote = function (cb) {
  var self = this
  var v = self.c.vote || self.c.like || {}
  self.link(v, function (err, a) {
    if (err) return cb(err)
    self.wrapMini([
      v.value > 0 ? 'dug' : v.value < 0 ? 'downvoted' : 'undug', ' ', a], cb)
  })
}

RenderMsg.prototype.getName = function (id, cb) {
  switch (id && id[0]) {
    case '%': return this.getMsgName(id, cb)
    case '@': // fallthrough
    case '&': return this.getAboutName(id, cb)
    default: return cb(null, String(id))
  }
}

RenderMsg.prototype.getMsgName = function (id, cb) {
  var self = this
  self.app.getMsg(id, function (err, msg) {
    if (err && err.name == 'NotFoundError')
      cb(null, id.substring(0, 10)+'...(missing)')
    else if (err) cb(err)
      // preserve security: only decrypt the linked message if we decrypted
      // this message
    else if (self.msg.value.private) self.app.unboxMsg(msg, gotMsg)
    else gotMsg(null, msg)
  })
  function gotMsg(err, msg) {
    if (err) return cb(err)
    new RenderMsg(self.render, self.app, msg, {wrap: false}).title(cb)
  }
}

function truncate(str, len) {
  str = String(str)
  return str.length > len ? str.substr(0, len) + '...' : str
}

function title(str) {
  return truncate(mdInline(str), 40)
}

RenderMsg.prototype.title = function (cb) {
  var self = this
  if (typeof self.c.text === 'string') {
    if (self.c.type === 'post')
      cb(null, title(self.c.text))
    else
      cb(null, self.c.type + ':' + (self.c.title || title(self.c.text)))
  } else if (self.c.type === 'git-repo') {
    self.getAboutName(self.msg.key, cb)
  } else {
    self.message(false, function (err, el) {
      if (err) return cb(err)
      cb(null, title(h('div', el).textContent))
    })
  }
}

RenderMsg.prototype.getAboutName = function (id, cb) {
  this.app.getAbout(id, function (err, about) {
    cb(err, about && about.name)
  })
}

RenderMsg.prototype.link = function (link, cb) {
  var self = this
  var ref = u.linkDest(link)
  if (!ref) return cb(null, '')
  self.getName(ref, function (err, name) {
    if (err) return cb(err)
    cb(null, h('a', {href: self.toUrl(ref)}, name))
  })
}

RenderMsg.prototype.link1 = function (link, cb) {
  var self = this
  var ref = u.linkDest(link)
  if (!ref) return cb(), ''
  var a = h('a', {href: self.toUrl(ref)}, ref)
  self.getName(ref, function (err, name) {
    if (err) return cb(err)
    a.childNodes[0].textContent = name
    cb()
  })
  return a
}

RenderMsg.prototype.about = function (cb) {
  var img = u.linkDest(this.c.image)
  this.wrapMini([
    this.c.about === this.msg.value.author ? 'self-identifies' :
    ['identifies ', h('a', {href: this.toUrl(this.c.about)}, truncate(this.c.about, 10))],
    ' as ',
    this.c.name ? [h('ins', this.c.name), ' '] : '',
    this.c.description ? h('div', {innerHTML: this.c.description}) : h('br'),
    img ? h('a', {href: this.toUrl(img)},
      h('img.ssb-avatar-image', {
        src: this.render.imageUrl(img),
        alt: ' ',
      })) : ''
  ], cb)
}

RenderMsg.prototype.contact = function (cb) {
  var self = this
  self.link(self.c.contact, function (err, a) {
    if (err) return cb(err)
      self.wrapMini([
        self.c.following ? 'follows' :
        self.c.blocking ? 'blocks' :
        self.c.following === false ? 'unfollows' :
        self.c.blocking === false ? 'unblocks' : '',
      ' ', a], cb)
  })
}

RenderMsg.prototype.pub = function (cb) {
  var self = this
  var addr = self.c.address || {}
  self.link(addr.key, function (err, pubLink) {
    if (err) return cb(err)
      self.wrapMini([
        'connects to ', pubLink, ' at ',
        h('code', addr.host + ':' + addr.port)], cb)
  })
}

RenderMsg.prototype.channel = function (cb) {
  var chan = '#' + this.c.channel
  this.wrapMini([
    this.c.subscribed ? 'subscribes to ' :
    this.c.subscribed === false ? 'unsubscribes from ' : '',
    h('a', {href: this.toUrl(chan)}, chan)], cb)
}

RenderMsg.prototype.gitRepo = function (cb) {
  this.wrapMini([
    'git clone ',
    h('code', h('small', 'ssb://' + this.msg.key)),
      this.c.name ? [' ', h('a', {href: this.toUrl(this.msg.key)},
        this.c.name)] : ''
  ], cb)
}

RenderMsg.prototype.gitUpdate = function (cb) {
  var self = this
  // h('a', {href: self.toUrl(self.c.repo)}, 'ssb://' + self.c.repo),
  self.link(self.c.repo, function (err, a) {
    if (err) return cb(err)
      self.wrap(h('div.ssb-git-update',
        'git push ', a, ' ',
        self.c.refs ? h('ul', Object.keys(self.c.refs).map(function (ref) {
          var id = self.c.refs[ref]
        return h('li',
          ref.replace(/^refs\/(heads|tags)\//, ''), ': ',
          id ? h('code', id) : h('em', 'deleted'))
      })) : '',
      Array.isArray(self.c.commits) ?
        h('ul', self.c.commits.map(function (commit) {
          return h('li',
            h('code', String(commit.sha1).substr(0, 8)), ' ',
            self.linkify(String(commit.title)),
            self.gitCommitBody(commit.body)
          )
        })) : ''
    ), cb)
  })
}

RenderMsg.prototype.gitCommitBody = function (body) {
  if (!body) return ''
  var isMarkdown = !/^# Conflicts:$/m.test(body)
  return isMarkdown
    ? h('div', {innerHTML: this.render.markdown('\n' + body)})
    : h('pre', this.linkify('\n' + body))
}

RenderMsg.prototype.gitPullRequest = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  self.link(self.c.repo, done())
  self.link(self.c.head_repo, done())
  done(function (err, baseRepoLink, headRepoLink) {
    if (err) return cb(err)
    self.wrap(h('div.ssb-pull-request',
      'pull request ',
      'to ', baseRepoLink, ':', self.c.branch, ' ',
      'from ', headRepoLink, ':', self.c.head_branch,
      self.c.title ? h('h4', self.c.title) : '',
      h('div', {innerHTML: self.markdown()})), cb)
  })
}

RenderMsg.prototype.issue = function (cb) {
  var self = this
  self.link(self.c.project, function (err, projectLink) {
    if (err) return cb(err)
    self.wrap(h('div.ssb-issue',
      'issue on ', projectLink,
      self.c.title ? h('h4', self.c.title) : '',
      h('div', {innerHTML: self.markdown()})), cb)
  })
}

RenderMsg.prototype.issueEdit = function (cb) {
  this.wrap('', cb)
}

RenderMsg.prototype.object = function (cb) {
  this.wrapMini(h('pre', this.c.type), cb)
}

RenderMsg.prototype.issues = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  var issues = u.toArray(self.c.issues)
  if (self.c.type === 'issue-edit' && self.c.issue) {
    issues.push({
      link: self.c.issue,
      title: self.c.title,
      open: self.c.open,
    })
  }
  var els = issues.map(function (issue) {
    var commit = issue.object || issue.label ? [
      issue.object ? h('code', issue.object) : '', ' ',
      issue.label ? h('q', issue.label) : ''] : ''
    if (issue.merged === true)
      return h('div',
        'merged ', self.link1(issue, done()))
    if (issue.open === false)
      return h('div',
        'closed ', self.link1(issue, done()))
    if (issue.open === true)
      return h('div',
        'reopened ', self.link1(issue, done()))
    if (typeof issue.title === 'string')
      return h('div',
        'renamed ', self.link1(issue, done()), ' to ', h('ins', issue.title))
  })
  done(cb)
  return els.length > 0 ? [els, h('br')] : ''
}

RenderMsg.prototype.repost = function (cb) {
  var self = this
  var id = u.linkDest(self.c.repost)
  self.app.getMsg(id, function (err, msg) {
    if (err && err.name == 'NotFoundError')
      gotMsg(null, id.substring(0, 10)+'...(missing)')
    else if (err) gotMsg(err)
    else if (self.msg.value.private) self.app.unboxMsg(msg, gotMsg)
    else gotMsg(null, msg)
  })
  function gotMsg(err, msg) {
    if (err) return cb(err)
    var renderMsg = new RenderMsg(self.render, self.app, msg, {wrap: false})
      renderMsg.message(false, function (err, msgEl) {
        self.wrapMini(['reposted ',
          h('code.ssb-id',
            h('a', {href: self.render.toUrl(id)}, id)),
          h('div', err ? u.renderError(err) : msgEl || '')
        ], cb)
    })
  }
}

RenderMsg.prototype.update = function (cb) {
  var id = String(this.c.update)
  this.wrapMini([
    h('div', 'updated ', h('code.ssb-id',
      h('a', {href: this.render.toUrl(id)}, id))),
    this.c.title ? h('h4.msg-title', this.c.title) : '',
    this.c.description ? h('div',
      {innerHTML: this.render.markdown(this.c.description)}) : ''
  ], cb)
}

function formatDuration(s) {
  return Math.floor(s / 60) + ':' + ('0' + s % 60).substr(-2)
}

RenderMsg.prototype.audio = function (cb) {
  // fileName, fallbackFileName, overview
  this.wrap(h('table', h('tr',
    h('td',
      this.c.artworkSrc
      ? h('a', {href: this.render.toUrl(this.c.artworkSrc)}, h('img', {
          src: this.render.imageUrl(this.c.artworkSrc),
          alt: ' ',
          width: 72,
          height: 72,
        }))
      : ''),
    h('td',
      h('a', {href: this.render.toUrl(this.c.audioSrc)}, this.c.title),
      isFinite(this.c.duration)
        ? ' (' + formatDuration(this.c.duration) + ')'
        : '',
      this.c.description
        ? h('p', {innerHTML: this.render.markdown(this.c.description)})
        : ''
  ))), cb)
}

RenderMsg.prototype.musicRelease = function (cb) {
  var self = this
  this.wrap([
    h('table', h('tr',
      h('td',
        this.c.cover
          ? h('a', {href: this.render.imageUrl(this.c.cover)}, h('img', {
              src: this.render.imageUrl(this.c.cover),
              alt: ' ',
              width: 72,
              height: 72,
            }))
          : ''),
      h('td',
        h('h4.msg-title', this.c.title),
        this.c.text
          ? h('div', {innerHTML: this.render.markdown(this.c.text)})
          : ''
      )
    )),
    h('ul', u.toArray(this.c.tracks).filter(Boolean).map(function (track) {
      return h('li',
        h('a', {href: self.render.toUrl(track.link)}, track.fname))
    }))
  ], cb)
}

RenderMsg.prototype.wifiNetwork = function (cb) {
  var net = this.c.network || {}
  this.wrap([
    h('div', 'wifi network'),
    h('table',
      Object.keys(net).map(function (key) {
        return h('tr',
          h('td', key),
          h('td', h('pre', JSON.stringify(net[key]))))
      })
    ),
  ], cb)
}
