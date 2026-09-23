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
Every transmitting device with 60 FPS segmented meters, peak hold, latching clip indicators and dBFS readouts:

![Transmitter Overview](Screenshots/Tx%20Overview.png)

### Receivers
Each receive channel shows the transmitter it's subscribed to. Click it to jump to that transmitter channel:

![Receiver Overview](Screenshots/Rx%20Overview.png)

![Transmitter Blink](Screenshots/Tx%20Blink.png)

---

## Features

- **Transmitter and receiver views** with 16-channel banks for large devices.
- **Segmented meters** (-60 to 0 dBFS) with green / yellow / amber / red zones, peak hold and a 1.5 s clip latch.
- **Routing at a glance:** receive channels show their source device and channel, whether the subscription is actually connected, and a click-through to the transmitter.
- **Device health:** primary / secondary network sync indicators, secondary-network IP, clock leader (PTP grandmaster) highlight, and sample rate — all read from the devices, never guessed.
- **Offline detection:** a device that drops off the network stays on screen, dimmed and marked **OFFLINE**, until it returns or you press **Refresh Devices**.
- **Device identity:** manufacturer, model and versions from Dante Controller's local database when it's installed, plus optional overrides you define yourself.
- **Search** by device name, IP, model or channel name. Collapse / expand state is remembered per device.
- **NIC switching** from the header without restarting.

---

## Quick start

### One-click (macOS & Windows)

| Platform | First time (installs Node.js if needed) | Every day after |
|---|---|---|
| **macOS** | `First Time Running - Click Here - Mac.command` | `Start Dante Meter Bridge - Mac.command` |
| **Windows** | `First Time Running - Click Here - Windows.bat` | `Start Dante Meter Bridge - Windows.bat` |

The first-time scripts install the current Node.js LTS from nodejs.org (verifying its SHA-256 checksum) if Node.js 18+ isn't already present, then start the bridge and open your browser.

> **macOS:** if you see "cannot be opened because it is from an unidentified developer", right-click the file and choose **Open**.

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
      --open            Open the UI in the default browser once started
      --debug           Verbose logging
  -v, --version         Print version and exit
  -h, --help            Show help
```

Environment variables `DANTE_IP`, `PORT`, `HOST` and `DEBUG=1` work too. Precedence: command line → environment → config file → defaults.

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
| Clock and secondary network | Settings queries (UDP 8700/8702) and heartbeat link status. The clock leader is identified from the PTP grandmaster ID. |
| Levels | A metering subscription sent to each device (UDP 8800). The device then streams levels to the bridge at 10 Hz on UDP 8751. |

**Metering.** The bridge asks each device to stream its meters to this computer, identifying itself by its own MAC address. This is the same request Dante Controller sends, so each Controller and each bridge gets its own independent stream. If another app on this computer already uses port 8751, the bridge picks a free port and tells the devices to use that instead. On shutdown, the bridge tells every device to stop streaming.

**What it changes on the network.** Nothing about routing, clocking or device configuration. The only requests it makes are read-only queries and the metering subscription described above.

Receivers without their own meters show the level of the transmitter channel they're subscribed to, marked with ⇄. Transmitters without meters are inferred from a connected receiver the same way.

### JSON API

| Endpoint | Description |
|---|---|
| `GET /api/devices` | All devices with structure and current levels (`peak` = raw Dante byte, `dbfs` = level; `null` = silence / no data) |
| `GET /api/status` | Health: version, uptime, bound interface, device counts, connected clients |
| `GET /api/interfaces` | Available network interfaces |
| `POST /api/interface` | Switch interface: `{"ip": "169.254.x.x"}` or `{"ip": "all"}` |
| `POST /api/refresh` | Drop offline devices and re-poll the network |

---

## Network & firewall

Allow incoming traffic for Node.js on the Dante interface:

- **UDP 8751** — metering stream (or the fallback port shown in the log)
- **UDP 4440, 8700, 8702, 8708, 8800, 5353** — discovery and device queries
- **TCP 8752** (or your `--port`) — the web UI

On macOS, accept the "allow incoming connections" prompt the first time you run it. On Windows, allow Node.js through Windows Defender Firewall on **Private** networks.

## Troubleshooting

- **No devices:** check the NIC selector is on your Dante network. Run with `--debug` for per-packet logging.
- **Devices listed but no meters:** check the firewall allows incoming UDP on the metering port.
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
