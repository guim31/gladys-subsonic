// -----------------------------------------------------------------------------
// Entry point of the Gladys Subsonic integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It holds
// NO Subsonic logic: all the API "work" lives in the device modules and in
// src/subsonic.js. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, checks the Subsonic server and publishes the devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isConfigured } from './src/config.js';
import { ping } from './src/subsonic.js';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
} from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered devices');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint || typeof blueprint.onSetValue !== 'function') {
    // Throw: the SDK sends a success:false acknowledgement to Gladys.
    throw new Error(`No command handler for ${device.external_id}`);
  }
  await blueprint.onSetValue(gladys, { device, feature, value, config });
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint || typeof blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
    return;
  }
  await blueprint.onPoll(gladys, config);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
// Each action declared in the `actions` field of the manifest is registered
// per key; the message resolved by the handler is displayed under the button
// (the ack is awaited under the action's `timeout_seconds`, not the usual 5 s).
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  await checkServerAndPublish();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name: no need to log it again
// here, these handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    // Fetch the config filled in by the user, then check the Subsonic server
    // and (re)publish the devices.
    config = normalizeConfig(await gladys.getConfig());
    await checkServerAndPublish();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

/**
 * Check the Subsonic server with the current config, report the
 * application-level status in the Configuration screen, and publish the
 * devices (publishDiscoveredDevices is idempotent: upsert by external_id).
 */
async function checkServerAndPublish() {
  if (!isConfigured(config)) {
    logger.info('Not configured yet: waiting for server URL and credentials');
    await gladys.setConnectionStatus(false, {
      en: 'Fill in the server URL, username and password.',
      fr: "Renseignez l'URL du serveur, l'utilisateur et le mot de passe.",
    });
    return;
  }

  try {
    const info = await ping(config);
    logger.info(
      `Subsonic server reachable: ${info.type ?? 'subsonic'} ` +
        `${info.serverVersion ?? ''} (API ${info.version})`,
    );
  } catch (err) {
    logger.error(`Subsonic server check failed: ${err.message}`);
    await gladys.setConnectionStatus(false, {
      en: `Cannot reach the Subsonic server: ${err.message}`,
      fr: `Impossible de joindre le serveur Subsonic : ${err.message}`,
    });
    return;
  }

  // The server answers: a failure past this point is about the device
  // publication (rejected payload...), not about reachability — report it
  // as such, or the status message sends the user chasing network issues.
  try {
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error(`Publishing the devices failed: ${err.message}`);
    await gladys.setConnectionStatus(false, {
      en: `Server reachable, but publishing the devices failed: ${err.message}`,
      fr: `Serveur joignable, mais la publication des appareils a échoué : ${err.message}`,
    });
  }
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Subsonic integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
