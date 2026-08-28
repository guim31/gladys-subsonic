// -----------------------------------------------------------------------------
// Device registry.
//
// Each device type lives in its own file and exposes the same shape:
//   - key                                : short identifier (used in logs)
//   - enabled(config)         (optional) : is the device active with this config?
//   - deviceExternalId(gladys, config)   : the device external_id (for dispatch)
//   - buildDevice(gladys, config)        : the discovery payload sent to Gladys
//   - onPoll(gladys, config)  (optional) : periodic read
//   - onSetValue(gladys, {...}) (opt.)   : run a user command
//   - actions                 (optional) : manifest action handlers, keyed by
//     the action `key` declared in gladys-assistant-integration.json
// -----------------------------------------------------------------------------

import { server } from './server.js';
import { jukebox } from './jukebox.js';
import { isConfigured } from '../config.js';

export const DEVICE_BLUEPRINTS = [server, jukebox];

/**
 * Blueprints active with the current configuration: nothing before the server
 * is configured, and the jukebox only when its toggle is on.
 */
export function activeBlueprints(config) {
  if (!isConfigured(config)) {
    return [];
  }
  return DEVICE_BLUEPRINTS.filter((bp) => bp.enabled === undefined || bp.enabled(config));
}

/**
 * Build the discovery payload for Gladys (all active devices).
 */
export function buildDiscoveredDevices(gladys, config) {
  return activeBlueprints(config).map((bp) => bp.buildDevice(gladys, config));
}

/**
 * Find the blueprint that owns a given device, from its external_id
 * (used to route onPoll / onSetValue to the right device).
 */
export function findBlueprintByDevice(gladys, device, config) {
  return DEVICE_BLUEPRINTS.find((bp) => bp.deviceExternalId(gladys, config) === device.external_id);
}
