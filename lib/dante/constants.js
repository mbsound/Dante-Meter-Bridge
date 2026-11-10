'use strict';

const SERVICES = {
  ARC: '_netaudio-arc._udp.local',
  CMC: '_netaudio-cmc._udp.local'
};

const MULTICAST = {
  INFO: '224.0.0.231',
  HEARTBEAT: '224.0.0.233',
  MDNS: '224.0.0.251'
};

const PORTS = {
  ARC: 4440,
  SETTINGS: 8700,
  INFO: 8702,
  HEARTBEAT: 8708,
  CMC: 8800,
  MDNS: 5353,
  METERING: 8751,
  ARC_ALTERNATE: 4455, // netaudio's secondary ARC port; tried when a device never answers on 4440
  CMC_DVS: 38800 // Dante Virtual Soundcard's CMC port (per the original Companion module)
};

const PROTOCOL = {
  ARC: 0x2729,
  ARC_DEFAULT: 0x27ff, // netaudio's default protocol ID for basic queries (name, channel counts)
  ARC_MODERN: 0x2809, // newer Dante software (e.g. Dante Virtual Soundcard 4.x advertises arcp_vers=2.8.9)
  SETTINGS: 0xffff,
  CMC: 0x1200,
  HEARTBEAT: 0xfffe
};

const ARC_COMMANDS = {
  CHANNEL_COUNTS: 0x1000,
  DEVICE_NAME: 0x1002,
  DEVICE_SETTINGS: 0x1100,
  TX_CHANNELS: 0x2000,
  TX_FRIENDLY_NAMES: 0x2010,
  RX_CHANNELS: 0x3000,
  // Paged channel inventory used by modern ARC protocols (0x2809 / 0x280C / 0x280F)
  TX_CHANNEL_STATUS: 0x2400,
  RX_CHANNEL_STATUS: 0x3400
};

const ARC_RESULTS = { SUCCESS: 0x0001, MORE_PAGES: 0x8112 };

// Protocol IDs a device may use on ARC replies (per the netaudio project).
const KNOWN_ARC_PROTOCOLS = [0x2729, 0x27ff, 0x2801, 0x2809, 0x280c, 0x280f]; // ascending
const ARC_PROTOCOL_IDS = new Set(KNOWN_ARC_PROTOCOLS);
const MODERN_ARC_PROTOCOLS = new Set([0x2809, 0x280c, 0x280f]);

const SETTINGS_MESSAGES = {
  INTERFACE_STATUS: 17,
  INTERFACE_CONTROL: 19,
  CLOCKING_STATUS: 32,
  CLOCKING_CONTROL: 33
};

const HEARTBEAT_RECORDS = {
  PORT_STATUS: 0x8000,
  CLOCK_OFFSET: 0x8001,
  SIGNAL_PRESENCE: 0x8002,
  LATE_PACKETS: 0x8004
};

// Human-readable Rx subscription states (as Dante Controller names them).
const SUBSCRIPTION_STATUS_NAMES = {
  0: 'None', 1: 'Unresolved', 2: 'Resolved', 3: 'Resolve Fail', 4: 'Subscribe Self', 5: 'Resolved None',
  7: 'Idle', 8: 'In Progress', 9: 'Connected (Unicast)', 10: 'Connected (Multicast)', 14: 'Manually Configured',
  15: 'No Connection', 16: 'Channel Format Mismatch', 17: 'Flow Format Mismatch', 18: 'No Rx Flows',
  19: 'Rx Fail', 20: 'No Tx Flows', 21: 'Tx Fail', 22: 'Rx Bandwidth Exceeded', 23: 'Tx Bandwidth Exceeded',
  24: 'Tx Rejected Address', 25: 'Invalid Message', 26: 'Latency Mismatch', 27: 'Clock Domain Mismatch',
  28: 'Unsupported', 29: 'Rx Link Down', 30: 'Tx Link Down', 31: 'Dynamic Protocol', 32: 'Invalid Channel',
  33: 'Tx Scheduler Failure', 34: 'Subscribe Self Disallowed', 35: 'Tx Not Ready', 36: 'Rx Not Ready',
  37: 'Fanout Limit Reached', 38: 'Tx Channel Encrypted', 39: 'Tx Response Unexpected', 255: 'System Failure'
};

// Subscription states that are transient (still being set up), not errors.
const RX_PENDING_STATUSES = new Set([2, 7, 8]);

// Clock mute reasons (bit flags in the clock status extension).
/** PTP port state of a port that is the clock leader on its network. */
const PTP_PORT_LEADER = 6;

const CLOCK_MUTE_REASONS = [
  [1, 'synchronization loss'],
  [2, 'external clock problem'],
  [4, 'internal clock problem'],
  [8, 'PTP state unknown'],
  [16, 'user mute']
];

// Rx subscription states that mean audio is actually flowing:
// 4 = subscribed to own Tx (loopback), 9 = dynamic, 10 = static, 14 = manual.
const RX_CONNECTED_STATUSES = new Set([4, 9, 10, 14]);

// ARC device-settings record carrying the sample rate.
const DEVICE_SETTINGS_SAMPLE_RATE = 0x8020;

const VALID_SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

const AUDINATE_MAGIC = Buffer.concat([Buffer.from('Audinate', 'ascii'), Buffer.from('0734', 'hex')]);

// ARC queries page through channels in fixed-size blocks.
const TX_PAGE_SIZE = 32;
const RX_PAGE_SIZE = 16;

module.exports = {
  SERVICES,
  MULTICAST,
  PORTS,
  PROTOCOL,
  ARC_PROTOCOL_IDS,
  KNOWN_ARC_PROTOCOLS,
  MODERN_ARC_PROTOCOLS,
  ARC_COMMANDS,
  ARC_RESULTS,
  SETTINGS_MESSAGES,
  HEARTBEAT_RECORDS,
  RX_CONNECTED_STATUSES,
  RX_PENDING_STATUSES,
  SUBSCRIPTION_STATUS_NAMES,
  CLOCK_MUTE_REASONS,
  PTP_PORT_LEADER,
  VALID_SAMPLE_RATES,
  DEVICE_SETTINGS_SAMPLE_RATE,
  AUDINATE_MAGIC,
  TX_PAGE_SIZE,
  RX_PAGE_SIZE
};
