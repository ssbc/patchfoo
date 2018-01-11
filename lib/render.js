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
var Highlight = require('highlight.js')

module.exports = Render

function MdRenderer(render) {
  marked.Renderer.call(this, {})
  this.render = render
}
MdRenderer.prototype = new marked.Renderer()

MdRenderer.prototype.urltransform = function (href) {
  return this.render.toUrl(href)
}

MdRenderer.prototype.image = function (ref, title, text) {
  var href = this.render.imageUrl(ref)
  return h('img', {
    src: href,
    alt: this.render.getImageAlt(ref, text),
    title: title || undefined
  }).outerHTML
}

MdRenderer.prototype.link = function (ref, title, text) {
  var href = this.urltransform(ref)
  var name = href && /^\/(&|%26)/.test(href) && (title || text)
  if (u.isRef(ref)) {
    var myName = this.render.app.getNameSync(ref)
    if (myName) title = title ? title + ' (' + myName + ')' : myName
  }
  var a = h('a', {
    class: href === false ? 'bad' : undefined,
    href: href !== false ? href : undefined,
    title: title || undefined,
    download: name ? encodeURIComponent(name) : undefined
  })
  // text is already html-escaped
  a.innerHTML = text
  return a.outerHTML
}

MdRenderer.prototype.mention = function (preceding, id) {
  var href = this.urltransform(id)
  var myName = this.render.app.getNameSync(id)
  if (id.length > 50) id = id.slice(0, 8) + '…'
  return (preceding||'') + h('a', {
    class: href === false ? 'bad' : undefined,
    href: href !== false ? href : undefined,
    title: myName || undefined,
  }, id).outerHTML
}

MdRenderer.prototype.code = function (code, lang, escaped) {
  if (this.render.opts.codeInTextareas) {
    return h('div', h('textarea', {
      cols: 80,
      rows: u.rows(code),
      innerHTML: escaped ? code : u.escapeHTML(code)
    })).outerHTML
  } else {
    return marked.Renderer.prototype.code.call(this, code, lang, escaped)
  }
}

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
    highlight: this.highlight.bind(this),
  }
}

Render.prototype.emoji = function (emoji) {
  var name = ':' + emoji + ':'
  var link = this._mentions && this._mentions[name]
  if (link && link.link) {
    this.app.reverseEmojiNameCache.set(emoji, link.link)
    return h('img.ssb-emoji', {
      src: this.opts.img_base + link.link,
      alt: name
        + (link.size != null ? ' (' + this.formatSize(link.size) + ')' : ''),
      height: 17,
      title: name,
    })
  }
  if (emoji in emojis) {
    return h('img.ssb-emoji', {
      src: this.opts.emoji_base + emoji + '.png',
      alt: name,
      height: 17,
      align: 'absmiddle',
      title: name,
    })
  }
  return name
}

/* disabled until it can be done safely without breaking html
function fixSymbols(str) {
  // Dillo doesn't do fallback fonts, so specifically render fancy characters
  // with Symbola
  return str.replace(/[^\u0000-\u00ff]+/, function ($0) {
    return '<span class="symbol">' + $0 + '</span>'
  })
}
*/

Render.prototype.markdown = function (text, mentions) {
  if (!text) return ''
  var mentionsObj = this._mentions = {}
  var mentionsByLink = this._mentionsByLink = {}
  if (Array.isArray(mentions)) mentions.forEach(function (link) {
    if (!link) return
    else if (link.emoji)
      mentionsObj[':' + link.name + ':'] = link
    else if (link.name)
      mentionsObj['@' + link.name] = link.link
    else if (link.host === 'http://localhost:7777')
      mentionsObj[link.href] = link.link
    if (link.link)
      mentionsByLink[link.link + (link.key ? '#' + link.key : '')] = link
  })
  var out = marked(String(text), this.markedOpts)
  delete this._mentions
  delete this._mentionsByLink
  return out //fixSymbols(out)
}

