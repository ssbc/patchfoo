# patchfoo

Plain SSB web UI. Uses HTML forms instead of client-side JS. Designed for use on low-power and low-resource computers.

## Goals

- Support all message schemas commonly used in the main SSB network.
- Make efficient use of screen space, memory, and CPU.
- Run well in [dillo](http://dillo.org/) browser.
- Serve as a place for experimenting with new HTML-based SSB UIs.

## Features

- Render messages with author name and icons.
- Render core ssb message types, git-ssb message types, and raw messages.
- View public log, private log, user feeds, channels, and search.
- Paginate views bidirectionally.
- Compose, preview and publish public and private messages.
- *and more*

## Joining SSB with Patchfoo

Find this guide [on github](https://github.com/noffle/sailing-patchfoo) or [on
SSB](http://git.scuttlebot.io/%25VaSj08AbdhIa4itK4z8Z91G80o2h5OhRLCEEO6MhAcU%3D.sha256).

## Install & Run

```sh
git clone ssb://%YAg1hicat+2GELjE2QJzDwlAWcx0ML+1sXEdsWwvdt8=.sha256 patchfoo
cd patchfoo
npm install
npm start
```

Alternatively, install as an sbot plugin (advanced):

```sh
cd ~/.ssb/node_modules
git clone ssb://%YAg1hicat+2GELjE2QJzDwlAWcx0ML+1sXEdsWwvdt8=.sha256 patchfoo
cd patchfoo
npm install
sbot plugins.enable patchfoo
# restart sbot
```

## Install extras

To most effectively render things, patchfoo needs the `ssb-backlinks` scuttlebot
plugin:

```sh
sbot plugins.install ssb-backlinks
sbot plugins.enable ssb-backlinks
# restart sbot
```

## Config

Pass config options with args
e.g. `npm start -- --patchfoo.port 8027` if running standalone,
or `sbot server --patchfoo.port 8027` if running as an sbot plugin.
To make config options persistent, set them in `~/.ssb/config`, e.g.:
```json
{
  "patchfoo": {
    "port": 8027,
    "host": "::"
  }
}
```

### Config options

- `port`: port for the server to listen on. default: `8027`
- `host`: host address for the server to listen on. default: `localhost`
- `base`: base url that the app is running at. default: `/`
- `blob_base`: base url for links to ssb blobs. default: same as `base`
- `img_base`: base url for blobs embedded as images. default: same as `base`
- `emoji_base`: base url for emoji images. default: same as `base`
- `encode_msgids`: whether to URL-encode message ids in local links. default: `true`

## TODO

- Add a way to assist picking feed ids for `@mentions` in composer.
- Add more sophisticated private messages view.
- Show contents of git repos (cross-develop with [patchbay])
- Count digs
- Show network status
- Add UI for using pub invites

[patchbay]: %s9mSFATE4RGyJx9wgH22lBrvD4CgUQW4yeguSWWjtqc=.sha256

## License

Copyright (C) 2017 Secure Scuttlebutt Consortium

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
