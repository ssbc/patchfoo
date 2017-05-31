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
  this.value = msg && msg.value || {}
  var content = this.value.content
  this.c = content || {}
  this.isMissing = !content

  if (typeof opts === 'boolean') opts = {raw: opts}
  this.opts = opts || {}
  this.shouldWrap = this.opts.wrap !== false
}

RenderMsg.prototype.toUrl = function (href) {
  return this.render.toUrl(href)
}

RenderMsg.prototype.linkify = function (text) {
  return this.render.linkify(text)
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
    h('td.msg-right', this.actions())
  ), h('tr',
    h('td.msg-content', {colspan: 2},
      this.issues(done()),
      content)
  )])
  done(cb)
}

RenderMsg.prototype.wrapMini = function (content, cb) {
  if (!this.shouldWrap) return cb(null, content)
  var date = new Date(this.value.timestamp)
  var self = this
  var channel = this.c.channel ? '#' + this.c.channel : ''
  var done = multicb({pluck: 1, spread: true})
  done()(null, h('tr.msg-row',
    h('td.msg-left',
      this.render.idLink(this.value.author, done()), ' ',
      this.recpsLine(done()),
      channel ? [h('a', {href: this.toUrl(channel)}, channel), ' '] : ''),
    h('td.msg-main',
      h('a.ssb-timestamp', {
        title: date.toLocaleString(),
        href: this.msg.key ? this.toUrl(this.msg.key) : undefined
      }, htime(date)), ' ',
      this.issues(done()),
      content),
    h('td.msg-right', this.actions())
  ))
  done(cb)
}

RenderMsg.prototype.actions = function () {
  return this.msg.key ?
    h('form', {method: 'post', action: ''},
      this.msg.rel ? [this.msg.rel, ' '] : '',
      this.opts.withGt && this.msg.timestamp ? [
        h('a', {href: '?gt=' + this.msg.timestamp}, '↓'), ' '] : '',
      this.c.type === 'gathering' ? [
        h('a', {href: this.render.toUrl('/about/' + encodeURIComponent(this.msg.key))}, 'about'), ' '] : '',
      h('a', {href: this.toUrl(this.msg.key) + '?raw'}, 'raw'), ' ',
      this.buttonsCommon(),
      this.c.type === 'gathering' ? [this.attendButton(), ' '] : '',
      this.voteButton('dig')
  ) : [
    this.msg.rel ? [this.msg.rel, ' '] : ''
  ]
}

RenderMsg.prototype.sync = function (cb) {
  cb(null, h('tr.msg-row', h('td', {colspan: 3},
    h('hr')
  )))
}

RenderMsg.prototype.recpsLine = function (cb) {
  if (!this.value.private) return cb(), ''
  var author = this.value.author
  var recpsNotSelf = u.toArray(this.c.recps).filter(function (link) {
    return u.linkDest(link) !== author
  })
  return this.render.privateLine(recpsNotSelf, cb)
}

RenderMsg.prototype.recpsIds = function () {
  return this.value.private
    ? u.toArray(this.c.recps).map(u.linkDest)
    : []
}

RenderMsg.prototype.buttonsCommon = function () {
  var chan = this.msg.value.content.channel
  var recps = this.recpsIds()
  return [
    chan ? h('input', {type: 'hidden', name: 'channel', value: chan}) : '',
    h('input', {type: 'hidden', name: 'link', value: this.msg.key}),
    h('input', {type: 'hidden', name: 'recps', value: recps.join(',')})
  ]
}

RenderMsg.prototype.voteButton = function (expression) {
  var chan = this.msg.value.content.channel
  return [
    h('input', {type: 'hidden', name: 'vote_value', value: 1}),
    h('input', {type: 'hidden', name: 'vote_expression', value: expression}),
    h('input', {type: 'submit', name: 'action_vote', value: expression})]
}

RenderMsg.prototype.attendButton = function () {
  var chan = this.msg.value.content.channel
  return [
    h('input', {type: 'submit', name: 'action_attend', value: 'attend'})
  ]
}

