# Changelog

## 2.4.0

### Status for other tools
- New `GET /api/network-status`: a compact, read-only summary for outside tools to poll every minute or two. One entry per device by name, with online / offline and since when, primary and secondary status, sync and clock leader. Devices that drop off stay listed as offline.
- It can be read by scripts on other web pages; every other endpoint keeps its existing restrictions. Polling it adds no traffic to the Dante network.

## 2.3.1

### Devices online
- The header now shows how many devices are on the network at this moment, next to the NIC selector, on every tab. If any are offline it shows how many, and the tooltip names them.

### Clock leaders
- Primary and secondary clock leaders are told apart, from the per-port clock state devices report. More than one leader on the primary network is still an error (**Multiple primary clock leaders**); more than one on the secondary network is a new warning (**Multiple secondary clock leaders**), which usually means a secondary port is unplugged or cut off from the rest.
- Hovering a device's sync dots says whether it is the clock leader on that network.

### Event Log
- The filter buttons' numbers count log entries (a device that dropped and returned five times adds five to "Device Online"); each button's tooltip now says so.
- A device coming back online no longer also logs "Response timeout … not answering queries" for the time it was away.
- "Multiple clock leaders" is only logged when the conflict lasts 5 seconds. A device rejoining the network briefly elects itself leader, which is normal.
- A device that has gone offline no longer counts as a clock leader from its last reply.
- A subscription re-patched to a different source is now logged as a routing change even when it passes through "in progress" first, and is no longer reported as "connected again".
- Renaming the clock leader is logged as a rename only, not as one device losing the clock and another taking it.
- A device that returns on a new address is no longer logged as going offline at its old one, and its old entry is dropped straight away instead of lingering as an offline duplicate.
- The log keeps working if its folder is deleted while the bridge runs (it used to stop saving and could crash at the next clean-up).
- The Event Log tab's error badge clears when the list is cleared.

### Meters and Custom tab
- Peak hold works again after a channel's first loud peak (the hold marker used to disappear until Reset Peaks).
- When the browser loses the bridge, meters go blank instead of freezing on their last levels, and a silent connection is detected and reconnected within a few seconds.
- A screen showing a layout that another screen renames now follows the rename instead of jumping to a different layout.
- Selecting channels of Custom devices that aren't on the network no longer selects the same channel number on every missing device.
- If a layout can't be written to disk you are told, rather than it appearing saved and vanishing on restart. One invalid entry in `custom-layout.json` no longer discards the whole file, and an unreadable file is kept as `custom-layout.json.unreadable`.
- Very long layout names can no longer cause a new layout to overwrite another.
- Footer statistics are correct on the Event Log tab; the footer is no longer hidden behind the browser's bars on phones.

### Network interfaces
- An interface you chose is kept after it drops and returns, even when a link-local interface is also present.
- Started with no network connected, the bridge now binds to the first interface that comes up instead of waiting for you to pick one.
- After switching interface, late packets from the old network no longer re-add its devices.
- Identity from an override or the Dante Controller database is cleared when the device is renamed away from it.
- Channel listing no longer loops on devices with several pages of non-audio (video) channels.

### Security and robustness
- A dropped connection during a refused WebSocket handshake could crash the bridge. Fixed.
- Requests that change the bridge (select interface, refresh, clear the log) are refused when they come from another website open in a browser. The bridge's own pages and non-browser clients such as Companion are unaffected.
- `/api/events?limit=` ignores negative and fractional values; a malformed `POST /api/interface` body returns 400.
- Windows launchers work from a network share.

## 2.3.0

### Saved Custom layouts
- Save any number of named Custom layouts and switch between them from the **Layout** menu at the top of the Custom tab. **New**, **Save As…**, **Rename** and **Delete**; changes save automatically to the layout you're viewing.
- Layouts are stored on the bridge and available to every screen; each screen remembers which layout it shows, so switching on one screen doesn't change another.
- **Export** downloads a layout as a `.dante-layout.json` file and **Import** loads one as a new layout, for backups or moving layouts to another computer.
- An existing 2.2.0 Custom layout is kept automatically as "Layout 1".
- `GET /api/custom-layouts` lists them (replaces `/api/custom-layout`); `GET /api/custom-layouts/export?name=` downloads one.
- The toolbar's **Clear Custom** is now **Clear Layout**.