Render.prototype.imageUrl = function (ref) {
  var m = /^blobstore:(.*)/.exec(ref)
  if (m) ref = m[1]
  ref = ref.replace(/#/, '%23')
  return this.opts.img_base + ref
}

Render.prototype.getImageAlt = function (id, fallback) {
  var link = this._mentionsByLink[id]
  if (!link) return fallback
  var name = link.name || fallback
  return name
    + (link.size != null ? ' (' + this.formatSize(link.size) + ')' : '')
}

Render.prototype.formatSize = function (size) {
  if (size < 1024) return size + ' B'
  size /= 1024
  if (size < 1024) return size.toFixed(2) + ' KB'
  size /= 1024
  return size.toFixed(2) + ' MB'
}

Render.prototype.linkify = function (text) {
  var arr = text.split(u.ssbRefEncRegex)
  for (var i = 1; i < arr.length; i += 2) {
    arr[i] = h('a', {href: this.toUrlEnc(arr[i])}, arr[i])
  }
  return arr
}

Render.prototype.toUrlEnc = function (href) {
  var url = this.toUrl(href)
  if (url) return url
  try { href = decodeURIComponent(href) }
  catch (e) { return false }
  return this.toUrl(href)
}

Render.prototype.toUrl = function (href) {
  if (!href) return href
  var mentions = this._mentions
  if (mentions && href in this._mentions) href = this._mentions[href]
  if (/^ssb:\/\//.test(href)) href = href.substr(6)
  if (/^ssb-blob:\/\//.test(href)) {
    return this.opts.base + 'zip/' + href.substr(11)
  }
  switch (href[0]) {
    case '%':
      if (!u.isRef(href)) return false
      return this.opts.base +
        (this.opts.encode_msgids ? encodeURIComponent(href) : href)
    case '@':
      if (!u.isRef(href)) return false
      return this.opts.base + href
    case '&':
      var parts = href.split('#')
      var hash = parts.shift()
      var key = parts.shift()
      var fragment = parts.join('#')
      if (!u.isRef(hash)) return false
      return this.opts.blob_base + hash
        + (key ? encodeURIComponent('#' + key) : '')
        + (fragment ? '#' + fragment : '')
    case '#': return this.opts.base + 'channel/' +
      encodeURIComponent(href.substr(1))
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
    width: 72,
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
    if (err) return cb(null, link)
    link.name = about.name || about.title || (link.link.substr(0, 8) + '…')
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
    var sigil = link.link && link.link[0] || '@'
    a.childNodes[0].textContent = sigil + link.name
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

Render.prototype.renderMsg = function (msg, opts, cb) {
  var self = this
  self.app.filterMsg(msg, opts, function (err, show) {
    if (err) return cb(err)
    if (show) new RenderMsg(self, self.app, msg, opts).message(cb)
    else cb(null, '')
  })
}

Render.prototype.renderFeeds = function (opts) {
  var self = this
  var limit = Number(opts.limit)
  return pull(
    paramap(function (msg, cb) {
      self.renderMsg(msg, opts, cb)
    }, 4),
    pull.filter(Boolean),
    limit && pull.take(limit)
  )
}

Render.prototype.gitCommitBody = function (body) {
  if (!body) return ''
  var isMarkdown = !/^# Conflicts:$/m.test(body)
  return isMarkdown
    ? h('div', {innerHTML: this.markdown('\n' + body)})
    : h('pre', this.linkify('\n' + body))
}

Render.prototype.getName = function (id, cb) {
  // TODO: consolidate the get name/link functions
  var self = this
  switch (id && id[0]) {
    case '%':
      return self.app.getMsgDecrypted(id, function (err, msg) {
        if (err && err.name == 'NotFoundError')
          return cb(null, String(id).substring(0, 8) + '…(missing)')
        if (err) return fallback()
        new RenderMsg(self, self.app, msg, {wrap: false}).title(cb)
      })
    case '@': // fallthrough
    case '&':
      return self.app.getAbout(id, function (err, about) {
        if (err || !about || !about.name) return fallback()
        cb(null, about.name)
      })
    default:
      return cb(null, String(id))
  }
  function fallback() {
    cb(null, String(id).substr(0, 8) + '…')
  }
}

Render.prototype.getNameLink = function (id, cb) {
  var self = this
  self.getName(id, function (err, name) {
    if (err) return cb(err)
    cb(null, h('a', {href: self.toUrl(id)}, name))
  })
}

Render.prototype.npmAuthorLink = function (author) {
  if (!author) return
  var url = u.ifString(author.url)
  var email = u.ifString(author.email)
  var name = u.ifString(author.name)
  var title
  if (!url && u.isRef(name)) url = name, name = null
  if (!url && !email) return name || JSON.stringify(author)
  if (!url && email) url = 'mailto:' + email, email = null
  if (!name && email) name = email, email = null
  var feed = u.isRef(url) && url[0] === '@' && url
  if (feed && name) title = this.app.getNameSync(feed)
  if (feed && name && name[0] != '@') name = '@' + name
  if (feed && !name) name = this.app.getNameSync(feed) // TODO: async
  if (url && !name) name = url
  var secondaryLink = email && h('a', {href: this.toUrl('mailto:' + email)}, email)
  return [
    h('a', {href: this.toUrl(url), title: title}, name),
    secondaryLink ? [' (', secondaryLink, ')'] : ''
  ]
}

// auto-highlight is slow
var useAutoHighlight = false

Render.prototype.highlight = function (code, lang) {
  if (code.length > 100000) return u.escapeHTML(code)
  if (!lang && /^#!\/bin\/[^\/]*sh$/m.test(code)) lang = 'sh'
  try {
    return lang
      ? Highlight.highlight(lang, code).value
      : useAutoHighlight
      ? Highlight.highlightAuto(code).value
      : u.escapeHTML(code)
  } catch(e) {
    if (!/^Unknown language/.test(e.message)) console.trace(e)
    return u.escapeHTML(code)
  }
}

Render.prototype.npmPackageMentions = function (links, cb) {
  var self = this
  var pkgLinks = u.toArray(links).filter(function (link) {
    return /^npm:/.test(link.name)
  })
  if (pkgLinks.length === 0) return cb(null, '')
  var done = multicb({pluck: 1})
  pkgLinks.forEach(function (link) {
    self.npmPackageMention(link, {}, done())
  })
  done(function (err, mentionEls) {
    cb(null, h('table',
      h('thead', h('tr',
        h('th', 'package'),
        h('th', 'version'),
        h('th', 'tag'),
        h('th', 'size'),
        h('th', 'tarball'),
        h('th', 'readme')
      )),
      h('tbody', mentionEls)
    ))
  })
}

Render.prototype.npmPrebuildMentions = function (links, cb) {
  var self = this
  var prebuildLinks = u.toArray(links).filter(function (link) {
    return /^prebuild:/.test(link.name)
  })
  if (prebuildLinks.length === 0) return cb(null, '')
  var done = multicb({pluck: 1})
  prebuildLinks.forEach(function (link) {
    self.npmPrebuildMention(link, {}, done())
  })
  done(function (err, mentionEls) {
    cb(null, h('table',
      h('thead', h('tr',
        h('th', 'name'),
        h('th', 'version'),
        h('th', 'runtime'),
        h('th', 'abi'),
        h('th', 'platform+libc'),
        h('th', 'arch'),
        h('th', 'size'),
        h('th', 'tarball')
      )),
      h('tbody', mentionEls)
    ))
  })
}

Render.prototype.npmPackageMention = function (link, opts, cb) {
  var nameRegex = /'prebuild:{name}-v{version}-{runtime}-v{abi}-{platform}{libc}-{arch}.tar.gz'/
  var parts = String(link.name).replace(/\.tgz$/, '').split(':')
  var name = parts[1]
  var version = parts[2]
  var distTag = parts[3]
  var self = this
  var done = multicb({pluck: 1, spread: true})
  var base = '/npm/' + (opts.author ? u.escapeId(link.author) + '/' : '')
  var pathWithAuthor = opts.withAuthor ? '/npm/' +
    u.escapeId(link.author) +
      (opts.name ? '/' + opts.name +
        (opts.version ? '/' + opts.version +
          (opts.distTag ? '/' + opts.distTag + '/' : '') : '') : '') : ''
  self.app.getAbout(link.author, done())
  self.app.getBlobState(link.link, done())
  done(function (err, about, blobState) {
    if (err) return cb(err)
    cb(null, h('tr', [
      opts.withAuthor ? h('td', h('a', {
        href: self.toUrl(pathWithAuthor),
        title: 'publisher'
      }, about.name), ' ') : '',
      h('td', h('a', {
        href: self.toUrl(base + name),
        title: 'package name'
      }, name), ' '),
      h('td', version ? [h('a', {
        href: self.toUrl(base + name + '/' + version),
        title: 'package version'
      }, version), ' '] : ''),
      h('td', distTag ? [h('a', {
        href: self.toUrl(base + name + '//' + distTag),
        title: 'dist-tag'
      }, distTag), ' '] : ''),
      h('td', {align: 'right'}, link.size != null ? [h('span', {
        title: 'tarball size'
      }, self.formatSize(link.size)), ' '] : ''),
      h('td', typeof link.link === 'string' ? h('code', h('a', {
        href: self.toUrl('/links/' + link.link),
        title: 'package tarball'
      }, link.link.substr(0, 8) + '…')) : ''),
      h('td',
        blobState === 'wanted' ?
        'fetching...'
        : blobState ? h('a', {
          href: self.toUrl('/npm-readme/' + encodeURIComponent(link.link)),
          title: 'package contents'
        }, 'readme')
        : self.blobFetchForm(link.link))
    ]))
  })
}

Render.prototype.blobFetchForm = function (id) {
  return h('form', {action: '', method: 'post'},
    h('input', {type: 'hidden', name: 'action', value: 'want-blobs'}),
    h('input', {type: 'hidden', name: 'async_want', value: '1'}),
    h('input', {type: 'hidden', name: 'blob_ids', value: id}),
    h('input', {type: 'submit', value: 'fetch'})
  )
}

Render.prototype.npmPrebuildNameRegex = /^prebuild:(.*?)-v([0-9]+\.[0-9]+.*?)-(.*?)-v(.*?)-(.*?)-(.*?)\.tar\.gz$/

Render.prototype.npmPrebuildMention = function (link, opts, cb) {
  var m = this.npmPrebuildNameRegex.exec(link.name)
  if (!m) return cb(null, '')
  var name = m[1], version = m[2], runtime = m[3],
      abi = m[4], platformlibc = m[5], arch = m[6]
  var self = this
  var done = multicb({pluck: 1, spread: true})
  var base = '/npm-prebuilds/' + (opts.author ? u.escapeId(link.author) + '/' : '')
  self.app.getAbout(link.author, done())
  self.app.getBlobState(link.link, done())
  done(function (err, about, blobState) {
    if (err) return cb(err)
    cb(null, h('tr', [
      opts.withAuthor ? h('td', h('a', {
        href: self.toUrl(link.author)
      }, about.name), ' ') : '',
      h('td', h('a', {
        href: self.toUrl(base + name)
      }, name), ' '),
      h('td', h('a', {
        href: self.toUrl('/npm/' + name + '/' + version)
      }, version), ' '),
      h('td', runtime, ' '),
      h('td', abi, ' '),
      h('td', platformlibc, ' '),
      h('td', arch, ' '),
      h('td', {align: 'right'}, link.size != null ? [
        self.formatSize(link.size), ' '
      ] : ''),
      h('td', typeof link.link === 'string' ? h('code', h('a', {
        href: self.toUrl('/links/' + link.link)
      }, link.link.substr(0, 8) + '…')) : ''),
      h('td',
        blobState === 'wanted' ?
        'fetching...'
        : blobState ? ''
        : self.blobFetchForm(link.link))
    ]))
  })
}

Render.prototype.friendsList = function (prefix) {
  prefix = prefix || '/'
  var self = this
  return pull(
    paramap(function (id, cb) {
      self.app.getAbout(id, function (err, about) {
        var name = about && about.name || id.substr(0, 8) + '…'
        cb(null, h('a', {href: self.toUrl(prefix + id)}, name))
      })
    }, 8),
    pull.map(function (el) {
      return [el, ' ']
    }),
    pull.flatten(),
    pull.map(u.toHTML)
  )
}
