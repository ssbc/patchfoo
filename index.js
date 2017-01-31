var pkg = require('./package')
exports.name = pkg.name
exports.version = pkg.version
exports.manifest = {}

var App = require('./lib/app')

exports.init = function (sbot, config) {
  new App(sbot, config).go()
}
