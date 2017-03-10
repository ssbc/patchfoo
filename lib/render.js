var fs = require('fs')
var path = require('path')
var pull = require('pull-stream')
var cat = require('pull-cat')
var paramap = require('pull-paramap')
var h = require('hyperscript')
var marked = require('ssb-marked')
var emojis = require('emoji-named-characters')
var qs = require('querystring')
var u = require('./util')
var multicb = require('multicb')
var RenderMsg = require('./render-msg')

module.exports = Render

function MdRenderer(render) {
  marked.Renderer.call(this, {})
  this.render = render
}
MdRenderer.prototype = new marked.Renderer()

MdRenderer.prototype.urltransform = function (href) {
  return this.render.toUrl(href)
}

MdRenderer.prototype.image = function (href, title, text) {
  href = this.render.imageUrl(href)
  var name = text || title
  if (name) href += '?name=' + encodeURIComponent(name)
  return h('img', {
    src: href,
    alt: text,
    title: title || undefined
  }).outerHTML
}

MdRenderer.prototype.link = function(href, title, text) {
  href = this.urltransform(href)
  var name = href && /^\/(&|%26)/.test(href) && (title || text)
  if (name) href += '?name=' + encodeURIComponent(name)
  return '<a'
    + (href !== false
      ? ' href="' + href + '"'
      : ' class="bad"')
    + (title ? ' title="' + title + '"' : '')
    + '>' + text + '</a>'
};


function lexerRenderEmoji(emoji) {
  var el = this.renderer.render.emoji(emoji)
  return el && el.outerHTML || el
}

function Render(app, opts) {
  this.app = app
  this.opts = opts

  this.markedOpts = {
    gfm: true,
    mentions: true,
    tables: true,
    breaks: true,
    pedantic: false,
    sanitize: true,
    smartLists: true,
    smartypants: false,
    emoji: lexerRenderEmoji,
    renderer: new MdRenderer(this),
  }
}

Render.prototype.emoji = function (emoji) {
  var name = ':' + emoji + ':'
  return emoji in emojis ?
    h('img.ssb-emoji', {
      src: this.opts.emoji_base + emoji + '.png',
      alt: name,
      title: name,
    }) : name
}

Render.prototype.markdown = function (text, mentions) {
  if (!text) return ''
  var mentionsObj = this._mentions = {}
  if (Array.isArray(mentions)) mentions.forEach(function (link) {
    if (!link) return
    else if (link.name)
      mentionsObj['@' + link.name] = link.link
    else if (link.host === 'http://localhost:7777')
      mentionsObj[link.href] = link.link
  })
  var out = marked(String(text), this.markedOpts)
  delete this._mentions
  return out
}

Render.prototype.imageUrl = function (ref) {
  var m = /^blobstore:(.*)/.exec(ref)
  if (m) ref = m[1]
  return this.opts.img_base + ref
}

Render.prototype.toUrl = function (href) {
  if (!href) return href
  var mentions = this._mentions
  if (mentions && href in this._mentions) href = this._mentions[href]
  if (/^ssb:\/\//.test(href)) href = href.substr(6)
  switch (href[0]) {
    case '%':
      if (!u.isRef(href)) return false
      return this.opts.base + encodeURIComponent(href)
    case '@':
      if (!u.isRef(href)) return false
      return this.opts.base + href
    case '&':
      if (!u.isRef(href)) return false
      return this.opts.blob_base + href
    case '#': return this.opts.base + encodeURIComponent(href)
    case '/': return this.opts.base + href.substr(1)
    case '?': return this.opts.base + 'search?q=' + encodeURIComponent(href)
  }
  var m = /^blobstore:(.*)/.exec(href)
  if (m) return this.opts.blob_base + m[1]
  if (/^javascript:/.test(href)) return false
  return href
}

Render.prototype.lockIcon = function () {
  return this.emoji('lock')
}

Render.prototype.avatarImage = function (link, cb) {
  var self = this
  if (!link) return cb(), ''
  if (typeof link === 'string') link = {link: link}
  var img = h('img.ssb-avatar-image', {
    alt: ' '
  })
  if (link.image) gotAbout(null, link)
  else self.app.getAbout(link.link, gotAbout)
  function gotAbout(err, about) {
    if (err) return cb(err)
    if (!about.image) img.src = self.toUrl('/static/fallback.png')
    else img.src = self.imageUrl(about.image)
    cb()
  }
  return img
}

Render.prototype.prepareLink = function (link, cb) {
  if (typeof link === 'string') link = {link: link}
  if (link.name || !link.link) cb(null, link)
  else this.app.getAbout(link.link, function (err, about) {
    if (err) return cb(err)
    link.name = about.name
    if (link.name && link.name[0] === link.link[0]) {
      link.name = link.name.substr(1)
    }
    cb(null, link)
  })
}

Render.prototype.prepareLinks = function (links, cb) {
  var self = this
  if (!links) return cb()
  var done = multicb({pluck: 1})
  if (Array.isArray(links)) links.forEach(function (link) {
    self.prepareLink(link, done())
  })
  done(cb)
}

Render.prototype.idLink = function (link, cb) {
  var self = this
  if (!link) return cb(), ''
  var a = h('a', ' ')
  self.prepareLink(link, function (err, link) {
    if (err) return cb(err)
    a.href = self.toUrl(link.link)
    a.childNodes[0].textContent = '@' + link.name
    cb()
  })
  return a
}

Render.prototype.privateLine = function (recps, cb) {
  var done = multicb({pluck: 1, spread: true})
  var self = this
  var el = h('div.recps',
    self.lockIcon(),
    Array.isArray(recps)
      ? recps.map(function (recp) {
        return [' ', self.idLink(recp, done())]
      }) : '')
  done(cb)
  return el
}

Render.prototype.msgLink = function (msg, cb) {
  var self = this
  var el = h('span')
  var a = h('a', {href: self.toUrl(msg.key)}, msg.key)
  self.app.unboxMsg(msg, function (err, msg) {
    if (err) return el.appendChild(u.renderError(err)), cb()
    var renderMsg = new RenderMsg(self, self.app, msg, {wrap: false})
    renderMsg.title(function (err, title) {
      if (err) return el.appendChild(u.renderError(err)), cb()
      a.childNodes[0].textContent = title
      cb()
    })
  })
  return a
}

Render.prototype.renderMsg = function (msg, raw, cb) {
  new RenderMsg(this, this.app, msg).message(raw, cb)
}

Render.prototype.renderFeeds = function (raw) {
  var self = this
  return paramap(function (msg, cb) {
    self.renderMsg(msg, raw, cb)
  }, 4)
}
