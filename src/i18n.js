// -----------------------------------------------------------------------------
// Every text the integration shows to the user, in the four languages of the
// Gladys interface (en, fr, de, es). The core picks the user's language and
// falls back on `en`. German says "du", Spanish says "usted", like the rest
// of guim31's integrations.
//
//   - TEXT     : the fixed texts (widget labels, empty states);
//   - MESSAGES : the texts built from a value (an action result, an error);
//   - thrown() : a THROWN message reaches the screen as a plain string, the
//                core cannot localize it: the languages are joined.
//
// test/i18n.test.js checks that every entry carries exactly the four
// languages, and that no other source file builds a multi-language object.
// -----------------------------------------------------------------------------

/** The languages every text carries, in this order. */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/** Fixed texts. */
export const TEXT = {
  // Music panel of Gladys 5.3 (in the configured language)
  folderAlbums: { en: 'Albums', fr: 'Albums', de: 'Alben', es: 'Álbumes' },
  folderArtists: { en: 'Artists', fr: 'Artistes', de: 'Interpreten', es: 'Artistas' },
  folderPlaylists: {
    en: 'Playlists',
    fr: 'Playlists',
    de: 'Playlists',
    es: 'Listas de reproducción',
  },
  notJukebox: {
    en: 'Only the Subsonic jukebox plays music: enable it in the integration configuration.',
    fr: "Seul le jukebox Subsonic joue de la musique : activez-le dans la configuration de l'intégration.",
    de: 'Nur die Subsonic-Jukebox spielt Musik: Aktiviere sie in der Konfiguration der Integration.',
    es: 'Solo la jukebox de Subsonic reproduce música: actívela en la configuración de la integración.',
  },
  gone: {
    en: 'This item is no longer in the library.',
    fr: "Cet élément n'est plus dans la bibliothèque.",
    de: 'Dieses Element ist nicht mehr in der Bibliothek.',
    es: 'Este elemento ya no está en la biblioteca.',
  },
  notBrowsable: {
    en: 'This item cannot be opened.',
    fr: 'Cet élément ne peut pas être ouvert.',
    de: 'Dieses Element kann nicht geöffnet werden.',
    es: 'Este elemento no se puede abrir.',
  },
  notPlayable: {
    en: 'The jukebox cannot play this item.',
    fr: 'Le jukebox ne peut pas jouer cet élément.',
    de: 'Die Jukebox kann dieses Element nicht abspielen.',
    es: 'La jukebox no puede reproducir este elemento.',
  },
  emptyMedia: {
    en: 'Nothing to play: this item holds no song.',
    fr: 'Rien à jouer : cet élément ne contient aucun morceau.',
    de: 'Nichts abzuspielen: Dieses Element enthält keinen Titel.',
    es: 'Nada que reproducir: este elemento no contiene ninguna canción.',
  },
  badMode: {
    en: 'Unknown play mode.',
    fr: 'Mode de lecture inconnu.',
    de: 'Unbekannter Wiedergabemodus.',
    es: 'Modo de reproducción desconocido.',
  },
  notInQueue: {
    en: 'This song is no longer in the jukebox queue.',
    fr: "Ce morceau n'est plus dans la file du jukebox.",
    de: 'Dieser Titel ist nicht mehr in der Warteschlange der Jukebox.',
    es: 'Esta canción ya no está en la cola de la jukebox.',
  },
  nothingLoaded: {
    en: 'Nothing is loaded on the jukebox.',
    fr: 'Rien n’est chargé sur le jukebox.',
    de: 'Auf der Jukebox ist nichts geladen.',
    es: 'No hay nada cargado en la jukebox.',
  },
  badPlaybackState: {
    en: 'The jukebox can play, pause or stop, nothing else.',
    fr: 'Le jukebox sait lire, mettre en pause ou arrêter, rien d’autre.',
    de: 'Die Jukebox kann abspielen, pausieren oder stoppen, sonst nichts.',
    es: 'La jukebox puede reproducir, pausar o detener, nada más.',
  },
  // Widgets
  streams: { en: 'Streams', fr: 'Lectures', de: 'Streams', es: 'Reproducciones' },
  nothingPlaying: {
    en: 'Nothing is playing right now.',
    fr: 'Rien en écoute.',
    de: 'Gerade läuft nichts.',
    es: 'No se está reproduciendo nada.',
  },
  unknownTrack: {
    en: 'Unknown track',
    fr: 'Morceau inconnu',
    de: 'Unbekannter Titel',
    es: 'Canción desconocida',
  },
  jukeboxDisabled: {
    en: 'Enable the jukebox in the integration configuration.',
    fr: "Activez le jukebox dans la configuration de l'intégration.",
    de: 'Aktiviere die Jukebox in der Konfiguration der Integration.',
    es: 'Active la jukebox en la configuración de la integración.',
  },
  emptyQueue: {
    en: 'Empty queue',
    fr: 'File vide',
    de: 'Warteschlange leer',
    es: 'Cola vacía',
  },
  state: { en: 'State', fr: 'État', de: 'Status', es: 'Estado' },
  playing: { en: 'Playing', fr: 'Lecture', de: 'Läuft', es: 'Reproduciendo' },
  stopped: { en: 'Stopped', fr: 'Arrêt', de: 'Gestoppt', es: 'Detenido' },
  volume: { en: 'Volume', fr: 'Volume', de: 'Lautstärke', es: 'Volumen' },
  queue: { en: 'Queue', fr: 'File', de: 'Warteschlange', es: 'Cola' },
  play: { en: 'Play', fr: 'Lecture', de: 'Abspielen', es: 'Reproducir' },
  pause: { en: 'Pause', fr: 'Pause', de: 'Pause', es: 'Pausar' },
  previous: { en: 'Previous', fr: 'Précédent', de: 'Zurück', es: 'Anterior' },
  next: { en: 'Next', fr: 'Suivant', de: 'Weiter', es: 'Siguiente' },
  random: { en: 'Shuffle', fr: 'Aléatoire', de: 'Zufall', es: 'Aleatorio' },
  songs: { en: 'Songs', fr: 'Morceaux', de: 'Titel', es: 'Canciones' },
  artists: { en: 'Artists', fr: 'Artistes', de: 'Interpreten', es: 'Artistas' },
  albums: { en: 'Albums', fr: 'Albums', de: 'Alben', es: 'Álbumes' },
  server: { en: 'Server', fr: 'Serveur', de: 'Server', es: 'Servidor' },
  scan: { en: 'Scan', fr: 'Scan', de: 'Scan', es: 'Análisis' },
  scanUnavailable: {
    en: 'Unavailable',
    fr: 'Indisponible',
    de: 'Nicht verfügbar',
    es: 'No disponible',
  },
  scanDone: { en: 'Done', fr: 'Terminé', de: 'Fertig', es: 'Terminado' },
  scanButton: { en: 'Scan', fr: 'Scanner', de: 'Scannen', es: 'Analizar' },
  notConfigured: {
    en: 'Fill in the server URL, username and password in the configuration.',
    fr: "Renseignez l'URL du serveur, l'utilisateur et le mot de passe dans la configuration.",
    de: 'Gib die Server-URL, den Benutzernamen und das Passwort in der Konfiguration ein.',
    es: 'Introduzca la URL del servidor, el nombre de usuario y la contraseña en la configuración.',
  },

  // Configuration screen and actions
  notConfiguredStatus: {
    en: 'Fill in the server URL, username and password.',
    fr: "Renseignez l'URL du serveur, l'utilisateur et le mot de passe.",
    de: 'Gib die Server-URL, den Benutzernamen und das Passwort ein.',
    es: 'Introduzca la URL del servidor, el nombre de usuario y la contraseña.',
  },
  notConfiguredFirst: {
    en: 'Fill in the server URL, username and password first.',
    fr: "Renseignez d'abord l'URL du serveur, l'utilisateur et le mot de passe.",
    de: 'Gib zuerst die Server-URL, den Benutzernamen und das Passwort ein.',
    es: 'Introduzca primero la URL del servidor, el nombre de usuario y la contraseña.',
  },
  initFailed: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
    de: 'Die Initialisierung ist fehlgeschlagen, sieh dir die Logs der Integration an.',
    es: 'La inicialización ha fallado, consulte los registros de la integración.',
  },
  jukeboxDisabledFirst: {
    en: 'Enable the jukebox in the integration configuration first (and on the server, e.g. Jukebox.Enabled in Navidrome).',
    fr: "Activez d'abord le jukebox dans la configuration de l'intégration (et côté serveur, ex. Jukebox.Enabled dans Navidrome).",
    de: 'Aktiviere zuerst die Jukebox in der Konfiguration der Integration (und auf dem Server, z. B. Jukebox.Enabled in Navidrome).',
    es: 'Active primero la jukebox en la configuración de la integración (y en el servidor, p. ej. Jukebox.Enabled en Navidrome).',
  },
  playlistMissing: {
    en: 'Give the name of a playlist.',
    fr: "Indiquez le nom d'une playlist.",
    de: 'Gib den Namen einer Playlist an.',
    es: 'Indique el nombre de una lista de reproducción.',
  },
  noSongs: {
    en: 'The library returned no songs.',
    fr: "La bibliothèque n'a renvoyé aucun morceau.",
    de: 'Die Bibliothek hat keine Titel zurückgegeben.',
    es: 'La biblioteca no ha devuelto ninguna canción.',
  },
  scanFinished: {
    en: 'Library scan finished.',
    fr: 'Scan de la bibliothèque terminé.',
    de: 'Scan der Bibliothek abgeschlossen.',
    es: 'Análisis de la biblioteca terminado.',
  },

  // Thrown, joined by thrown(): keep them short, a widget toast is 200
  // characters at most.
  jukeboxNotEnabled: {
    en: 'Jukebox not enabled.',
    fr: 'Jukebox non activé.',
    de: 'Jukebox nicht aktiviert.',
    es: 'Jukebox no activada.',
  },
  serverNotConfigured: {
    en: 'Server not configured.',
    fr: 'Serveur non configuré.',
    de: 'Server nicht konfiguriert.',
    es: 'Servidor no configurado.',
  },
  scanRefusedShort: {
    en: 'Scan refused: administrators only.',
    fr: 'Scan refusé : réservé aux administrateurs.',
    de: 'Scan abgelehnt: nur für Administratoren.',
    es: 'Análisis rechazado: solo administradores.',
  },
  scanRefused: {
    en:
      'The server refuses a scan from this account: starting one is reserved to administrators. ' +
      "The sensors do not need it, the library is scanned on the server's own schedule.",
    fr:
      'Le serveur refuse le scan pour ce compte : son lancement est réservé aux administrateurs. ' +
      'Les capteurs n’en ont pas besoin, la bibliothèque est scannée selon la planification du serveur.',
    de:
      'Der Server lehnt einen Scan für dieses Konto ab: Nur Administratoren dürfen ihn starten. ' +
      'Die Sensoren brauchen ihn nicht, der Server scannt die Bibliothek nach seinem eigenen Zeitplan.',
    es:
      'El servidor rechaza el análisis para esta cuenta: solo los administradores pueden iniciarlo. ' +
      'Los sensores no lo necesitan, el servidor analiza la biblioteca según su propia programación.',
  },
  scanNotStarted: {
    en: 'Scan not started',
    fr: 'Scan non lancé',
    de: 'Scan nicht gestartet',
    es: 'Análisis no iniciado',
  },
  scanFailed: {
    en: 'Scan could not be started',
    fr: 'Impossible de lancer le scan',
    de: 'Der Scan konnte nicht gestartet werden',
    es: 'No se ha podido iniciar el análisis',
  },
};