RenderMsg.prototype.message = function (cb) {
  if (this.opts.raw) return this.raw(cb)
  if (this.msg.sync) return this.sync(cb)
  if (typeof this.c === 'string') return this.encrypted(cb)
  if (this.isMissing) return this.missing(cb)
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
    case 'ssb-dns': return this.dns(cb)
    case 'gathering': return this.gathering(cb)
    case 'micro': return this.micro(cb)
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
    case 'mutual/credit': return this.mutualCredit(cb)
    case 'mutual/account': return this.mutualAccount(cb)
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
  var done = multicb({pluck: 1, spread: true})
  var branchDone = multicb({pluck: 1})
  u.toArray(self.c.branch).forEach(function (branch) {
    self.link(branch, branchDone())
  })
  if (self.c.root === self.c.branch) done()()
  else self.link(self.c.root, done())
  branchDone(done())
  done(function (err, rootLink, branchLinks) {
    if (err) return self.wrap(u.renderError(err), cb)
    self.wrap(h('div.ssb-post',
      rootLink ? h('div', h('small', '>> ', rootLink)) : '',
      branchLinks.map(function (a, i) {
        return h('div', h('small', '> ', a))
      }),
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
      v.value > 0 ? 'dug' : v.value < 0 ? 'downvoted' : 'undug',
      ' ', a,
      v.reason ? [' as ', h('q', v.reason)] : ''
    ], cb)
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
  return truncate(mdInline(str), 72)
}

RenderMsg.prototype.title = function (cb) {
  var self = this
  if (!self.c || typeof self.c !== 'object') {
    cb(null, self.msg.key)
  } else if (typeof self.c.text === 'string') {
    if (self.c.type === 'post')
      cb(null, title(self.c.text))
    else
      cb(null, '%' + self.c.type + ': ' + (self.c.title || title(self.c.text)))
  } else {
    if (self.c.type === 'ssb-dns')
      cb(null, self.c.record && JSON.stringify(self.c.record.data) || self.msg.key)
    else
    self.app.getAbout(self.msg.key, function (err, about) {
      if (err) return cb(err)
      var name = about.name || about.title || about.description
      if (name) return cb(null, name)
      self.message(function (err, el) {
        if (err) return cb(err)
        cb(null, '%' + title(h('div', el).textContent))
      })
    })
  }
}

RenderMsg.prototype.getAboutName = function (id, cb) {
  this.app.getAbout(id, function (err, about) {
    cb(err, about && about.name || (String(id).substr(0, 8) + '…'))
  })
}

RenderMsg.prototype.link = function (link, cb) {
  var self = this
  var ref = u.linkDest(link)
  if (!ref) return cb(null, '')
  self.getName(ref, function (err, name) {
    if (err) name = truncate(ref, 10)
    cb(null, h('a', {href: self.toUrl(ref)}, name))
  })
}

RenderMsg.prototype.link1 = function (link, cb) {
  var self = this
  var ref = u.linkDest(link)
  if (!ref) return cb(), ''
  var a = h('a', {href: self.toUrl(ref)}, ref)
  self.getName(ref, function (err, name) {
    if (err) name = ref
    a.childNodes[0].textContent = name
    cb()
  })
  return a
}

function dateTime(d) {
  var date = new Date(d.epoch)
  return date.toString()
  // d.bias
  // d.epoch
}

RenderMsg.prototype.about = function (cb) {
  var img = u.linkDest(this.c.image)
  var done = multicb({pluck: 1, spread: true})
  var elCb = done()
  // if there is a description, it is likely to be multi-line
  var hasDescription = this.c.description != null
  var wrap = hasDescription ? this.wrap : this.wrapMini
  var isSelf = this.c.about === this.msg.value.author
  // if this about message gives the thing a name, show its id
  var showComputedName = !isSelf && !this.c.name

  wrap.call(this, [
    isSelf
      ? hasDescription ? 'self-describes' : 'self-identifies'
      : [hasDescription ? 'describes' : 'identifies', ' ',
        !this.c.about ? '?'
        : showComputedName ? this.link1(this.c.about, done())
        : h('a', {href: this.toUrl(this.c.about)}, truncate(this.c.about, 10))
      ],
    ' as ',
    this.c.name ? [h('ins', this.c.name), ' '] : '',
    this.c.description ? h('div',
      {innerHTML: this.render.markdown(this.c.description)}) : '',
    this.c.title ? h('h3', this.c.title) : '',
    this.c.attendee ? h('div',
      this.link1(this.c.attendee.link, done()),
      this.c.attendee.remove ? ' is not attending' : ' is attending'
    ) : '',
    this.c.startDateTime ? h('div',
      'starting at ', dateTime(this.c.startDateTime)) : '',
    this.c.endDateTime ? h('div',
      'ending at ', dateTime(this.c.endDateTime)) : '',
    this.c.location ? h('div', 'at ', this.c.location) : '',
    img ? h('a', {href: this.toUrl(img)},
      h('img.ssb-avatar-image', {
        src: this.render.imageUrl(img),
        alt: ' ',
      })) : ''
  ], elCb)
  done(cb)
}

RenderMsg.prototype.contact = function (cb) {
  var self = this
  self.link(self.c.contact, function (err, a) {
    if (err) return cb(err)
    if (!a) a = "?"
      self.wrapMini([
        self.c.following && self.c.autofollow ? 'follows pub' :
        self.c.following && self.c.pub ? 'autofollows' :
        self.c.following ? 'follows' :
        self.c.blocking ? 'blocks' :
        self.c.flagged ? 'flagged' :
        self.c.following === false ? 'unfollows' :
        self.c.blocking === false ? 'unblocks' : '',
        self.c.flagged === false ? 'unflagged' :
        ' ', a,
        self.c.note ? [
          ' from ',
          h('code', self.c.note)
        ] : '',
      ], cb)
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
  var self = this
  var id = self.msg.key
  var name = self.c.name
  var upstream = self.c.upstream
  self.link(upstream, function (err, upstreamA) {
    if (err) upstreamA = ('a', {href: self.toUrl(upstream)}, String(name))
    self.wrapMini([
      upstream ? ['forked ', upstreamA, ': '] : '',
      'git clone ',
      h('code', h('small', 'ssb://' + id)),
      name ? [' ', h('a', {href: self.toUrl(id)}, String(name))] : ''
    ], cb)
  })
}

RenderMsg.prototype.gitUpdate = function (cb) {
  var self = this
  // h('a', {href: self.toUrl(self.c.repo)}, 'ssb://' + self.c.repo),
  var size = [].concat(self.c.packs, self.c.indexes)
    .map(function (o) { return o && o.size })
    .reduce(function (total, s) { return total + s })
  self.link(self.c.repo, function (err, a) {
    if (err) return cb(err)
      self.wrap(h('div.ssb-git-update',
        'git push ', a, ' ',
        !isNaN(size) ? [self.render.formatSize(size), ' '] : '',
        self.c.refs ? h('ul', Object.keys(self.c.refs).map(function (ref) {
          var id = self.c.refs[ref]
          var type = /^refs\/tags/.test(ref) ? 'tag' : 'commit'
          var path = id && ('/git/' + type + '/' + encodeURIComponent(id)
            + '?msg=' + encodeURIComponent(self.msg.key))
          return h('li',
            ref.replace(/^refs\/(heads|tags)\//, ''), ': ',
            id ? h('a', {href: self.render.toUrl(path)}, h('code', id))
               : h('em', 'deleted'))
      })) : '',
      Array.isArray(self.c.commits) ?
        h('ul', self.c.commits.map(function (commit) {
          var path = '/git/commit/' + encodeURIComponent(commit.sha1)
            + '?msg=' + encodeURIComponent(self.msg.key)
          return h('li', h('a', {href: self.render.toUrl(path)},
            h('code', String(commit.sha1).substr(0, 8))), ' ',
            self.linkify(String(commit.title)),
            self.gitCommitBody(commit.body)
          )
        })) : '',
      Array.isArray(self.c.tags) ?
        h('ul', self.c.tags.map(function (tag) {
          var path = '/git/tag/' + encodeURIComponent(tag.sha1)
            + '?msg=' + encodeURIComponent(self.msg.key)
          return h('li',
            h('a', {href: self.render.toUrl(path)},
              h('code', String(tag.sha1).substr(0, 8))), ' ',
            'tagged ', String(tag.type), ' ',
            h('code', String(tag.object).substr(0, 8)), ' ',
            String(tag.tag)
          )
        })) : '',
        self.c.commits_more ? h('div',
          '+ ' + self.c.commits_more + ' more commits') : '',
        self.c.tags_more ? h('div',
          '+ ' + self.c.tags_more + ' more tags') : ''
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
  this.wrap(h('pre', this.linkify(JSON.stringify(this.c, 0, 2))), cb)
}

RenderMsg.prototype.object = function (cb) {
  var done = multicb({pluck: 1, spread: true})
  var elCb = done()
  this.wrap([
    this.valueTable(this.c, done()),
  ], elCb)
  done(cb)
}

RenderMsg.prototype.valueTable = function (val, cb) {
  var self = this
  switch (typeof val) {
    case 'object':
      if (val === null) return cb(), ''
      var done = multicb({pluck: 1, spread: true})
      var el = Array.isArray(val)
        ? h('ul', val.map(function (item) {
          return h('li', self.valueTable(item, done()))
        }))
        : h('table.ssb-object', Object.keys(val).map(function (key) {
          if (key === 'text') {
            return h('tr',
              h('td', h('strong', 'text')),
              h('td', h('div', {
                innerHTML: self.render.markdown(val.text, val.mentions)
              }))
            )
          } else if (key === 'type') {
            var type = val.type
            return h('tr',
              h('td', h('strong', 'type')),
              h('td', h('a', {href: self.toUrl('/type/' + type)}, type))
            )
          }
          return h('tr',
            h('td', h('strong', key)),
            h('td', self.valueTable(val[key], done()))
          )
        }))
      done(cb)
      return el
    case 'string':
      if (u.isRef(val)) return self.link1(val, cb)
      return cb(), self.linkify(val)
    case 'boolean':
      return cb(), h('input', {
        type: 'checkbox', disabled: 'disabled', checked: val
      })
    default:
      return cb(), String(val)
  }
}

RenderMsg.prototype.missing = function (cb) {
  this.wrapMini(h('code', 'MISSING'), cb)
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
      renderMsg.message(function (err, msgEl) {
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

RenderMsg.prototype.dns = function (cb) {
  var self = this
  var record = self.c.record || {}
  var done = multicb({pluck: 1, spread: true})
  var elCb = done()
  self.wrap([
    h('div',
      h('p',
        h('ins', {title: 'name'}, record.name), ' ',
        h('span', {title: 'ttl'}, record.ttl), ' ',
        h('span', {title: 'class'}, record.class), ' ',
        h('span', {title: 'type'}, record.type)
      ),
      h('pre', {title: 'data'},
        JSON.stringify(record.data || record.value, null, 2)),
      !self.c.branch ? null : h('div',
        'replaces: ', u.toArray(self.c.branch).map(function (id, i) {
          return [self.link1(id, done()), i === 0 ? ', ' : '']
        })
      )
    )
  ], elCb)
  done(cb)
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

RenderMsg.prototype.mutualCredit = function (cb) {
  var self = this
  self.link(self.c.account, function (err, a) {
    if (err) return cb(err)
    self.wrapMini([
      'credits ', a || '?', ' ',
      self.c.amount, ' ', self.c.currency,
      self.c.memo ? [' for ', h('q', self.c.memo)] : ''
    ], cb)
  })
}

RenderMsg.prototype.mutualAccount = function (cb) {
  return this.object(cb)
}

RenderMsg.prototype.gathering = function (cb) {
  this.wrapMini('gathering', cb)
}

function unwrapP(html) {
  return String(html).replace(/^<p>(.*)<\/p>\s*$/, function ($0, $1) {
    return $1
  })
}

RenderMsg.prototype.micro = function (cb) {
  var el = h('span', {innerHTML: unwrapP(this.markdown())})
  this.wrapMini(el, cb)
}
