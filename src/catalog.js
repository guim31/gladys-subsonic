// -----------------------------------------------------------------------------
// The catalog of the Gladys 5.3 music panel (manifest `music`): browse,
// search, play, the jukebox queue and the bytes of the artworks. Read on
// demand from the server, never stored.
//
// Only the jukebox plays: it is the one player the Subsonic API can drive
// (`jukeboxControl`). Every operation therefore checks that it is asked for
// the jukebox device of the configured server, enabled in the configuration.
//
// MediaItem ids are `<kind>:<server id>` (`album:6bOVooi3…`, `track:5FwD…`),
// opaque to Gladys and carried back by a play command and by the
// `music.play-media` scene action; our root folders use `gladys:`. Navidrome
// derives its ids from the files and the tags: they survive a rescan.
//
// What the jukebox gives (checked on Navidrome 0.64.2, mpv):
//   - `add` takes song ids only (no radio, no album id): containers are
//     expanded here into their songs, MAX_PLAY_TRACKS at most, sent
//     ADD_CHUNK ids per request so the query string stays short;
//   - `add` of an unknown id fails the whole request: the songs are read
//     BEFORE the queue is cleared, so a gone id never empties the queue;
//   - there is no "insert": "play next" removes the tail of the queue after
//     the current song (removing another song does not touch playback), adds
//     the new songs, then the tail again. Navidrome re-finds the current song
//     by its id after a removal: when the same song is also queued before it,
//     or the tail is long, the queue is rebuilt with `set` and the jukebox
//     sent back to the same song and second (a short gap in the sound);
//   - `skip` keeps the jukebox playing or paused: a tap in the queue skips,
//     then starts.
// -----------------------------------------------------------------------------

import { MUSIC_MEDIA_TYPES } from '@gladysassistant/integration-sdk';
import {
  asArray,
  getAlbum,
  getAlbumList2,
  getArtist,
  getArtists,
  getPlaylist,
  getPlaylists,
  getSong,
  jukeboxControl,
  search3,
  SubsonicError,
} from './subsonic.js';
import { widgetCoverArt } from './covers.js';
import { TEXT, localized } from './i18n.js';

/** Our root folders: no Subsonic id starts with `gladys:`. */
export const ROOTS = {
  albums: 'gladys:albums',
  artists: 'gladys:artists',
  playlists: 'gladys:playlists',
};

/** Songs one play command queues at most (an artist, a long playlist). */
export const MAX_PLAY_TRACKS = 500;

/** Song ids per `add` request. */
export const ADD_CHUNK = 100;

/** Songs after the current one that "play next" removes one by one at most. */
export const MAX_TAIL_REMOVALS = 50;

/** Artwork sizes asked from the server (px): the player frame, a list row. */
export const ARTWORK_SIZE = { player: 300, list: 128 };

/** Smaller sizes tried when an artwork stays too large for the core. */
const ARTWORK_FALLBACK = { 300: [300, 200, 128], 128: [128, 64] };

// Lists the server only gives whole (artists, playlists): kept a minute, so
// scrolling a long list does not read it again for every page.
const LIST_CACHE_MS = 60 * 1000;

const MAX_TEXT = 200;
const MAX_ID = 512;

const clip = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TEXT) : null;

/**
 * `<kind>:<id>` of a MediaItem id, or null for anything else.
 * @param {unknown} id
 * @returns {{ kind: string, itemId: string }|null}
 */
export function parseMediaId(id) {
  const match = /^(track|album|artist|playlist):(.+)$/s.exec(String(id ?? ''));
  return match && match[0].length <= MAX_ID ? { kind: match[1], itemId: match[2] } : null;
}

/**
 * The pseudo URL behind an artwork key: never fetched as such (the cover
 * needs the credentials), it records which cover and which size the key
 * stands for, through the SDK's artworkKey. The server identity is part of
 * it: another server, other keys.
 * @param {string} platformId
 * @param {string} coverArtId
 * @param {number} size
 */
export function artworkSource(platformId, coverArtId, size) {
  return `subsonic-cover://${encodeURIComponent(platformId)}/${size}/${encodeURIComponent(coverArtId)}`;
}

/**
 * @param {string|undefined} source
 * @returns {{ platformId: string, size: number, coverArtId: string }|null}
 */
