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
  METERING: 8751
};

const PROTOCOL = {
  ARC: 0x2729,
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
  RX_CHANNELS: 0x3000
};

const SETTINGS_MESSAGES = {
  INTERFACE_STATUS: 17,
  INTERFACE_CONTROL: 19,
  CLOCKING_STATUS: 32,
  CLOCKING_CONTROL: 33
};

const HEARTBEAT_RECORDS = {
  PORT_STATUS: 0x8000,
  SIGNAL_PRESENCE: 0x8002
};

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
  ARC_COMMANDS,
  SETTINGS_MESSAGES,
  HEARTBEAT_RECORDS,
  RX_CONNECTED_STATUSES,
  VALID_SAMPLE_RATES,
  DEVICE_SETTINGS_SAMPLE_RATE,
  AUDINATE_MAGIC,
  TX_PAGE_SIZE,
  RX_PAGE_SIZE
};
