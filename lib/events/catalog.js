'use strict';

/**
 * Every event the bridge logs, its filter category and severity, and (where
 * applicable) the Dante Controller event it corresponds to.
 */

const CATEGORIES = [
  { id: 'online', label: 'Device Online' },
  { id: 'offline', label: 'Device Offline' },
  { id: 'clock', label: 'Clock Sync' },
  { id: 'leader', label: 'Clock Leader' },
  { id: 'mute', label: 'Audio Mute' },
  { id: 'subscription', label: 'Subscriptions' },
  { id: 'network', label: 'Network' },
  { id: 'timeout', label: 'Timeouts' },
  { id: 'config', label: 'Configuration' },
  { id: 'system', label: 'System' }
];

const SEVERITIES = ['error', 'warning', 'info'];

const EVENT_TYPES = {
  device_online: { category: 'online', severity: 'info', title: 'Device online' },
  device_offline: { category: 'offline', severity: 'error', title: 'Device offline' },

  clock_unlocked: { category: 'clock', severity: 'error', title: 'Clock sync unlocked', controller: 'Clock sync lock / unlocked' },
  clock_locked: { category: 'clock', severity: 'info', title: 'Clock sync locked', controller: 'Clock sync lock / unlocked' },
  clock_warning: { category: 'clock', severity: 'warning', title: 'Clock sync warning', controller: 'Clock Sync Warning' },

  audio_mute: { category: 'mute', severity: 'error', title: 'Audio mute', controller: 'Audio mute / Audio unmute' },
  audio_unmute: { category: 'mute', severity: 'info', title: 'Audio unmute', controller: 'Audio mute / Audio unmute' },

  leader_elevated: { category: 'leader', severity: 'warning', title: 'Elevation to Clock Leader', controller: 'Elevation to Clock Leader' },
  leader_demoted: { category: 'leader', severity: 'info', title: 'Demotion from Clock Leader', controller: 'Demotion from Clock Leader' },
  multiple_leaders: { category: 'leader', severity: 'error', title: 'Multiple clock leaders' },

  subscription_unresolved: { category: 'subscription', severity: 'warning', title: 'Resolution failed', controller: 'Resolution Failed' },
  subscription_failed: { category: 'subscription', severity: 'error', title: 'Subscription error' },
  subscription_restored: { category: 'subscription', severity: 'info', title: 'Subscription restored' },
  routing_changed: { category: 'subscription', severity: 'info', title: 'Routing changed' },

  subnet_mismatch: { category: 'network', severity: 'error', title: 'Subnet mismatch on Dante interface', controller: 'Subnet mismatch on dante interface' },
  subnet_conflict: { category: 'network', severity: 'error', title: 'Subnet conflict between primary and secondary', controller: 'Subnet conflict of dante interface on primary / secondary' },
  secondary_link_down: { category: 'network', severity: 'error', title: 'Secondary network link down' },
  secondary_link_up: { category: 'network', severity: 'info', title: 'Secondary network link up' },
  late_packets: { category: 'network', severity: 'warning', title: 'Late packets' },

  response_timeout: { category: 'timeout', severity: 'warning', title: 'Response timeout', controller: 'Request / Response Timeout Error' },
  response_restored: { category: 'timeout', severity: 'info', title: 'Responding again' },

  device_renamed: { category: 'config', severity: 'info', title: 'Device renamed' },
  sample_rate_changed: { category: 'config', severity: 'warning', title: 'Sample rate changed' },

  monitoring_started: { category: 'system', severity: 'info', title: 'Monitoring started' },
  multicast_missing: { category: 'system', severity: 'warning', title: 'Not receiving Dante multicast' },
  multicast_restored: { category: 'system', severity: 'info', title: 'Dante multicast arriving' },
  metering_missing: { category: 'system', severity: 'warning', title: 'Meter streams not arriving' },
  metering_restored: { category: 'system', severity: 'info', title: 'Meter streams arriving' },
  interface_lost: { category: 'system', severity: 'warning', title: 'Network interface lost' },
  interface_restored: { category: 'system', severity: 'info', title: 'Network interface restored' }
};

/** Dante Controller events that are device-internal and not visible on the network. */
const NOT_OBSERVABLE = [
  'Invalid link local address',
  'Subnet match with non dante interface',
  'Multiple addresses with matching subnets',
  'Unknown address error',
  'Fail Safe Mode',
  'Unknown device issue',
  'Fanout Configuration detected',
  'Mismatched clock pullup subdomain',
  'Wrong subdomain for pullup',
  'Unknown subdomain',
  'Elevation to / Demotion from Primary Leader',
  'Multiple external clock sources',
  'Cannot Elevate to Clock Leader',
  'Reboot required'
];

module.exports = { CATEGORIES, SEVERITIES, EVENT_TYPES, NOT_OBSERVABLE };