export function parseArtworkSource(source) {
  const match = /^subsonic-cover:\/\/([^/]*)\/(\d+)\/(.+)$/.exec(String(source ?? ''));
  if (!match) {
    return null;
  }
  return {
    platformId: decodeURIComponent(match[1]),
    size: Number(match[2]),
    coverArtId: decodeURIComponent(match[3]),
  };
}

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration (or the SDK's fake)
 * @param {() => object} options.getConfig the current normalized config
 * @param {(device: { external_id: string }) => boolean} options.isJukebox
 * @param {() => string} options.platformId the server identity of the config
 * @param {() => Promise<void>} [options.afterCommand] publish the jukebox
 *   state once a command changed it
 * @param {() => number} [options.now]
 */
export function createCatalog({
  gladys,
  getConfig,
  isJukebox,
  platformId,
  afterCommand = async () => {},
  now = () => Date.now(),
}) {
  /** @type {Map<string, { at: number, platform: string, items: Array<object> }>} */
  const lists = new Map();

  const language = () => getConfig().language;
  const fail = (key) => new Error(localized(TEXT[key], language()));

  /** Throws unless the device is the jukebox of the configured server. */
  function assertJukebox(device) {
    if (!isJukebox(device)) {
      throw fail('notJukebox');
    }
  }

  /** A whole list the server only gives at once, cached LIST_CACHE_MS. */
  async function cachedList(name, read) {
    const platform = platformId();
    const cached = lists.get(name);
    if (cached && cached.platform === platform && now() - cached.at < LIST_CACHE_MS) {
      return cached.items;
    }
    const items = await read(getConfig());
    lists.set(name, { at: now(), platform, items });
    return items;
  }

  /** A server call on an id kept by a scene: a gone id says so. */
  async function readById(read) {
    try {
      return await read();
    } catch (err) {
      if (err instanceof SubsonicError && (err.code === 70 || err.code === 10)) {
        throw fail('gone');
      }
      throw err;
    }
  }

  function artworkKeyOf(coverArtId, size) {
    if (typeof coverArtId !== 'string' && typeof coverArtId !== 'number') {
      return null;
    }
    const id = String(coverArtId);
    return id === '' ? null : gladys.artworkKey(artworkSource(platformId(), id, size));
  }

  /**
   * A Subsonic entry as a MediaItem. Never dropped: an entry without an id
   * stays as a neutral row (the panel pages by rows received, and the queue
   * highlights by position).
   * @param {object} entry artist, album, playlist or song
   * @param {string} kind a MUSIC_MEDIA_TYPES value
   */
  function toMediaItem(entry, kind) {
    const id = entry?.id === undefined || entry?.id === null ? '' : String(entry.id);
    const title = clip(entry?.title) ?? clip(entry?.name) ?? (id || '?');
    if (!id || `${kind}:${id}`.length > MAX_ID) {
      return { id: 'other:unknown', type: kind, title, browsable: false, playable: false };
    }
    const isTrack = kind === MUSIC_MEDIA_TYPES.TRACK;
    let subtitle = null;
    if (isTrack || kind === MUSIC_MEDIA_TYPES.ALBUM) {
      subtitle = clip(entry.artist ?? entry.displayArtist);
    } else if (kind === MUSIC_MEDIA_TYPES.PLAYLIST) {
      subtitle = clip(entry.owner);
    }
    const duration = Number(entry.duration);
    return {
      id: `${kind}:${id}`,
      type: kind,
      title,
      subtitle,
      duration: isTrack && duration > 0 ? Math.round(duration) : null,
      artwork_key: artworkKeyOf(entry.coverArt, ARTWORK_SIZE.list),
      browsable: !isTrack,
      playable: true,
    };
  }

  const page = (items, offset, limit) => items.slice(offset, offset + limit);

  /** Songs of a media, in playing order (MAX_PLAY_TRACKS at most). */
  async function songsOf(media) {
    const config = getConfig();
    if (media.kind === MUSIC_MEDIA_TYPES.TRACK) {
      const song = await readById(() => getSong(config, media.itemId));
      return song?.id ? [song] : [];
    }
    if (media.kind === MUSIC_MEDIA_TYPES.ALBUM) {
      const album = await readById(() => getAlbum(config, media.itemId));
      return album.song.slice(0, MAX_PLAY_TRACKS);
    }
    if (media.kind === MUSIC_MEDIA_TYPES.PLAYLIST) {
      const playlist = await readById(() => getPlaylist(config, media.itemId));
      return playlist.entry.slice(0, MAX_PLAY_TRACKS);
    }
    // An artist: its albums, as the server lists them, until the bound.
    const artist = await readById(() => getArtist(config, media.itemId));
    const songs = [];
    for (const album of artist.album) {
      if (songs.length >= MAX_PLAY_TRACKS || !album?.id) {
        continue;
      }
      const full = await getAlbum(config, album.id);
      songs.push(...full.song.slice(0, MAX_PLAY_TRACKS - songs.length));
    }
    return songs;
  }

  /** Append songs to the jukebox queue, ADD_CHUNK ids per request. */
  async function addSongs(config, ids) {
    for (let at = 0; at < ids.length; at += ADD_CHUNK) {
      await jukeboxControl(config, 'add', { id: ids.slice(at, at + ADD_CHUNK) });
    }
  }

  /** Replace the queue with these songs, in chunks, the first ones by `set`. */
  async function setSongs(config, ids) {
    await jukeboxControl(config, 'set', { id: ids.slice(0, ADD_CHUNK) });
    await addSongs(config, ids.slice(ADD_CHUNK));
  }

  /** "Play next": the songs right after the current one. */
  async function insertNext(config, ids) {
    const queue = await jukeboxControl(config, 'get');
    const entries = asArray(queue.entry);
    const index = Number(queue.currentIndex);
    if (!(index >= 0 && index < entries.length)) {
      await addSongs(config, ids);
      return;
    }
    const tail = entries.slice(index + 1).map((entry) => String(entry.id));
    if (tail.length === 0) {
      await addSongs(config, ids);
      return;
    }
    const currentId = String(entries[index].id);
    const duplicated = entries.slice(0, index).some((entry) => String(entry.id) === currentId);
    if (!duplicated && tail.length <= MAX_TAIL_REMOVALS) {
      // Seamless: the current song plays on.
      for (let at = entries.length - 1; at > index; at -= 1) {
        await jukeboxControl(config, 'remove', { index: at });
      }
      await addSongs(config, [...ids, ...tail]);
      return;
    }
    // Rebuilt: `set` stops the sound, then back to the same song and second.
    const head = entries.slice(0, index + 1).map((entry) => String(entry.id));
    await setSongs(config, [...head, ...ids, ...tail]);
    await jukeboxControl(config, 'skip', { index, offset: Number(queue.position) || 0 });
    if (queue.playing) {
      await jukeboxControl(config, 'start');
    }
  }

  return {
    toMediaItem,

    /**
     * onMusicBrowse: our root folders, then the library.
     * @param {{ external_id: string }} device
     * @param {{ parentId: string|null, offset: number, limit: number }} options
     */
    async browse(device, { parentId, offset = 0, limit = 50 }) {
      assertJukebox(device);
      const config = getConfig();
      if (!parentId) {
        const roots = [
          [ROOTS.albums, TEXT.folderAlbums],
          [ROOTS.artists, TEXT.folderArtists],
          [ROOTS.playlists, TEXT.folderPlaylists],
        ].map(([id, title]) => ({
          id,
          type: MUSIC_MEDIA_TYPES.FOLDER,
          title: localized(title, language()),
          browsable: true,
          playable: false,
        }));
        return { items: page(roots, offset, limit), total: roots.length };
      }
      if (parentId === ROOTS.albums) {
        // Paged by the server, which does not tell the total: one more than
        // the rows read while a page comes back full, so the panel asks on.
        const albums = await getAlbumList2(config, { size: limit, offset });
        const total = offset + albums.length + (albums.length === limit ? 1 : 0);
        return { items: albums.map((album) => toMediaItem(album, 'album')), total };
      }
      if (parentId === ROOTS.artists) {
        const artists = await cachedList('artists', getArtists);
        return {
          items: page(artists, offset, limit).map((artist) => toMediaItem(artist, 'artist')),
          total: artists.length,
        };
      }
      if (parentId === ROOTS.playlists) {
        const playlists = await cachedList('playlists', getPlaylists);
        return {
          items: page(playlists, offset, limit).map((pl) => toMediaItem(pl, 'playlist')),
          total: playlists.length,
        };
      }
      const media = parseMediaId(parentId);
      if (!media || media.kind === MUSIC_MEDIA_TYPES.TRACK) {
        throw fail('notBrowsable');
      }
      let children;
      let kind = MUSIC_MEDIA_TYPES.TRACK;
      if (media.kind === MUSIC_MEDIA_TYPES.ARTIST) {
        children = (await readById(() => getArtist(config, media.itemId))).album;
        kind = MUSIC_MEDIA_TYPES.ALBUM;
      } else if (media.kind === MUSIC_MEDIA_TYPES.ALBUM) {
        children = (await readById(() => getAlbum(config, media.itemId))).song;
      } else {
        children = (await readById(() => getPlaylist(config, media.itemId))).entry;
      }
      return {
        items: page(children, offset, limit).map((child) => toMediaItem(child, kind)),
        total: children.length,
      };
    },

    /**
     * onMusicSearch: artists, albums, playlists and songs by name, each kind
     * given its share of the limit, the rest to the others.
     * @param {{ external_id: string }} device
     * @param {{ query: string, type: string|null, limit: number }} options
     */
    async search(device, { query, type = null, limit = 20 }) {
      assertJukebox(device);
      const config = getConfig();
      const kinds = type
        ? [type]
        : [
            MUSIC_MEDIA_TYPES.ARTIST,
            MUSIC_MEDIA_TYPES.ALBUM,
            MUSIC_MEDIA_TYPES.PLAYLIST,
            MUSIC_MEDIA_TYPES.TRACK,
          ];
      const wants = (kind) => kinds.includes(kind);
      const found = { artist: [], album: [], playlist: [], track: [] };
      if (wants('artist') || wants('album') || wants('track')) {
        const result = await search3(config, query, {
          artistCount: wants('artist') ? limit : 0,
          albumCount: wants('album') ? limit : 0,
          songCount: wants('track') ? limit : 0,
        });
        found.artist = result.artist;
        found.album = result.album;
        found.track = result.song;
      }
      if (wants('playlist')) {
        const needle = query.toLowerCase();
        const playlists = await cachedList('playlists', getPlaylists);
        found.playlist = playlists.filter((pl) =>
          String(pl?.name ?? '')
            .toLowerCase()
            .includes(needle),
        );
      }
      // radio, folder: nothing of the kind on the jukebox.
      const groups = kinds
        .filter((kind) => found[kind])
        .map((kind) => found[kind].map((entry) => toMediaItem(entry, kind)));
      const share = Math.ceil(limit / Math.max(groups.length, 1));
      const picked = groups.map((group) => group.slice(0, share));
      let room = limit - picked.reduce((sum, group) => sum + group.length, 0);
      groups.forEach((group, i) => {
        const extra = group.slice(share, share + Math.max(room, 0));
        picked[i].push(...extra);
        room -= extra.length;
      });
      return { items: picked.flat().slice(0, limit) };
    },

    /**
     * onMusicPlay (and the `music.play-media` scene action): a song, an
     * album, an artist or a playlist — now, next, or at the end of the queue.
     * @param {{ external_id: string }} device
     * @param {{ id: string, type?: string }} media
     * @param {'replace'|'next'|'append'} mode
     */
    async play(device, media, mode = 'replace') {
      assertJukebox(device);
      const config = getConfig();
      const parsed = parseMediaId(media?.id);
      if (!parsed) {
        throw fail('notPlayable');
      }
      const ids = (await songsOf(parsed))
        .filter((song) => song?.id !== undefined && song.id !== null)
        .map((song) => String(song.id));
      if (ids.length === 0) {
        throw fail('emptyMedia');
      }
      if (mode === 'replace') {
        await jukeboxControl(config, 'clear');
        await addSongs(config, ids);
        await jukeboxControl(config, 'start');
      } else if (mode === 'append') {
        await addSongs(config, ids);
      } else if (mode === 'next') {
        await insertNext(config, ids);
      } else {
        throw fail('badMode');
      }
      await afterCommand();
    },

    /**
     * onMusicQueueGet: a page of the jukebox queue; no row is ever left out
     * (the panel highlights `current_index - offset`).
     * @param {{ external_id: string }} device
     * @param {{ offset: number, limit: number }} options
     */
    async queueGet(device, { offset = 0, limit = 50 }) {
      assertJukebox(device);
      const queue = await jukeboxControl(getConfig(), 'get');
      const entries = asArray(queue.entry);
      const index = Number(queue.currentIndex);
      return {
        items: page(entries, offset, limit).map((entry) => toMediaItem(entry, 'track')),
        currentIndex: index >= 0 && index < entries.length ? index : null,
        total: entries.length,
      };
    },

    /**
     * onMusicQueuePlay: play the song at that index of the queue.
     * @param {{ external_id: string }} device
     * @param {number} index
     */
    async queuePlay(device, index) {
      assertJukebox(device);
      const config = getConfig();
      const queue = await jukeboxControl(config, 'get');
      const size = asArray(queue.entry).length;
      if (!Number.isInteger(index) || index < 0 || index >= size) {
        throw fail('notInQueue');
      }
      await jukeboxControl(config, 'skip', { index, offset: 0 });
      await jukeboxControl(config, 'start');
      await afterCommand();
    },

    /**
     * onMusicGetArtwork: the bytes of a recorded artwork, resized by the
     * server (getCoverArt `size`), with the credentials — the SDK's default
     * handler would fetch the pseudo URL.
     * @param {string} key
     * @returns {Promise<string>} raw base64
     */
    async artwork(key) {
      const source = parseArtworkSource(gladys.artworkUrls?.get(key));
      if (!source || source.platformId !== platformId()) {
        throw new Error(`Unknown artwork ${key}`);
      }
      const sizes = ARTWORK_FALLBACK[source.size] ?? [source.size];
      return widgetCoverArt(getConfig(), source.coverArtId, sizes);
    },
  };
}
