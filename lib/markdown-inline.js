var marked = require('ssb-marked')
var u = require('./util')

// based on ssb-markdown, which is Copyright (c) 2016 Dominic Tarr, MIT License

var inlineRenderer = new marked.Renderer()

// inline renderer just spits out the text of links and images
inlineRenderer.urltransform = function (url) { return false }
inlineRenderer.link = function (href, title, text) { return unquote(shortenIfLink(text)) }
inlineRenderer.image  = function (href, title, text) { return unquote(shortenIfLink(text)) }
inlineRenderer.code = function(code, lang, escaped) { return escaped ? code : escape(code) }
inlineRenderer.blockquote = function(quote) { return unquote(quote) }
inlineRenderer.html = function(html) { return false }
inlineRenderer.heading = function(text, level, raw) { return unquote(text)+' ' }
inlineRenderer.hr = function() { return ' --- ' }
inlineRenderer.br = function() { return ' ' }
inlineRenderer.list = function(body, ordered) { return unquote(body) }
inlineRenderer.listitem = function(text) { return '- '+unquote(text) }
inlineRenderer.paragraph = function(text) { return unquote(text)+' ' }
inlineRenderer.table = function(header, body) { return unquote(header + ' ' + body) }
inlineRenderer.tablerow = function(content) { return unquote(content) }
inlineRenderer.tablecell = function(content, flags) { return unquote(content) }
inlineRenderer.strong = function(text) { return unquote(text) }
inlineRenderer.em = function(text) { return unquote(text) }
inlineRenderer.codespan = function(text) { return unquote(text) }
inlineRenderer.del = function(text) { return unquote(text) }
inlineRenderer.mention = function(preceding, id) { return shortenIfLink(unquote((preceding||'') + id)) }
inlineRenderer.hashtag = function(preceding, tag) { return unquote((preceding||'') + tag) }

function unquote (text) {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
}

function escape (text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n+/g, ' ')
}

function shortenIfLink (text) {
  return (u.ssbRefRegex.test(text.trim())) ? text.slice(0, 8) : text
}

module.exports = function(text) {
  return marked(''+(text||''), {renderer: inlineRenderer, emoji: false})
}