### Fixes
- Narrow screens (phones, iPad portrait) no longer scroll sideways: the toolbar and device headers wrap.

## 2.2.0

### Custom tab
- New **Custom** tab showing only the channels you pick, from any devices, with each device's Tx and Rx channels grouped in one card.
- Right-click a meter (long-press on touch screens) for **Add to Custom** / **Remove from Custom**, **Add all Tx/Rx channels of a device** and **Show in Transmitter/Receiver tab**. Click, Cmd/Ctrl-click and Shift-click select several meters at once, across devices. Channels in the Custom view are marked with ◆ in the normal tabs.
- The layout is saved on the bridge (`custom-layout.json`, git-ignored) and shared live with every screen viewing it. Devices are remembered by name, so it survives IP changes. `GET /api/custom-layout` returns it.


### Fixes
- **Dante Virtual Soundcard (4.x) still showed no Tx channels.** Newer Dante software advertises a modern control protocol in mDNS (`arcp_vers`, e.g. 2.8.9 → ARC protocol 0x2809) and does not answer the older channel queries. The bridge now reads `arcp_vers` and, for modern devices, lists Tx and Rx channels (with subscriptions and sample rate) through the paged channel-status inventory, using netaudio's exact packet framing. Verified on a 19-device network: Dante Virtual Soundcard (0x2809), Yamaha Rio3224 (0x280C), Prodigy (0x280F) and others now use it; older devices are queried as before. A device that answers a 0x2809 probe but rejects the modern inventory falls back to the older queries.
- **Rx subscriptions were missing on many devices.** The Rx channel query sent the page's channel count where devices expect the constant 0x0001, so they rejected it (result 0x22) and their Rx channels never showed sources. It now matches netaudio byte-for-byte; verified on Yamaha and Audinate-module devices.
- Rx channels reported for the first time are no longer logged as "Routing changed" at startup.
- **The bridge stayed on the wrong network after the Dante cable was pulled.** When the Dante interface disappeared, the bridge moved to another interface and never came back. It now switches back as soon as that adapter has an address again, even if the new link-local address is different. If it had picked a non-Dante interface automatically, it also switches to a Dante (169.254.x.x) interface that appears later. An interface you chose in the NIC menu is never changed automatically. The NIC menu now updates when adapters gain or lose addresses, and the Event Log records "Network interface restored".

### Added
- `/api/diagnostics` shows each device's advertised `arcp_vers`, which channel inventory it uses, and the last ARC error code the device returned.

## 2.1.1

### Fixes
- **Device names and ports could land on the wrong device.** When a computer's own mDNS responder (common on Windows, e.g. alongside Dante Virtual Soundcard) relayed another device's advertisement, the bridge attributed that name and its ARC/CMC ports to the relaying computer. The Event Log then showed two devices "swapping" names, and the bridge queried the wrong port. mDNS answers are now only trusted when they include the device's own address, and a device's own ARC reply is always authoritative for its name.
- **Dante Virtual Soundcard showed no Tx channels.** ARC replies are now accepted with every Dante ARC protocol ID (not only 0x2729). Until a device answers, the bridge tries protocols 0x2729 / 0x27FF and ports 4440 / 4455, and CMC on 8800 / 38800, then keeps whichever the device answers on.
- **Primary sync status missing on many devices.** The bridge now also sends the clock-status query netaudio uses (a read-only clock-control query), which more devices answer.

### Added
- Warning bar and Event Log entries when devices answer but no Dante multicast (heartbeats) or meter streams arrive, the usual sign of a firewall (on Windows, a Public network profile).
- `GET /api/diagnostics`: per-device ports, ARC protocol, packet counters and multicast health.
- README: Windows Firewall steps.

