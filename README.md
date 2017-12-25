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

Find [this guide](%VaSj08AbdhIa4itK4z8Z91G80o2h5OhRLCEEO6MhAcU=.sha256) [on github](https://github.com/noffle/sailing-patchfoo) or [on
SSB](http://git.scuttlebot.io/%25VaSj08AbdhIa4itK4z8Z91G80o2h5OhRLCEEO6MhAcU%3D.sha256).

## Install

Requirements:

- [scuttlebot][]
- [ssb-npm-registry][]
- [git-ssb][]

```sh
git clone ssb://%YAg1hicat+2GELjE2QJzDwlAWcx0ML+1sXEdsWwvdt8=.sha256 patchfoo
cd patchfoo
npm install --registry=http://localhost:8043/
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
    "host": "::",
    "filter": "all",
    "showPrivates": true,
    "previewVotes": true,
    "ooo": true,
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
- `auth`: HTTP auth password. default: `null` (no password required)
- `filter`: Filter setting. `"all"` to show all messages. `"invert"` to show messages that would be hidden by the default setting. Otherwise the default setting applies, which is so to only show messages authored or upvoted by yourself or by a feed that you you follow. Exceptions are that if you navigate to a user feed page, you will see messages authored by that feed, and if you navigate to a message page, you will see that message - regardless of the filter setting. The `filter` setting may also be specified per-request as a query string parameter.
- `showPrivates`: Whether or not to show private messages. Default is `true`. Overridden by `filter=all`.
- `previewVotes`: Whether to preview creating votes/likes/digs (`true`) or publish them immediately (`false`). default: `false`
- `ooo`: if true, use `ssb-ooo` to try to fetch missing messages in threads. also can set per-request with query string `?ooo=1`. default: `false`

## TODO

- Add a way to assist picking feed ids for `@mentions` in composer.
- Add more sophisticated private messages view.
- Show contents of git repos (cross-develop with [patchbay])
- Count digs
- Show network status
- Add UI for using pub invites

[scuttlebot]: %M0TrM+oJT2i/phUJO/fZ2wkK2AN2FB1xK0tqR7SNj58=.sha256
[patchbay]: %s9mSFATE4RGyJx9wgH22lBrvD4CgUQW4yeguSWWjtqc=.sha256
[ssb-npm-registry]: %59m0nJQ/YOnxkPi7QfBphcOtuwCgamUgoVHtBhCEq7k=.sha256
[git-ssb]: %n92DiQh7ietE+R+X/I403LQoyf2DtR3WQfCkDKlheQU=.sha256

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
