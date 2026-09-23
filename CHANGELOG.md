# Changelog

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
- Launchers install the current Node.js LTS with checksum verification and open the browser once the server is ready.
- High-DPI (Retina / iPad) meter rendering. Meters are redrawn only when they change.
- About 25× less WebSocket traffic (228 KB/s → 9 KB/s per browser on an 8-device test network): device structure is sent only when it changes, and meters are sent as compact arrays.

### Project
- Split into modules (`lib/dante`, `lib/web`). Added a test suite (`npm test`) and CI on macOS, Windows and Linux.

## 1.0.0
- Initial release.
