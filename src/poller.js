// -----------------------------------------------------------------------------
// The container's own polling timer.
//
// The devices are published with `should_poll: true` and a valid
// `poll_frequency`, but the core cannot be trusted to call onPoll: Gladys
// 5.2.0 skips devices created without `should_poll`, and a device keeps the
// polling fields it was created with, even once the core is fixed
// (GladysAssistant/Gladys#3198). So the container polls by itself, at the
// configured pace, and the core's onPoll stays as a fallback.
//
// No double work: the timer skips a device polled less than half a period
// ago (by the core), and the core's onPoll skips a device polled less than
// 90 % of a period ago — so while the timer runs, the core never reads the
// server, even when the device kept a shorter poll_frequency from its
// creation (Gladys#3198); it takes over only if the timer stalls.
//
// Only the devices the user added to Gladys are polled (`gladys.devices`):
// the core drops the states of a device it does not know, so reading the
// server for them would be traffic for nothing — as before, when the core
// was the only one polling.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { activeBlueprints, findBlueprintByDevice } from './devices/index.js';
import { pollFrequencyMs } from './config.js';
import { createIssueLog } from './issues.js';

const logger = createLogger({ name: 'poller' });

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
 * @param {() => object} options.getConfig the current normalized config
 * @param {boolean} [options.timers] run the periodic timer (tests may turn it off)
 * @param {() => number} [options.now]
 */
export function createPoller({ gladys, getConfig, timers = true, now = () => Date.now() }) {
  const issues = createIssueLog(logger);
  /** When each device type was last polled (start of the poll), by blueprint key. */
  const lastPolledAt = new Map();
  /** Polls in progress, by blueprint key: a second caller waits for the same one. */
  const inFlight = new Map();
  let timer = null;
  let stopped = false;

  const periodMs = () => pollFrequencyMs(getConfig());

  /** The pollable device types whose device the user added to Gladys. */
  function createdBlueprints(config) {
    const created = new Set((gladys.devices ?? []).map((device) => device.external_id));
    return activeBlueprints(config).filter(
      (bp) => typeof bp.onPoll === 'function' && created.has(bp.deviceExternalId(gladys, config)),
    );
  }

  /**
   * Poll one device type, unless it was polled less than `minGap` periods ago.
   * Forced (new config, device just created): waits for a poll in progress,
   * which may predate the change, then polls again with the current config.
   * @throws the poll error (logged once while it lasts)
   */
  async function pollBlueprint(bp, { force = false, minGap = 0.5 } = {}) {
    let running = inFlight.get(bp.key);
    while (running && force) {
      await running.catch(() => {});
      running = inFlight.get(bp.key);
    }
    if (running) {
      return running;
    }
    const last = lastPolledAt.get(bp.key);
    if (!force && last !== undefined && now() - last < periodMs() * minGap) {
      logger.debug(`${bp.key}: polled ${now() - last} ms ago, skipped`);
      return undefined;
    }
    const config = getConfig();
    if (force) {
      // Whatever the poll in progress stored (a cover) predates the change.
      bp.forgetPublished?.();
    }
    lastPolledAt.set(bp.key, now());
    const run = (async () => {
      try {
        await bp.onPoll(gladys, config);
        issues.ok(bp.key, `${bp.key}: polling works again`);
      } catch (err) {
        issues.fail(bp.key, `${bp.key}: polling failed (${err.message})`);
        throw err;
      }
    })();
    inFlight.set(bp.key, run);
    try {
      return await run;
    } finally {
      inFlight.delete(bp.key);
    }
  }

  /** One cycle: every added device, errors logged (never thrown). */
  async function cycle({ force = false } = {}) {
    if (gladys.connected === false) {
      logger.debug('Gladys unreachable: poll skipped');
      return;
    }
    await Promise.all(
      createdBlueprints(getConfig()).map((bp) => pollBlueprint(bp, { force }).catch(() => {})),
    );
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!timers || stopped) {
      return;
    }
    timer = setTimeout(async () => {
      timer = null;
      try {
        await cycle();
      } catch (err) {
        logger.error(`Polling cycle failed (${err.message})`);
      } finally {
        schedule();
      }
    }, periodMs());
  }

  const api = {
    /**
     * Register the polling handlers on the Gladys client: the core's onPoll
     * (fallback), and an immediate poll of a device the user just added or
     * updated — the SDK forgot what it had published for it, everything is
     * sent again now rather than up to a period later.
     */
    register() {
      gladys.onPoll((device) => api.pollFromCore(device));
      gladys.onDeviceCreated((device) => api.pollDevice(device));
      gladys.onDeviceUpdated((device) => api.pollDevice(device));
    },

    /**
     * (Re)start: a new config, a (re)connection. Forgets the previous
     * polls, polls every added device now, then every period.
     */
    async restart() {
      stopped = false;
      lastPolledAt.clear();
      schedule();
      await cycle({ force: true });
    },

    /**
     * The core's onPoll (fallback): polls the device unless the timer just did.
     * @param {{ external_id: string }} device
     */
    async pollFromCore(device) {
      const bp = findBlueprintByDevice(gladys, device, getConfig());
      if (!bp || typeof bp.onPoll !== 'function') {
        logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
        return;
      }
      await pollBlueprint(bp, { minGap: 0.9 });
    },

    /**
     * A device was just added (or updated) in Gladys: send its states now,
     * rather than up to a period later. Errors are logged, not thrown.
     * @param {{ external_id: string }} device
     */
    async pollDevice(device) {
      const bp = findBlueprintByDevice(gladys, device, getConfig());
      if (!bp || typeof bp.onPoll !== 'function') {
        return;
      }
      await pollBlueprint(bp, { force: true }).catch(() => {});
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
  return api;
}
