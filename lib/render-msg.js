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
  this.serve = opts.serve
  this.value = msg && msg.value || {}
  var content = this.value.content
  this.c = content || {}
  this.isMissing = !content

  if (typeof opts === 'boolean') opts = {raw: opts}
  this.opts = opts || {}
  this.shouldWrap = this.opts.wrap !== false
}

RenderMsg.prototype.getMsg = function (id, cb) {
  if (!id) return cb()
  return this.serve
    ? this.serve.getMsgDecryptedMaybeOoo(id, cb)
    : this.app.getMsgDecryptedOoo(id, cb)
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

    // link to hashtags
    // TODO: recurse
    for (var k in c) {
      if (!c[k] || c[k][0] !== '#') continue
      tok = token()
      tokens[tok] = h('a', {href: this.toUrl(c[k])}, c[k])
      c[k] = tok
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
    h('td.msg-left',
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
    h('td.msg-content', {colspan: 3},
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
      /^(ssb_)?chess_/.test(this.c.type) ? [
        h('a', {href: this.toUrl(this.msg.key) + '?full',
          title: 'view full game board'}, 'full'), ' '] : '',
      typeof this.c.text === 'string' ? [
        h('a', {href: this.toUrl(this.msg.key) + '?raw=md',
          title: 'view markdown source'}, 'md'), ' '] : '',
      h('a', {href: this.toUrl(this.msg.key) + '?raw',
        title: 'view raw message'}, 'raw'), ' ',
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
    case 'chess_invite':
    case 'ssb_chess_invite':
      return this.chessInvite(cb)
    case 'chess_invite_accept':
    case 'ssb_chess_invite_accept':
      return this.chessInviteAccept(cb)
    case 'chess_move':
    case 'ssb_chess_move':
      return this.chessMove(cb)
    case 'chess_game_end':
    case 'ssb_chess_game_end':
      return this.chessGameEnd(cb)
    case 'chess_chat':
      return this.chessChat(cb)
    case 'wifi-network': return this.wifiNetwork(cb)
    case 'mutual/credit': return this.mutualCredit(cb)
    case 'mutual/account': return this.mutualAccount(cb)
    case 'npm-publish': return this.npmPublish(cb)
    case 'npm-packages': return this.npmPackages(cb)
    case 'npm-prebuilds': return this.npmPrebuilds(cb)
    case 'acme-challenges-http-01': return this.acmeChallengesHttp01(cb)
    case 'bookclub': return this.bookclub(cb)
    case 'macaco_maluco-sombrio-wall': return this.sombrioWall(cb)
    case 'macaco_maluco-sombrio-tombstone': return this.sombrioTombstone(cb)
    case 'macaco_maluco-sombrio-score': return this.sombrioScore(cb)
    case 'blog': return this.blog(cb)
    case 'image-map': return this.imageMap(cb)
    case 'talenet-identity-skill_assignment': return this.identitySkillAssign(cb)
    case 'talenet-idea-skill_assignment': return this.ideaSkillAssign(cb)
    case 'talenet-idea-create': return this.ideaCreate(cb)
    case 'talenet-idea-association': return this.ideaAssocate(cb)
    case 'talenet-skill-create': return this.skillCreate(cb)
    case 'talenet-idea-hat': return this.ideaHat(cb)
    case 'talenet-idea-update': return this.ideaUpdate(cb)
    case 'talenet-idea-comment':
    case 'talenet-idea-comment_reply': return this.ideaComment(cb)
    case 'about-resource': return this.aboutResource(cb)
    case 'line-comment': return this.lineComment(cb)
    default: return this.object(cb)
  }
}

RenderMsg.prototype.encrypted = function (cb) {
  this.wrapMini(this.render.lockIcon(), cb)
}

RenderMsg.prototype.markdown = function (cb) {
  if (this.opts.markdownSource)
    return this.markdownSource(this.c.text, this.c.mentions)
  return this.render.markdown(this.c.text, this.c.mentions)
}

RenderMsg.prototype.markdownSource = function (text, mentions) {
  return h('div',
    h('pre', String(text)),
    mentions ? [
      h('div', h('em', 'mentions:')),
      this.valueTable(mentions, 2, function () {})
    ] : ''
  ).innerHTML
}

RenderMsg.prototype.post = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  if (self.c.root === self.c.branch) done()()
  else self.link(self.c.root, done())
  self.links(self.c.branch, done())
  self.links(self.c.fork, done())
  done(function (err, rootLink, branchLinks, forkLinks) {
    if (err) return self.wrap(u.renderError(err), cb)
    self.wrap(h('div.ssb-post',
      rootLink ? h('div', h('small', h('span.symbol', '→'), ' ', rootLink)) : '',
      branchLinks.map(function (a, i) {
        return h('div', h('small', h('span.symbol', '  ↳'), ' ', a))
      }),
      forkLinks.map(function (a, i) {
        return h('div', h('small', h('span.symbol', '⑂'), ' ', a))
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
  self.app.filterMsg(self.msg, self.opts, function (err, show) {
    if (err) return cb(err)
    if (show) self.title1(cb)
    else cb(null, '[…]')
  })
}

RenderMsg.prototype.title1 = function (cb) {
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
    else if (self.c.type === 'npm-publish')
      self.npmPublishTitle(cb)
    else if (self.c.type === 'chess_chat')
      cb(null, title(self.c.msg))
    else if (self.c.type === 'chess_invite')
      self.chessInviteTitle(cb)
    else if (self.c.type === 'bookclub')
      self.bookclubTitle(cb)
    else if (self.c.type === 'talenet-skill-create' && self.c.name)
      cb(null, self.c.name)
    else if (self.c.type === 'talenet-idea-create')
      self.app.getIdeaTitle(self.msg.key, cb)
    else
    self.app.getAbout(self.msg.key, function (err, about) {
      if (err) return cb(err)
      var name = about.name || about.title
        || (about.description && mdInline(about.description))
      if (name) return cb(null, truncate(name, 72))
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

RenderMsg.prototype.links = function (links, cb) {
  var self = this
  var done = multicb({pluck: 1})
  u.toArray(links).forEach(function (link) {
    self.link(link, done())
  })
  done(cb)
}

function dateTime(d) {
  var date = new Date(d.epoch)
  return date.toString()
  // d.bias
  // d.epoch
}

// TODO: make more DRY
var knownAboutProps = {
  type: true,
  root: true,
  about: true,
  attendee: true,
  about: true,
  image: true,
  description: true,
  name: true,
  title: true,
  attendee: true,
  startDateTime: true,
  endDateTime: true,
  location: true,
  /*
  rating: true,
  ratingType: true,
  */
  'talenet-version': true,
}

RenderMsg.prototype.about = function (cb) {
  var keys = Object.keys(this.c).sort().join()
  var isSelf = this.c.about === this.msg.value.author

  if (keys === 'about,name,type') {
    return this.wrapMini([
      isSelf ?
        'self-identifies as ' :
        ['identifies ', h('a', {href: this.toUrl(this.c.about)}, truncate(this.c.about, 10)), ' as '],
      h('ins', this.c.name)
    ], cb)
  }

  if (keys === 'about,publicWebHosting,type') {
    var public = this.c.publicWebHosting && this.c.publicWebHosting !== 'false'
    return this.wrapMini([
      isSelf ?
        public ? 'is okay with being hosted publicly'
        : 'wishes to not to be hosted publicly'
      : public ? ['thinks ', h('a', {href: this.toUrl(this.c.about)}, truncate(this.c.about, 10)),
          ' should be hosted publicly ']
        : ['wishes ', h('a', {href: this.toUrl(this.c.about)}, truncate(this.c.about, 10)),
          ' to not be hosted publicly']
    ], cb)
  }

  var done = multicb({pluck: 1, spread: true})
  var elCb = done()

  var isAttendingMsg = u.linkDest(this.c.attendee) === this.msg.value.author
    && keys === 'about,attendee,type'
  if (isAttendingMsg) {
    var attending = !this.c.attendee.remove
    this.wrapMini([
      attending ? ' is attending' : ' is not attending', ' ',
      this.link1(this.c.about, done())
      ], elCb)
    return done(cb)
  }

  var extras
  for (var k in this.c) {
    if (this.c[k] !== null && this.c[k] !== '' && !knownAboutProps[k]) {
      if (!extras) extras = {}
      extras[k] = this.c[k]
    }
  }

  var img = u.linkDest(this.c.image)
  // if there is a description, it is likely to be multi-line
  var hasDescription = this.c.description != null
  // if this about message gives the thing a name, show its id
  var showComputedName = !isSelf && !this.c.name

  this.wrap([
    this.c.root ? h('div',
      h('small', '> ', this.link1(this.c.root, done()))
    ) : '',
    isSelf ? 'self-describes as ' : [
      'describes ',
      !this.c.about ? ''
        : showComputedName ? this.link1(this.c.about, done())
        : h('a', {href: this.toUrl(this.c.about)}, truncate(this.c.about, 10)),
      ' as '
    ],
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
      })) : '',
    /*
    this.c.rating != null ? this.aboutRating() : '',
    */
    extras ? this.valueTable(extras, 1, done())
    : ''
  ], elCb)
  done(cb)
}

/*
 * disabled until it's clearer how to do this -cel
RenderMsg.prototype.aboutRating = function (cb) {
  var rating = Number(this.c.rating)
  var type = this.c.ratingType || '★'
  var text = rating + ' ' + type
  if (isNaN(rating)) return 'rating: ' + text
  if (rating > 5) rating = 5
  var el = h('div', {title: text})
  for (var i = 0; i < rating; i++) {
    el.appendChild(h('span',
      {innerHTML: unwrapP(this.render.markdown(type) + ' ')}
    ))
  }
  return el
}
*/

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
        self.c.reason ? [' because ', h('q', self.c.reason)] : ''
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

  var done = multicb({pluck: 1, spread: true})
  self.link(self.c.repo, done())
  self.render.npmPackageMentions(self.c.mentions, done())
  self.render.npmPrebuildMentions(self.c.mentions, done())
  done(function (err, a, pkgMentionsEl, prebuildMentionsEl) {
    if (err) return cb(err)
      self.wrap(h('div.ssb-git-update',
        'git push ', a, ' ',
        !isNaN(size) ? [self.render.formatSize(size), ' '] : '',
        self.c.refs ? h('ul', Object.keys(self.c.refs).map(function (ref) {
          var id = self.c.refs[ref]
          var type = /^refs\/tags/.test(ref) ? 'tag' : 'commit'
          var path = id && ('/git/' + type + '/' + encodeURIComponent(id)
            + '?msg=' + encodeURIComponent(self.msg.key))
            + '&search=1'
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
            self.render.gitCommitBody(commit.body)
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
            String(tag.tag),
            tag.title ? [': ', self.linkify(String(tag.title).trim()), ' '] : '',
            tag.body ? self.render.gitCommitBody(tag.body) : ''
          )
        })) : '',
        self.c.commits_more ? h('div',
          '+ ' + self.c.commits_more + ' more commits') : '',
        self.c.tags_more ? h('div',
          '+ ' + self.c.tags_more + ' more tags') : '',
        pkgMentionsEl,
        prebuildMentionsEl
    ), cb)
  })
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
  var done = multicb({pluck: 1, spread: true})
  var elCb = done()
  this.wrap([
    this.valueTable(this.c, 1, done()),
  ], elCb)
  done(cb)
}

RenderMsg.prototype.valueTable = function (val, depth, cb) {
  var isContent = depth === 1
  var self = this
  switch (typeof val) {
    case 'object':
      if (val === null) return cb(), ''
      var done = multicb({pluck: 1, spread: true})
      var el = Array.isArray(val)
        ? h('ul', val.map(function (item) {
          return h('li', self.valueTable(item, depth + 1, done()))
        }))
        : h('table.ssb-object', Object.keys(val).map(function (key) {
          if (key === 'text') {
            return h('tr',
              h('td', h('strong', 'text')),
              h('td', h('div', {
                innerHTML: self.render.markdown(val.text, val.mentions)
              }))
            )
          } else if (isContent && key === 'type') {
            // TODO: also link to images by type, using links2
            var type = val.type
            return h('tr',
              h('td', h('strong', 'type')),
              h('td', h('a', {href: self.toUrl('/type/' + type)}, type))
            )
          }
          return h('tr',
            h('td', h('strong', key)),
            h('td', self.valueTable(val[key], depth + 1, done()))
          )
        }))
      done(cb)
      return el
    case 'string':
      if (val[0] === '#') return cb(null, h('a', {href: self.toUrl('/channel/' + val.substr(1))}, val))
      if (u.isRef(val)) return self.link1(val, cb)
      if (/^ssb-blob:\/\//.test(val)) return cb(), h('a', {href: self.toUrl(val)}, val)
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
  this.wrapMini([
    h('code', 'MISSING'), ' ',
    h('a', {href: '?ooo=1'}, 'fetch')
  ], cb)
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
  var currency = String(self.c.currency)
  self.link(self.c.account, function (err, a) {
    if (err) return cb(err)
    self.wrapMini([
      'credits ', a || '?', ' ',
      h('code', self.c.amount), ' ',
      currency[0] === '#'
        ? h('a', {href: self.toUrl(currency)}, currency)
        : h('ins', currency),
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

function hJoin(els, seperator, lastSeparator) {
  return els.map(function (el, i) {
    return [i === 0 ? '' : i === els.length-1 ? lastSeparator : seperator, el]
  })
}

function asNpmReadme(readme) {
  if (!readme || readme === 'ERROR: No README data found!') return
  return u.ifString(readme)
}

function singleValue(obj) {
  if (!obj || typeof obj !== 'object') return obj
  var keys = Object.keys(obj)
  if (keys.length === 1) return obj[keys[0]]
}

function ifDifferent(obj, value) {
  if (singleValue(obj) !== value) return obj
}

RenderMsg.prototype.npmPublish = function (cb) {
  var self = this
  var render = self.render
  var pkg = self.c.meta || {}
  var pkgReadme = asNpmReadme(pkg.readme)
  var pkgDescription = u.ifString(pkg.description)

  var versions = Object.keys(pkg.versions || {})
  var singleVersion = versions.length === 1 ? versions[0] : null
  var singleRelease = singleVersion && pkg.versions[singleVersion]
  var singleReadme = singleRelease && asNpmReadme(singleRelease.readme)

  var distTags = pkg['dist-tags'] || {}
  var distTagged = {}
  for (var distTag in distTags)
    if (distTag !== 'latest')
      distTagged[distTags[distTag]] = distTag

  self.links(self.c.previousPublish, function (err, prevLinks) {
    if (err) return cb(err)
    self.wrap([
      h('div',
        'published ',
        h('u', pkg.name), ' ',
        hJoin(versions.map(function (version) {
          var distTag = distTagged[version]
          return [h('b', version), distTag ? [' (', h('i', distTag), ')'] : '']
        }), ', ')
      ),
      pkgDescription ? h('div',
        // TODO: make mdInline use custom emojis
        h('q', {innerHTML: unwrapP(render.markdown(pkgDescription))})) : '',
      prevLinks.length ? h('div', 'previous: ', prevLinks) : '',
      pkgReadme && pkgReadme !== singleReadme ?
        h('blockquote', {innerHTML: render.markdown(pkgReadme)}) : '',
      versions.map(function (version, i) {
        var release = pkg.versions[version] || {}
        var license = u.ifString(release.license)
        var author = ifDifferent(release.author, self.msg.value.author)
        var description = u.ifString(release.description)
        var readme = asNpmReadme(release.readme)
        var keywords = u.toArray(release.keywords).map(u.ifString)
        var dist = release.dist || {}
        var size = u.ifNumber(dist.size)
        return [
          h > 0 ? h('br') : '',
          version !== singleVersion ? h('div', 'version: ', version) : '',
          author ? h('div', 'author: ', render.npmAuthorLink(author)) : '',
          license ? h('div', 'license: ', h('code', license)) : '',
          keywords.length ? h('div', 'keywords: ', keywords.join(', ')) : '',
          size ? h('div', 'size: ', render.formatSize(size)) : '',
          description && description !== pkgDescription ?
            h('div', h('q', {innerHTML: render.markdown(description)})) : '',
          readme ? h('blockquote', {innerHTML: render.markdown(readme)}) : ''
        ]
      })
    ], cb)
  })
}

RenderMsg.prototype.npmPackages = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  var elCb = done()
  function renderIdLink(id) {
    return [h('a', {href: self.toUrl(id)}, truncate(id, 8)), ' ']
  }
  self.render.npmPackageMentions(self.c.mentions, function (err, el) {
    if (err) return cb(err)
    var dependencyLinks = u.toArray(self.c.dependencyBranch)
    var versionLinks = u.toArray(self.c.versionBranch)
    self.wrap(h('div', [
      el,
      dependencyLinks.length ? h('div',
        'dependencies via: ', dependencyLinks.map(renderIdLink)
      ) : '',
      versionLinks.length ? h('div',
        'previous versions: ', versionLinks.map(renderIdLink)
      ) : ''
    ]), elCb)
    return done(cb)
  })
}

RenderMsg.prototype.npmPrebuilds = function (cb) {
  var self = this
  self.render.npmPrebuildMentions(self.c.mentions, function (err, el) {
    if (err) return cb(err)
    self.wrap(el, cb)
  })
}

RenderMsg.prototype.npmPublishTitle = function (cb) {
  var pkg = this.c.meta || {}
  var name = pkg.name || pkg._id || '?'

  var taggedVersions = {}
  for (var version in pkg.versions || {})
    taggedVersions[version] = []

  var distTags = pkg['dist-tags'] || {}
  for (var distTag in distTags) {
    if (distTag === 'latest') continue
    var version = distTags[distTag] || '?'
    var tags = taggedVersions[version] || (taggedVersions[version] = [])
    tags.push(distTag)
  }

  cb(null, name + '@' + Object.keys(taggedVersions).map(function (version) {
    var tags = taggedVersions[version]
    return (tags.length ? tags.join(',') + ':' : '') + version
  }).join(','))
}

function expandDigitToSpaces(n) {
  return '         '.substr(-n)
}

function parseFenRank (line) {
  return line.replace(/\d/g, expandDigitToSpaces).split('')
}

function parseChess(fen) {
  var fields = String(fen).split(/\s+/)
  var ranks = fields[0].split('/')
  var f2 = fields[2] || ''
  return {
    board: ranks.map(parseFenRank),
    /*
    nextMove: fields[1] === 'b' ? 'black'
            : fields[1] === 'w' ? 'white' : 'unknown',
    castling: f2 === '-' ? {} : {
      w: {
        k: 0 < f2.indexOf('K'),
        q: 0 < f2.indexOf('Q'),
      },
      b: {
        k: 0 < f2.indexOf('k'),
        q: 0 < f2.indexOf('q'),
      }
    },
    enpassantTarget: fields[3] === '-' ? null : fields[3],
    halfmoves: Number(fields[4]),
    fullmoves: Number(fields[5]),
    */
  }
}

var chessSymbols = {
  ' ': [' ', ''],
  P: ['♙', 'white', 'pawn'],
  N: ['♘', 'white', 'knight'],
  B: ['♗', 'white', 'bishop'],
  R: ['♖', 'white', 'rook'],
  Q: ['♕', 'white', 'queen'],
  K: ['♔', 'white', 'king'],
  p: ['♟', 'black', 'pawn'],
  n: ['♞', 'black', 'knight'],
  b: ['♝', 'black', 'bishop'],
  r: ['♜', 'black', 'rook'],
  q: ['♛', 'black', 'queen'],
  k: ['♚', 'black', 'king'],
}

function chessPieceName(c) {
  return chessSymbols[c] && chessSymbols[c][2] || '?'
}

function renderChessSymbol(c, loc) {
  var info = chessSymbols[c] || ['?', '', 'unknown']
  return h('span.symbol', {
    title: info[1] + ' ' + info[2] + (loc ? ' at ' + loc : '')
  }, info[0])
}

function chessLocToIdxs(loc) {
  var m = /^([a-h])([1-8])$/.exec(loc)
  if (m) return [8 - m[2], m[1].charCodeAt(0) - 97]
}

function lookupPiece(board, loc) {
  var idxs = chessLocToIdxs(loc)
  return idxs && board[idxs[0]] && board[idxs[0]][idxs[1]]
}

function chessIdxsToLoc(i, j) {
  return 'abcdefgh'[j] + (8-i)
}

RenderMsg.prototype.chessBoard = function (board) {
  if (!board) return ''
  return h('table.chess-board',
    board.map(function (rank, i) {
      return h('tr', rank.map(function (piece, j) {
        var dark = (i ^ j) & 1
        return h('td', {
          class: 'chess-square chess-square-' + (dark ? 'dark' : 'light'),
        }, renderChessSymbol(piece, chessIdxsToLoc(i, j)))
      }))
    })
  )
}

RenderMsg.prototype.chessMove = function (cb) {
  var self = this
  var c = self.c
  var fen = c.fen && c.fen.length === 2 ? c.pgnMove : c.fen
  var game = parseChess(fen)
  var piece = game && lookupPiece(game.board, c.dest)
  self.link(self.c.root, function (err, rootLink) {
    if (err) return cb(err)
    self.wrap([
      h('div', h('small', '> ', rootLink)),
      h('p',
        // 'player ', (c.ply || ''), ' ',
        'moved ', (piece ? renderChessSymbol(piece) : ''), ' ',
        'from ', c.orig, ' ',
        'to ', c.dest
      ),
      self.chessBoard(game.board)
    ], cb)
  })
}

RenderMsg.prototype.chessInvite = function (cb) {
  var self = this
  var myColor = self.c.myColor
  self.link(self.c.inviting, function (err, link) {
    if (err) return cb(err)
    self.wrap([
      'invites ', link, ' to play chess',
      // myColor ? h('p', 'my color is ' + myColor) : ''
    ], cb)
  })
}

RenderMsg.prototype.chessInviteTitle = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  self.getName(self.c.inviting, done())
  self.getName(self.msg.value.author, done())
  done(function (err, inviteeLink, inviterLink) {
    if (err) return cb(err)
    self.wrap([
      'chess: ', inviterLink, ' vs. ', inviteeLink
    ], cb)
  })
}

RenderMsg.prototype.chessInviteAccept = function (cb) {
  var self = this
  self.link(self.c.root, function (err, rootLink) {
    if (err) return cb(err)
    self.wrap([
      h('div', h('small', '> ', rootLink)),
      h('p', 'accepts invitation to play chess')
    ], cb)
  })
}

RenderMsg.prototype.chessGameEnd = function (cb) {
  var self = this
  var c = self.c
  if (c.status === 'resigned') return self.link(self.c.root, function (err, rootLink) {
    if (err) return cb(err)
    self.wrap([
      h('div', h('small', '> ', rootLink)),
      h('p', h('strong', 'resigned'))
    ], cb)
  })

  var fen = c.fen && c.fen.length === 2 ? c.pgnMove : c.fen
  var game = parseChess(fen)
  var piece = game && lookupPiece(game.board, c.dest)
  var done = multicb({pluck: 1, spread: true})
  self.link(self.c.root, done())
  self.link(self.c.winner, done())
  done(function (err, rootLink, winnerLink) {
    if (err) return cb(err)
    self.wrap([
      h('div', h('small', '> ', rootLink)),
      h('p',
        'moved ', (piece ? renderChessSymbol(piece) : ''), ' ',
        'from ', c.orig, ' ',
        'to ', c.dest
      ),
      h('p',
        h('strong', self.c.status), '. winner: ', h('strong', winnerLink)),
      self.chessBoard(game.board)
    ], cb)
  })
}

RenderMsg.prototype.chessChat = function (cb) {
  var self = this
  self.link(self.c.root, function (err, rootLink) {
    if (err) return cb(err)
    self.wrap([
      h('div', h('small', '> ', rootLink)),
      h('p', self.c.msg)
    ], cb)
  })
}

RenderMsg.prototype.chessMove = function (cb) {
  if (this.opts.full) return this.chessMoveFull(cb)
  return this.chessMoveMini(cb)
}

RenderMsg.prototype.chessMoveFull = function (cb) {
  var self = this
  var c = self.c
  var fen = c.fen && c.fen.length === 2 ? c.pgnMove : c.fen
  var game = parseChess(fen)
  var piece = game && lookupPiece(game.board, c.dest)
  self.link(self.c.root, function (err, rootLink) {
    if (err) return cb(err)
    self.wrap([
      h('div', h('small', '> ', rootLink)),
      h('p',
        // 'player ', (c.ply || ''), ' ',
        'moved ', (piece ? renderChessSymbol(piece) : ''), ' ',
        'from ', c.orig, ' ',
        'to ', c.dest
      ),
      self.chessBoard(game.board)
    ], cb)
  })
}

RenderMsg.prototype.chessMoveMini = function (cb) {
  var self = this
  var c = self.c
  var fen = c.fen && c.fen.length === 2 ? c.pgnMove : c.fen
  var game = parseChess(fen)
  var piece = game && lookupPiece(game.board, c.dest)
  self.link(self.c.root, function (err, rootLink) {
    if (err) return cb(err)
    self.wrapMini([
      'moved ', chessPieceName(piece), ' ',
      'to ', c.dest
    ], cb)
  })
}

RenderMsg.prototype.acmeChallengesHttp01 = function (cb) {
  var self = this
  self.wrapMini(h('span',
    'serves ',
    hJoin(u.toArray(self.c.challenges).map(function (challenge) {
      return h('a', {
        href: 'http://' + challenge.domain +
          '/.well-known/acme-challenge/' + challenge.token,
        title: challenge.keyAuthorization,
      }, challenge.domain)
    }), ', ', ', and ')
  ), cb)
}

RenderMsg.prototype.bookclub = function (cb) {
  var self = this
  var props = self.c.common || self.c
  var images = u.toLinkArray(props.image || props.images)
  self.wrap(h('table', h('tr',
    h('td',
      images.map(function (image) {
        return h('a', {href: self.render.toUrl(image.link)}, h('img', {
          src: self.render.imageUrl(image.link),
          alt: image.name || ' ',
          width: 180,
        }))
      })),
    h('td',
      h('h4', props.title),
      props.authors ?
        h('p', h('em', props.authors))
        : '',
      props.description
        ? h('div', {innerHTML: self.render.markdown(props.description)})
        : ''
    )
  )), cb)
}

RenderMsg.prototype.bookclubTitle = function (cb) {
  var props = this.c.common || this.c
  cb(null, props.title || 'book')
}

RenderMsg.prototype.sombrioPosition = function () {
  return h('span', '[' + this.c.position + ']')
}

RenderMsg.prototype.sombrioWall = function (cb) {
  var self = this
  self.wrapMini(h('span',
    self.sombrioPosition(),
    ' wall'
  ), cb)
}

RenderMsg.prototype.sombrioTombstone = function (cb) {
  var self = this
  self.wrapMini(h('span',
    self.sombrioPosition(),
    ' tombstone'
  ), cb)
}

RenderMsg.prototype.sombrioScore = function (cb) {
  var self = this
  self.wrapMini(h('span',
    'scored ',
    h('ins', self.c.score)
  ), cb)
}

RenderMsg.prototype.blog = function (cb) {
  var self = this
  var blogId = u.linkDest(self.c.blog)
  var imgId = u.linkDest(self.c.thumbnail)
  var imgLink = imgId ? u.toLinkArray(self.c.mentions).filter(function (link) {
    return link.link === imgId
  })[0] || u.toLink(self.c.thumbnail) : null
  self.wrapMini(h('table', h('tr',
    h('td',
      imgId ? h('img', {
        src: self.render.imageUrl(imgId),
        alt: (imgLink.name || '')
          + (imgLink.size != null ? ' (' + self.render.formatSize(imgLink.size) + ')' : ''),
        width: 180,
      }) : 'blog'),
    h('td',
      blogId ? h('h3', h('a', {href: self.render.toUrl('/markdown/' + blogId)},
        self.c.title || self.msg.key)) : '',
      self.c.summary || '')
  )), cb)
}

RenderMsg.prototype.imageMap = function (cb) {
  var self = this
  var imgLink = u.toLink(self.c.image)
  var imgRef = imgLink && imgLink.link
  var mapName = 'map' + token()
  self.wrap(h('div', [
    h('map', {name: mapName},
      u.toArray(self.c.areas).map(function (areaLink) {
        var href = areaLink && self.toUrl(areaLink.link)
        return href ? h('area', {
          shape: String(areaLink.shape),
          coords: String(areaLink.coords),
          href: href,
        }) : ''
      })
    ),
    imgRef && imgRef[0] === '&' ? h('img', {
      src: self.render.imageUrl(imgRef),
      width: Number(imgLink.width) || undefined,
      height: Number(imgLink.height) || undefined,
      alt: String(imgLink.name || ''),
      usemap: '#' + mapName,
    }) : ''
  ]), cb)
}

RenderMsg.prototype.skillCreate = function (cb) {
  var self = this
  self.wrapMini(h('span',
    ' created skill ',
    h('ins', self.c.name)
  ), cb)
}

RenderMsg.prototype.ideaCreate = function (cb) {
  var self = this
  self.wrapMini(h('span',
    ' has an idea'
  ), cb)
}

RenderMsg.prototype.identitySkillAssign = function (cb) {
  var self = this
  self.link(self.c.skillKey, function (err, a) {
    self.wrapMini(h('span',
      self.c.action === 'assign' ? 'assigns '
        : self.c.action === 'unassign' ? 'unassigns '
        : h('code', self.c.action), ' ',
      'skill ', a
    ), cb)
  })
}

RenderMsg.prototype.ideaSkillAssign = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  self.link(self.c.skillKey, done())
  self.link(self.c.ideaKey, done())
  done(function (err, skillA, ideaA) {
    self.wrapMini(h('span',
      self.c.action === 'assign' ? 'assigns '
        : self.c.action === 'unassign' ? 'unassigns '
        : h('code', self.c.action), ' ',
      'skill ', skillA,
      ' to idea ',
      ideaA
    ), cb)
  })
}

RenderMsg.prototype.ideaAssocate = function (cb) {
  var self = this
  self.link(self.c.ideaKey, function (err, a) {
    self.wrapMini(h('span',
      self.c.action === 'associate' ? 'associates with '
        : self.c.action === 'disassociate' ? 'disassociates with '
        : h('code', self.c.action), ' ',
      'idea ', a
    ), cb)
  })
}

RenderMsg.prototype.ideaHat = function (cb) {
  var self = this
  self.link(self.c.ideaKey, function (err, a) {
    self.wrapMini(h('span',
      self.c.action === 'take' ? 'takes '
        : self.c.action === 'discard' ? 'discards '
        : h('code', self.c.action), ' ',
      'idea ', a
    ), cb)
  })
}

RenderMsg.prototype.ideaUpdate = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  var props = {}
  for (var k in self.c) {
    if (k !== 'ideaKey' && k !== 'type' && k !== 'talenet-version') {
      props[k] = self.c[k]
    }
  }
  var keys = Object.keys(props).sort().join()

  if (keys === 'title') {
    return self.wrapMini(h('span',
      'titles idea ',
      h('a', {href: self.toUrl(self.c.ideaKey)}, props.title)
    ), cb)
  }

  if (keys === 'description') {
    return self.link(self.c.ideaKey, function (err, a) {
      self.wrap(h('div',
        'describes idea ', a, ':',
        h('blockquote', {innerHTML: self.render.markdown(props.description)})
      ), cb)
    })
  }

  if (keys === 'description,title') {
    return self.wrap(h('div',
      'describes idea ',
      h('a', {href: self.toUrl(self.c.ideaKey)}, props.title),
      ':',
      h('blockquote', {innerHTML: self.render.markdown(props.description)})
    ), cb)
  }

  self.link(self.c.ideaKey, done())
  var table = self.valueTable(props, 1, done())
  done(function (err, ideaA) {
    self.wrap(h('div', [
      'updates idea ', ideaA,
      table
    ]), cb)
  })
}

RenderMsg.prototype.ideaComment = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  self.link(self.c.ideaKey, done())
  self.link(self.c.commentKey, done())
  done(function (err, ideaLink, commentLink) {
    if (err) return self.wrap(u.renderError(err), cb)
    self.wrap(h('div', [
      ideaLink ? h('div', h('small', h('span.symbol', '→'), ' idea ', ideaLink)) : '',
      commentLink ? h('div', h('small', h('span.symbol', '↳'), ' comment ', commentLink)) : '',
      self.c.text ?
        h('div', {innerHTML: self.render.markdown(self.c.text)}) : ''
    ]), cb)
  })
}

RenderMsg.prototype.aboutResource = function (cb) {
  var self = this
  return self.wrap(h('div',
    'describes resource ',
    h('a', {href: self.toUrl(self.c.about)}, self.c.name),
    ':',
    h('blockquote', {innerHTML: self.render.markdown(self.c.description)})
  ), cb)
}

RenderMsg.prototype.lineComment = function (cb) {
  var self = this
  var done = multicb({pluck: 1, spread: true})
  self.link(self.c.repo, done())
  self.getMsg(self.c.updateId, done())
  done(function (err, repoLink, updateMsg) {
    if (err) return cb(err)
    return self.wrap(h('div',
      h('div', h('small', '> ',
        repoLink, ' ',
        h('a', {
          href: self.toUrl(self.c.updateId)
        },
          updateMsg
            ? htime(new Date(updateMsg.value.timestamp))
            : String(self.c.updateId)
        ), ' ',
        h('a', {
          href: self.toUrl('/git/commit/' + self.c.commitId + '?msg=' + encodeURIComponent(self.c.updateId))
        }, String(self.c.commitId).substr(0, 8)), ' ',
        h('a', {
          href: self.toUrl('/git/line-comment/' +
            encodeURIComponent(self.msg.key || JSON.stringify(self.msg)))
        }, h('code', self.c.filePath + ':' + self.c.line))
      )),
      self.c.text ?
        h('div', {innerHTML: self.markdown()}) : ''), cb)
  })
}
