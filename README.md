# Dante Audio Meter Bridge

[![CI](https://github.com/mbsound/Dante-Meter-Bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/mbsound/Dante-Meter-Bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/Dependencies-0-orange.svg)](package.json)

A real-time meter bridge for **Audinate Dante** networks. Run it on any computer on the Dante network, then watch live levels for every device from any browser — a laptop, an iPad at FOH, or a phone.

- **No Dante Controller required.** The bridge subscribes to each device's meters directly, the same way Dante Controller does. It works whether zero or a dozen copies of Dante Controller are running on the network.
- **Zero dependencies.** Pure Node.js core modules. No `npm install`, no build step.

---

## Screenshots

### Transmitters
Every transmitting device with segmented meters, peak hold, latching clip indicators and dBFS readouts:

![Transmitter Overview](Screenshots/Tx%20Overview.png)

### Receivers
Each receive channel shows the transmitter it's subscribed to. Click it to jump to that transmitter channel:

![Receiver Overview](Screenshots/Rx%20Overview.png)

![Transmitter Blink](Screenshots/Tx%20Blink.png)

### Event Log
Every network event with time, severity, device and details. A dropped transmitter shows up as the device going offline, the grouped subscription failure on the receiver, then recovery:

![Event Log](Screenshots/Event%20Log.jpg)

Check any combination of filter buttons to show only those events. Here, **Device Online** and **Device Offline** are checked, so everything else is hidden:

![Event Log filtered to device online and offline](Screenshots/Event%20Log%20Filtered.jpg)

---

## Features

- **Transmitter and receiver views** with 16-channel banks for large devices.
- **Segmented meters** (-60 to 0 dBFS) with green / yellow / amber / red zones, a 1 s peak hold that then falls smoothly, and a 1.5 s clip latch. Levels update as fast as the devices send them (about 10 times per second on the devices tested).
- **Routing at a glance:** receive channels show their source device and channel, whether the subscription is actually connected, and a click-through to the transmitter.
- **Device health:** primary / secondary network sync indicators, secondary-network IP, clock leader (PTP grandmaster) highlight, and sample rate, all read from the devices. If a device doesn't report something (for example its clock status), the indicator says so instead of assuming it's fine.
- **Offline detection:** a device that goes silent for 7 seconds stays on screen, dimmed and marked **OFFLINE**, for up to a minute (or until you press **Refresh Devices**) so a dropout is easy to spot.
- **Device identity:** manufacturer, model and versions from Dante Controller's local database when it's installed, plus optional overrides you define yourself.
- **Custom tab:** build your own views of just the channels you care about, Tx and Rx from any devices, grouped by device, and save as many named layouts as you need (see below).
- **Event Log tab:** a running record of what happens on the network (see below).
- **Search** by device name, IP, model or channel name. Collapse / expand state is remembered per device.
- **NIC switching** from the header without restarting.

---

## Custom tab

The **Custom** tab shows only the channels you pick, from any number of devices, with a device's Tx and Rx channels grouped together in one card.

- **Add channels:** in the Transmitter or Receiver tab, right-click a meter (long-press on a touch screen) and choose **Add to Custom**. To add several at once, click one meter, then Cmd/Ctrl-click others or Shift-click to select a range, and right-click. **Add all Tx/Rx channels of …** adds a whole device. Channels already in the Custom view are marked with ◆.
- **Remove channels:** right-click a meter in the Custom tab and choose **Remove from Custom**, or remove a whole device with its ✕ button. **Clear Layout** empties the current layout. **Show in Transmitter/Receiver tab** jumps to the channel in its normal tab.
- **Saved layouts:** keep as many named layouts as you like (for example *FOH*, *Monitors*, *Playback*) and pick one from the **Layout** menu at the top of the Custom tab. Changes save automatically to the layout you're viewing, and it's all still there the next time you open the app. **New** starts an empty layout, **Save As…** copies the current one under a new name, and **Rename** / **Delete** do what they say.
- **Every screen, its own choice:** the layouts are stored on the bridge, so any computer or tablet viewing it can open any of them. Each screen remembers which layout it was showing; switching on the iPad doesn't change the PC. Two screens on the same layout see each other's changes immediately.
- **Export / Import:** **Export** downloads the current layout as a `.dante-layout.json` file; **Import** loads one as a new layout. Use it to back layouts up, or to move them to another computer running the bridge.
- **Where they're kept:** `custom-layout.json` next to the app (git-ignored, as it contains your device names). Change the location with `customLayoutFile` in the config file or `DANTE_CUSTOM_LAYOUT`. Devices are remembered by name, so layouts survive IP address changes; a device that isn't on the network is shown dimmed until it returns.

---

## Event Log

The **Event Log** tab records network events as they happen, with time, severity, device and details. It logs the conditions Dante Controller logs that are visible on the network, plus some Controller doesn't:

| Filter | Events |
|---|---|
| Device Online / Device Offline | A device appears, stops responding, or comes back (with how long it was gone) |
| Clock Sync | Clock sync unlocked / locked, clock sync warning (frequency offset near the device's limit) |
| Clock Leader | Elevation to / demotion from clock leader, multiple clock leaders |
| Audio Mute | Audio mute / un-mute, with the reason (sync loss, clock problem, user mute, ...) |
| Subscriptions | Resolution failed, other subscription errors, subscription restored, routing changes |
| Network | Subnet mismatch / conflict, secondary link down / up, late packets |
| Timeouts | A device that is still on the network but stops answering queries, and its recovery |
| Configuration | Device renamed, sample rate changed |
| System | Monitoring started, network interface lost / restored |

**Filtering:** click any number of filter buttons to show only those kinds of events; everything not checked is hidden. The severity buttons (Error / Warning / Info) and the search box narrow the list further. With nothing selected, everything is shown. Filters are remembered per browser.

**History:** events are saved to `logs/dante-events-YYYY-MM-DD.jsonl` (one file per day, kept for 30 days) and reloaded on restart. **Export CSV** downloads exactly what the current filters show. **Clear List** clears the on-screen list for everyone viewing the bridge; the saved files are kept.

Some Dante Controller events describe device-internal states that aren't visible on the network (for example Fail Safe Mode, fanout configuration, pullup/subdomain mismatches and "reboot required"), so they can't be logged here. The tab's **What is logged?** section lists them. Clock sync, mute and clock-warning events need the device to answer clock-status queries, which not all devices do.

---

## Quick start

### One-click (macOS & Windows)

| Platform | First time (installs Node.js if needed) | Every day after |
|---|---|---|
| **macOS** | `First Time Running - Click Here - Mac.command` | `Start Dante Meter Bridge - Mac.command` |
| **Windows** | `First Time Running - Click Here - Windows.bat` | `Start Dante Meter Bridge - Windows.bat` |

If Node.js 18 or newer isn't installed, the first-time scripts install the current LTS release: through Homebrew (macOS) or winget (Windows) when available, otherwise straight from nodejs.org with the download's SHA-256 checksum verified. Then they start the bridge and open your browser. To stop the bridge, close its window or press Ctrl+C.

> **macOS:** if the file is blocked as coming from an unidentified developer, open **System Settings → Privacy & Security** and click **Open Anyway**.

### Command line

```bash
git clone https://github.com/mbsound/Dante-Meter-Bridge.git
cd Dante-Meter-Bridge
npm start
```

Then open <http://localhost:8752>. From another device on the same network, use `http://<this-computer's-ip>:8752` — the addresses are printed at startup.

---

## Options

```
node server.js [options]

  -i, --nic <ip|name>   Network interface to use for Dante (IP address or name, e.g. en6)
  -p, --port <port>     Web UI port (default: 8752)
      --host <address>  Address the web UI listens on (default: 0.0.0.0, all interfaces)
  -c, --config <file>   Config file (default: ./dante-meter.config.json if present)
      --log-dir <dir>   Where the event log is saved (default: ./logs)
      --open            Open the UI in the default browser once started
      --debug           Verbose logging
  -v, --version         Print version and exit
  -h, --help            Show help
```

Environment variables `DANTE_IP`, `PORT`, `HOST`, `DANTE_LOG_DIR` and `DEBUG=1` work too. Precedence: command line → environment → config file → defaults.

If you don't pick a NIC, the bridge uses the first link-local (`169.254.x.x`) interface — the Dante default — and falls back to the first active interface. You can switch NICs from the UI at any time.

### Config file

Copy `dante-meter.config.example.json` to `dante-meter.config.json` (it's git-ignored, so your site details stay local):

```json
{
  "port": 8752,
  "nic": "en6",
  "deviceOverrides": {
    "Stagebox-1": { "manufacturer": "Example Audio Co", "modelName": "SB-32 Stagebox" }
  }
}
```

`deviceOverrides` sets the manufacturer / model / version shown for a device, keyed by its Dante device name. Use it for devices Dante Controller's database doesn't know about.

---

## How it works

```
Dante devices ──(UDP)──▶ Meter Bridge (Node.js) ──(WebSocket)──▶ Browsers
```

| What | How |
|---|---|
| Discovery | mDNS (`_netaudio-arc._udp`, `_netaudio-cmc._udp`), Dante heartbeats (224.0.0.233:8708), device-info multicast (224.0.0.231:8702) and probing hosts in the ARP table |
| Names, channels, routing, sample rate | ARC queries (UDP 4440) every 3 s |
| Clock and secondary network | Settings queries (UDP 8700/8702) and heartbeat link status. Devices answer these by multicast to the whole network, so the bridge asks sparingly: clock every 15 s and interfaces every 60 s per device. The clock leader is identified from the PTP grandmaster ID. |
| Levels | A metering subscription sent to each device (UDP 8800). The device then streams levels to the bridge on UDP 8751, about 10 times per second on the devices tested. The server forwards the latest levels to browsers 20 times per second, and each meter is redrawn only when its value changes. |

**Metering.** The bridge asks each device to stream its meters to this computer, identifying itself by its own MAC address. This is the same request Dante Controller sends, so each Controller and each bridge gets its own independent stream. If another app on this computer already uses port 8751, the bridge picks a free port and tells the devices to use that instead. On shutdown, the bridge tells every device to stop streaming.

**What it changes on the network.** Nothing about routing, clocking or device configuration. The only requests it makes are read-only queries and the metering subscription described above.

Receivers without their own meters show the level of the transmitter channel they're subscribed to, marked with ⇄. Transmitters without meters are inferred from a connected receiver the same way.

### JSON API

| Endpoint | Description |
|---|---|
| `GET /api/devices` | All devices with structure and current levels. `levels.tx.peak` / `levels.rx.peak` are raw Dante level bytes (`null` = no recent data). `dbfs` holds the same levels in dBFS (`null` = silent or no data). |
| `GET /api/status` | Health: version, uptime, bound interface, device counts, connected clients |
| `GET /api/network-status` | Compact per-device summary for outside tools to poll: name, online, since when, and primary / secondary status. Readable from other web pages. See [Status for other tools](#status-for-other-tools) |
| `GET` / `POST /api/preferences` | Settings from the Preferences dialog: `{"statusApi": {"enabled": true, "port": null}}` |
| `GET /api/interfaces` | Available network interfaces |
| `POST /api/interface` | Switch interface: `{"ip": "169.254.x.x"}` or `{"ip": "all"}` |
| `POST /api/refresh` | Drop offline devices and re-poll the network |
| `GET /api/events` | Logged events. Optional `category=online,offline`, `severity=error`, `limit=` |
| `GET /api/events.csv` | The same, as CSV |
| `GET /api/diagnostics` | Per-device ports, protocol, packet counters and multicast health, for troubleshooting |
| `POST /api/events/clear` | Clear the in-memory event list (files are kept) |
| `GET /api/custom-layouts` | Saved Custom layouts: `{"layouts": [{"name", "devices": [{"name", "tx": [channel numbers], "rx": [...]}]}]}` |
| `GET /api/custom-layouts/export?name=` | Download one layout as a file that **Import** accepts |

### Status for other tools

`GET /api/network-status` is a small summary meant to be polled every minute or two by something outside the bridge, such as a status board or a spreadsheet script. Answering it reads only what the bridge already holds in memory; it sends nothing to the Dante network.

The gear button in the header opens **Preferences**, where the feed can be switched off (it then answers 404) or given a port of its own. That extra port answers only this feed, so it can be opened to a wider network without exposing the rest of the bridge; the feed also stays on the web page's port. The settings are kept in `preferences.json` next to the app. `GET /api/preferences` returns them along with the addresses the feed is being served on.

```json
{
  "bridge": { "version": "2.4.0", "uptimeSec": 5400 },
  "generatedAt": "2026-01-01T12:00:00.000Z",
  "interface": { "name": "en7", "address": "169.254.10.20" },
  "summary": { "devices": 2, "online": 1, "offline": 1 },
  "devices": [
    {
      "name": "Stagebox-1",
      "online": true,
      "since": "2026-01-01T10:30:00.000Z",
      "lastSeen": "2026-01-01T11:59:59.000Z",
      "primary": { "status": "up", "ip": "169.254.1.10", "sync": "good", "clockLeader": false },
      "secondary": { "status": "up", "ip": "172.31.1.10", "sync": "good", "clockLeader": false }
    }
  ]
}
```

- `online` / `primary.status` (`up`, `down`): whether the device is answering on the primary network. `since` is when it last came online, or, if offline, when it was last heard from.
- `secondary.status`: `up` or `down` as the device itself reports its secondary link. For devices that don't report it, `up` when the secondary port is following another device's clock (so the link works). Otherwise `unknown` (also while the device is offline), or `none` if it has no secondary port. `secondary.clockLeader: true` on a device other than the primary leader usually means its secondary port is cut off from the rest. The bridge only talks to devices on the primary network.
- `sync`: `good`, `syncing`, `error`, `none` (not reported) or `unsupported`.
- A device that drops off stays in the list as offline until it returns, the bridge restarts, the interface changes, or someone presses Refresh.
- `interface` is the network the bridge is watching. If it is `null` or not your Dante interface, an empty device list means the bridge has lost the Dante network, not that every device is down.

This endpoint (and only this one) can be read by scripts on other web pages. A page served over HTTPS may still be blocked by the browser from calling a plain `http://` address; if so, run the script outside the browser or poll from a server on the same network.

---

## Network & firewall

Allow Node.js to accept incoming connections. The bridge listens on:

- **UDP 8751**: metering stream (or the fallback port shown in the log)
- **UDP 8702, 8708**: Dante device-info and heartbeat multicast
- **UDP 5353**: mDNS (or a free port if the OS is already using 5353)
- **TCP 8752** (or your `--port`): the web UI

It sends queries to devices on UDP 4440, 8700, 8702 and 8800. Replies come back to temporary ports, which stateful firewalls allow automatically.

On macOS, accept the "allow incoming connections" prompt the first time you run it.

**Windows:** Windows usually classifies a Dante network as an *Unidentified network*, which is a **Public** network. When Windows Defender Firewall asks about Node.js, tick **Public networks** as well as Private. If you've already answered, open *Windows Security → Firewall & network protection → Allow an app through firewall*, find **Node.js JavaScript Runtime**, and tick **Public**. Without this, devices still appear (the bridge's own queries get answers), but heartbeats and meter streams are blocked, so sync dots stay hollow and meters stay empty. The bridge shows an orange warning bar and logs a *Not receiving Dante multicast* event when this happens.

## Troubleshooting

- **No devices:** check the NIC selector is on your Dante network. Run with `--debug` for extra diagnostic logging.
- **Devices listed but no meters:** check the firewall allows incoming UDP on the metering port.
- **A device shows no channels or no status:** open `http://localhost:8752/api/diagnostics` and send the output with your report. It lists, per device, which ports and protocol the bridge is using, which ones answered, and packet counts by type.
- **"Port 8752 is already in use":** the bridge is probably already running. Close the other window or use `--port`.

## Development

```bash
npm test      # unit + integration tests (node:test)
npm run dev   # restart on file changes
```

Code layout: `lib/dante/` holds the protocol (pure packet builders and parsers in `packets.js` and `mdns.js`, state in `engine.js`). `lib/web/` holds the HTTP, WebSocket and API code. `public/` holds the browser UI.

## Contributing

Issues and pull requests are welcome at <https://github.com/mbsound/Dante-Meter-Bridge/issues>. When reporting a device that misbehaves, include the output of `node server.js --debug` and the device model.

## Acknowledgements

Metering-subscription, device-settings and subscription-status details were cross-checked against the public-domain [netaudio](https://github.com/chris-ritsen/network-audio-controller) project.

## License

[MIT](LICENSE)

*Dante is a registered trademark of Audinate Pty Ltd. This project is independent and not affiliated with or endorsed by Audinate.*