/** Texts built from a value. Each one returns the four languages. */
export const MESSAGES = {
  unreachable: (message) => ({
    en: `Cannot reach the server: ${message}`,
    fr: `Serveur injoignable : ${message}`,
    de: `Server nicht erreichbar: ${message}`,
    es: `No se puede acceder al servidor: ${message}`,
  }),
  player: (player) => ({
    en: `Player: ${player}`,
    fr: `Lecteur : ${player}`,
    de: `Player: ${player}`,
    es: `Reproductor: ${player}`,
  }),
  scanRunning: (counted) => ({
    en: `Running${counted}`,
    fr: `En cours${counted}`,
    de: `Läuft${counted}`,
    es: `En curso${counted}`,
  }),
  scanDoneCount: (count) => ({
    en: `Done · ${count} songs`,
    fr: `Terminé · ${count} morceaux`,
    de: `Fertig · ${count} Titel`,
    es: `Terminado · ${count} canciones`,
  }),
  scanInProgress: (count) => {
    const has = count !== undefined;
    return {
      en: `Library scan in progress${has ? ` (${count} items so far)` : ''}.`,
      fr: `Scan de la bibliothèque en cours${has ? ` (${count} éléments pour l'instant)` : ''}.`,
      de: `Scan der Bibliothek läuft${has ? ` (bisher ${count} Elemente)` : ''}.`,
      es: `Análisis de la biblioteca en curso${has ? ` (${count} elementos hasta ahora)` : ''}.`,
    };
  },
  connected: (serverName, version) => ({
    en: `Connected to ${serverName} (Subsonic API ${version}).`,
    fr: `Connecté à ${serverName} (API Subsonic ${version}).`,
    de: `Verbunden mit ${serverName} (Subsonic-API ${version}).`,
    es: `Conectado a ${serverName} (API de Subsonic ${version}).`,
  }),
  // The ping did not name the server: say what it is.
  connectedUnnamed: (version) => ({
    en: `Connected to a Subsonic-compatible server (Subsonic API ${version}).`,
    fr: `Connecté à un serveur compatible Subsonic (API Subsonic ${version}).`,
    de: `Verbunden mit einem Subsonic-kompatiblen Server (Subsonic-API ${version}).`,
    es: `Conectado a un servidor compatible con Subsonic (API de Subsonic ${version}).`,
  }),
  serverUnreachable: (message) => ({
    en: `Cannot reach the Subsonic server: ${message}`,
    fr: `Impossible de joindre le serveur Subsonic : ${message}`,
    de: `Der Subsonic-Server ist nicht erreichbar: ${message}`,
    es: `No se puede acceder al servidor Subsonic: ${message}`,
  }),
  publishFailed: (message) => ({
    en: `Server reachable, but publishing the devices failed: ${message}`,
    fr: `Serveur joignable, mais la publication des appareils a échoué : ${message}`,
    de: `Server erreichbar, aber die Veröffentlichung der Geräte ist fehlgeschlagen: ${message}`,
    es: `Servidor accesible, pero la publicación de los dispositivos ha fallado: ${message}`,
  }),
  // `names` are the playlists of the server, joined (empty when none).
  playlistNotFound: (wanted, names) => ({
    en: `No playlist named "${wanted}". Available: ${names || 'none'}.`,
    fr: `Aucune playlist nommée « ${wanted} ». Disponibles : ${names || 'aucune'}.`,
    de: `Keine Playlist namens „${wanted}“. Verfügbar: ${names || 'keine'}.`,
    es: `No hay ninguna lista llamada «${wanted}». Disponibles: ${names || 'ninguna'}.`,
  }),
  playlistEmpty: (name) => ({
    en: `The playlist "${name}" is empty.`,
    fr: `La playlist « ${name} » est vide.`,
    de: `Die Playlist „${name}“ ist leer.`,
    es: `La lista «${name}» está vacía.`,
  }),
  playingPlaylist: (name, count) => ({
    en: `Playing "${name}" (${count} songs) on the jukebox.`,
    fr: `Lecture de « ${name} » (${count} morceaux) sur le jukebox.`,
    de: `„${name}“ (${count} Titel) läuft auf der Jukebox.`,
    es: `Reproduciendo «${name}» (${count} canciones) en la jukebox.`,
  }),
  playingRandom: (count) => ({
    en: `Playing ${count} random songs on the jukebox.`,
    fr: `Lecture de ${count} morceaux aléatoires sur le jukebox.`,
    de: `${count} zufällige Titel laufen auf der Jukebox.`,
    es: `Reproduciendo ${count} canciones aleatorias en la jukebox.`,
  }),
};

/**
 * A message to THROW: the core shows a thrown message as a plain string, so
 * the four languages are joined, then an optional detail common to all of
 * them (an error message) is appended once.
 * @param {{ en: string, fr: string, de: string, es: string }} text
 * @param {string} [detail]
 * @returns {string}
 */
export function thrown(text, detail) {
  const joined = LANGUAGES.map((lang) => text[lang]).join(' / ');
  return detail ? `${joined}: ${detail}` : joined;
}

/**
 * A text in one language (the `language` of the configuration), English
 * when the language is unknown: for what the core shows as is, like the
 * music panel's folders and errors.
 * @param {{ en: string, fr: string, de: string, es: string }} text
 * @param {string} [language]
 * @returns {string}
 */
export function localized(text, language) {
  return text[language] ?? text.en;
}