## 2.1.0

### Event Log tab
- New **Event Log** tab recording network events with time, severity, device and details: device online / offline (with outage duration), clock sync unlocked / locked / warning, audio mute / un-mute with reasons, clock leader elevation / demotion and multiple leaders, resolution failures and other subscription errors, subscription restored, routing changes, subnet mismatch / conflict, secondary link down / up, late packets, response timeouts, renames, sample rate changes and system events.
- Multi-select filter buttons per event type (only checked types are shown), severity filters, search, CSV export of the filtered view.
- Saved to daily files under `logs/` (30-day retention, `--log-dir` / `logDir` / `logRetentionDays`) and reloaded on restart. Also available at `/api/events` and `/api/events.csv`.
- A red badge on the tab counts new errors since the log was last opened.

### Fixes
- Clock status: the port count was read from the wrong byte, so every device was treated as dual-port.
- Rx channels whose status is 1 with a live dynamic flow are now treated as connected.
- The header tabs wrap onto their own row on narrow screens instead of running off the edge.

## 2.0.0

### Metering
- **Meters no longer need Dante Controller.** The bridge sends the same per-device metering subscription Dante Controller uses, so it works whether zero or any number of Controllers are running. Previously, meters only worked when Dante Controller's agent was running on the same computer.
- If UDP 8751 is already taken, the bridge uses a free port and tells devices to use it.
- The bridge unsubscribes from devices on shutdown and on NIC change.
- Channels with no level data show `—` instead of a fake silent meter.

### Accuracy
- Sample rate is read from the device. It used to be hardcoded to 48 kHz.
- The clock leader comes from the PTP grandmaster ID. The old version guessed (preferring certain console models by name, otherwise whichever device was first in the list).
- Secondary-network IPs come only from the device. They are no longer derived from the primary IP.
- Sync indicators show "no status reported" instead of defaulting to green.
- Subscription status recognises every connected state (loopback, dynamic, static, manual). Unresolved subscriptions are shown differently in the UI.
- Meter scale labels line up with the meter curve.

### Privacy / sanitisation
- Removed all hardcoded site-specific device names, IP addresses and device hashes. Identity now comes from the local Dante Controller database (matched by mDNS manufacturer and model IDs) or from `deviceOverrides` in a local, git-ignored config file.

### Security & robustness
- Fixed path traversal in the static file server (e.g. `GET /../server.js`).
- Fixed HTML injection from device and channel names in the UI.
- WebSocket: proper frame parsing (split and fragmented frames), close handshake, ping/pong keepalive, dead-client detection, backpressure, same-origin check.
- A malformed network packet can no longer crash the server, and a zero-length heartbeat record can no longer hang it.
- Removed blocking shell commands from the discovery loop. Commands now run asynchronously without a shell.
- Content-Security-Policy and other security headers.
- A phantom device no longer appears at the bridge's own IP when macOS relays cached mDNS answers.

### Usability
- Offline devices stay visible (dimmed, marked **OFFLINE**) instead of disappearing.
- Devices are sorted by name. Search also matches channel names.
- `--help`, `--version`, `--host`, `--open`, `--debug` and a config file. Friendly message when the port is in use.
- Launchers install the current Node.js LTS (Homebrew / winget, or a checksum-verified download from nodejs.org) and open the browser once the server is ready.
- The bridge also unsubscribes from devices when its terminal window is closed (SIGHUP).
- High-DPI (Retina / iPad) meter rendering. Meters are redrawn only when they change.
- About 25× less WebSocket traffic (228 KB/s → 9 KB/s per browser on an 8-device test network): device structure is sent only when it changes, and meters are sent as compact arrays.

### Project
- Split into modules (`lib/dante`, `lib/web`). Added a test suite (`npm test`) and CI on macOS, Windows and Linux.

## 1.0.0
- Initial release.
