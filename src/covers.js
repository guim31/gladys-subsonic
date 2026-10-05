// -----------------------------------------------------------------------------
// Covers of the dashboard widgets.
//
// A widget content never carries an image, only a KEY: the core asks the
// integration for the bytes through onWidgetGetImage, and caches a validated
// image ONE HOUR by key. So the key embeds the cover art id (a new cover is a
// new key), and the registry remembers which id a key stands for — the id is
// not recoverable from the key, which only allows `[a-z0-9-]`.
//
// The core refuses (never recompresses) an image over 300 KB decoded: a cover
// is asked to the server at the width a list thumbnail or a 16:9 frame
// renders, and smaller if it still does not fit.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { getCoverArt } from './subsonic.js';

const logger = createLogger({ name: 'covers' });

/** Width asked to the server, in pixels: a list thumbnail or a contained cover. */
export const COVER_SIZE = 300;

// Smaller sizes tried when the server ignores the size parameter or
// re-encodes poorly.
const FALLBACK_SIZES = [COVER_SIZE, 160];

// Bound of the core on a widget image, decoded.
export const MAX_WIDGET_IMAGE_BYTES = 300 * 1024;

// Ids remembered: the covers of a few contents, not the whole library.
const MAX_REGISTERED = 64;

const IMAGE_KEY_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The image types the core accepts (checked by magic numbers on its side).
const WIDGET_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Image key of a cover (`^[a-z0-9][a-z0-9-]{0,63}$`):
 * `cover-<id>-<hash>-<size>`, the id reduced to its letters and digits and
 * cut, plus 8 hex characters of a sha1 of the raw id: two ids that reduce
 * to the same letters (`al-1` and `al1`), or share their first 40, never
 * share a key — the core would serve the wrong cover for an hour.
 * @param {string} coverArtId the `coverArt` of a song or album entry
 * @param {number} [size]
 * @returns {string}
 */
export function coverImageKey(coverArtId, size = COVER_SIZE) {
  const raw = String(coverArtId);
  const safe = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `cover-${(safe || 'x').slice(0, 40)}-${hash}-${size}`;
}

/**
 * A bounded registry of the cover ids handed out to the widgets.
 * @returns {{ register: (coverArtId: string) => string,
 *   lookup: (key: string) => string|undefined, size: () => number }}
 */
export function createCoverRegistry() {
  const covers = new Map();
  return {
    /** Record a cover art id and return its image key. */
    register(coverArtId) {
      const key = coverImageKey(coverArtId);
      // Re-insert: the Map keeps insertion order, the oldest goes first.
      covers.delete(key);
      covers.set(key, String(coverArtId));
      while (covers.size > MAX_REGISTERED) {
        covers.delete(covers.keys().next().value);
      }
      return key;
    },
    /** The cover art id behind a key, undefined when never registered. */
    lookup(key) {
      return covers.get(key);
    },
    size() {
      return covers.size;
    },
  };
}

/**
 * Split the `<mime>;base64,<data>` string of getCoverArt.
 * @param {string} image
 * @returns {{ mime: string, base64: string }}
 */
export function splitDataImage(image) {
  const marker = ';base64,';
  const at = String(image).indexOf(marker);
  if (at < 0) {
    return { mime: '', base64: String(image) };
  }
  return { mime: image.slice(0, at), base64: image.slice(at + marker.length) };
}

/**
 * The raw base64 of a cover for a widget, small enough for the core.
 * @param {object} config normalized config
 * @param {string} coverArtId
 * @returns {Promise<string>} raw base64, no `data:` prefix
 * @throws when the server has no usable image for this id
 */
export async function widgetCoverArt(config, coverArtId) {
  let reason = '';
  for (const size of FALLBACK_SIZES) {
    const { mime, base64 } = splitDataImage(await getCoverArt(config, coverArtId, size));
    const type = mime.toLowerCase().trim();
    if (!WIDGET_IMAGE_MIMES.has(type)) {
      // The core only renders JPEG, PNG and WebP: a server answering with
      // another type (an SVG placeholder, a GIF) may still re-encode at a
      // size it resizes.
      reason = `${type || 'no content type'} is not a JPEG, PNG or WebP`;
      logger.debug(`Cover ${coverArtId} at ${size}px: ${reason}, trying another size`);
      continue;
    }
    const bytes = Buffer.from(base64, 'base64').length;
    if (bytes <= MAX_WIDGET_IMAGE_BYTES) {
      logger.debug(`Cover ${coverArtId} served at ${size}px (${type}, ${bytes} bytes)`);
      return base64;
    }
    reason = `stays above ${MAX_WIDGET_IMAGE_BYTES} bytes`;
    logger.debug(`Cover ${coverArtId} at ${size}px is ${bytes} bytes, trying smaller`);
  }
  throw new Error(`Cover art ${coverArtId} unusable for a widget: ${reason}`);
}

/**
 * Resolve an image key asked by the core: the registered cover, fetched at
 * the widget size.
 * @param {ReturnType<typeof createCoverRegistry>} registry
 * @param {object} config normalized config
 * @param {string} key
 * @returns {Promise<string>} raw base64
 */
export async function resolveWidgetImage(registry, config, key) {
  if (typeof key !== 'string' || !IMAGE_KEY_REGEX.test(key)) {
    throw new Error(`Invalid image key ${key}`);
  }
  const coverArtId = registry.lookup(key);
  if (coverArtId === undefined) {
    // Asked after a restart, for a content built before it: the core will
    // re-pull the content and register the cover again.
    throw new Error(`Unknown image ${key}`);
  }
  return widgetCoverArt(config, coverArtId);
}
