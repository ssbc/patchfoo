var createConfig = require('ssb-config/inject')
var config = createConfig(process.env.ssb_appname)
require('ssb-client')(config, function (err, sbot) {
  if (err) throw err
  require('.').init(sbot, config)
})
