# CLAUDE.md — Subsonic

Reliez Gladys à un serveur musical compatible Subsonic : Navidrome, Airsonic, Gonic...

Intégration externe pour [Gladys Assistant](https://gladysassistant.com), bâtie sur le template officiel `GladysAssistant/integration-template-js` (SDK `@gladysassistant/integration-sdk` ^0.16.0, `gladys_version` `>=5.3.0` depuis la 1.3.0). Mainteneur : Guilhem (`guim31`).

Ce fichier rassemble ce qu'une session de code doit savoir et qui ne se lit pas dans le code : choix de conception, faits vérifiés en réel, pièges déjà payés. Le compléter quand un nouveau piège est découvert.

## État au 05/10/2026

Version 1.0.8 publiée, indexée dans le store, sans widget. La branche
`feat/dashboard-widgets` (PR « feat: dashboard widgets (Gladys 5.1) ») passe au SDK 0.14 et à
`gladys_version >=5.1.0`, et ajoute trois widgets : `now_playing`, `jukebox`, `library`. Rien de
tout cela n'a été vu sur une instance Gladys ni sur un serveur Subsonic réel : seuls les tests, le
lint et le validateur du store ont tourné. Le passage à `>=5.1.0` coupe les mises à jour des cœurs
4.x : la Release qui l'embarque est une **minor**, à annoncer.

## Maintenance SDK 0.15 (13/10/2026)

- **Le conteneur sonde lui-même** (`src/poller.js`) : Gladys 5.2.0 ne sonde un appareil que s'il a
  été créé avec `should_poll: true` et un `poll_frequency` valide, et un appareil garde à vie les
  champs de sa création (Gladys#3198, correctif #3199 non publié). Les appareils gardent
  `should_poll: true` et l'`onPoll` du cœur reste un repli : il saute un appareil sondé il y a
  moins de 90 % d'une période (un appareil créé à 10 s garde ce rythme côté cœur même si la config
  passe à 60 s), le minuteur saute un appareil sondé il y a moins d'une demi-période ; le cœur ne
  lit donc le serveur que si le minuteur cale. Un sondage forcé (création, config) attend celui en
  cours puis relance avec la config du moment.
  Seuls les appareils **ajoutés** à Gladys (`gladys.devices`) sont sondés, comme quand seul le cœur
  sondait. Sondage immédiat à la (re)connexion, au changement de config et à la création ou mise à
  jour d'un appareil (`poller.register()` pose `onPoll`, `onDeviceCreated`, `onDeviceUpdated`) ;
  rien quand Gladys est injoignable (`gladys.connected`).
- **États dédupliqués** : tout passe par `publishChangedStates`, y compris les commandes du
  jukebox (`publishOne`) : une seule mémoire de ce que Gladys a, sinon un sondage sauterait une
  valeur qu'une commande a changée entre-temps. Le SDK oublie cette mémoire à la création ou mise à
  jour d'un appareil ; `server.forgetPublished()` fait de même pour la pochette (canal caméra),
  en gardant l'image en secours. **Heartbeat 12 h** (`STATE_HEARTBEAT_MS`) : le cœur affiche « Pas
  de valeur récente » au-delà de 48 h sans valeur (`last_value_changed`), et les compteurs de la
  bibliothèque peuvent rester fixes des jours.
- **Logs** : rien en info pour un cycle normal (`Server polled`, lecture de la bibliothèque,
  pochette publiée passent en debug, `LOG_LEVEL=debug` pour les voir). Les échecs répétés passent
  par `createIssueLog` (`src/issues.js`) : un warn au premier échec, debug ensuite, une ligne info
  au rétablissement (sondage, `getScanStatus`, pochettes, widgets). `test/poller.test.js` vérifie
  qu'un cycle normal n'écrit rien en info.
- **Tests** : `test/helpers/fakeGladys.js` enveloppe le faux Gladys du SDK
  (`@gladysassistant/integration-sdk/testing`) : ids préfixés `ext:test-integration:`, charges
  validées comme par l'API hôte, vues `published` / `cameraImages` / `connectionStatuses`.
- **Navidrome à bibliothèque vide** (vérifié contre `deluan/navidrome` 0.64.2 en Docker) :
  `getArtists` répond l'erreur 70 « Library not found or empty » ; sans parade tout le sondage
  échouait et aucun état ne partait. `getArtists` la lit comme une bibliothèque vide (`[]`).
- **Publication** : ce dépôt n'a ni `CHANGELOG.md` ni `.github/scripts/release.mjs` :
  `outils/release.sh` déclenche le workflow Release ; ses notes viennent de
  `.github/release-notes/vX.Y.Z.md` s'il existe (ajouté avec la PR), sinon des PR.

## Lecteur Musique de Gladys 5.3 (26/10/2026, version 1.3.0)

Vérifié contre Navidrome 0.64.2 réel en Docker (jukebox activé, mpv en
`--ao=null`, bibliothèque générée par ffmpeg), `index.js` réel dans le
conteneur verrouillé, à travers le faux Gladys du SDK (54 contrôles).

- **Seul le jukebox est un lecteur** : c'est le seul que l'API pilote. Les
  écoutes des applications (`getNowPlaying`) restent sur l'appareil serveur
  (texte, pochette caméra, widget `now_playing`), en lecture seule ; aucun
  appareil par client : sans transport, l'action `music.play-media` du cœur
  (qui liste tout appareil à fonctionnalité `music` d'une intégration qui
  déclare `browse`) proposerait des lecteurs qui ne peuvent rien jouer.
- **Fonctionnalités** : `playback-state` (id 1.x gardé, passé par
  `featureExternalIds`), inscriptible 0/1/2 ; `volume` (id = type) ;
  `title`, `artist`, `album`, `artwork`, `duration`, `position` (seek par
  `skip` avec `offset`) aux ids `${device}:${type}`. Pas de `shuffle` (le
  `shuffle` de l'API mélange la file une fois), ni `repeat`, ni `mute`.
- **Ce que fait le jukebox de Navidrome** (`core/playback/device.go`) :
  `stop` est une pause ; `skip` garde lecture ou pause ; `set` = `clear` +
  `add` et **coupe le son** ; `add` d'un id inconnu échoue en entier ;
  `remove` d'un autre morceau ne touche pas la lecture mais l'index courant
  est **retrouvé par id** (premier doublon) ; en fin de file le dernier
  morceau reste courant, fermé (`playing` false, position 0). Réservé aux
  administrateurs par défaut (`Jukebox.AdminOnly`, erreur 50).
- **État 2 (IDLE)** : file vide, fin de file (vu jouer, puis arrêté à 0 sur le
  dernier morceau, hors relecture qui suit une commande), ou arrêt demandé
  par Gladys (pause + retour à 0, retenu tant que le jukebox ne bouge pas).
- **Relevés** : `status` à chaque relevé, `get` (toute la file) seulement si
  l'index change, après une commande, ou toutes les 5 min ; une relecture
  `poller.refresh('jukebox')` est programmée à la fin prévue du morceau quand
  elle tombe avant le prochain relevé. Un relevé forcé (connexion, config,
  appareil créé ou mis à jour) oublie l'instantané `publishNowPlaying`
  (`forgetPublished(gladys, config)`). Les publications passent une à une
  (relevé, commande et relecture partagent la file en cache et la mémoire
  d'arrêt).
- **Catalogue** (`src/catalog.js`) : ids `track:`, `album:`, `artist:`,
  `playlist:` suivis de l'id Subsonic, racines `gladys:` ; albums paginés par
  le serveur (`getAlbumList2`, total = lus + 1 tant que la page est pleine),
  artistes et playlists lus en entier (cache 1 min) ; morceaux lus **avant**
  `clear` (un id disparu ne vide pas la file) ; `add` par paquets de 100 ids ;
  500 morceaux au plus ; un artiste : albums lus 4 à la fois, 4 s au plus (le
  cœur donne 10 s à toute la commande). « À la suite » : retrait de la queue
  puis réajout (≤ 50 morceaux, pas de doublon du morceau courant avant lui,
  plus de 15 s avant sa fin, sinon un retrait tomberait sur le morceau suivant
  devenu courant), sinon `set` + `skip` à la même seconde + `start` ; en cas
  d'échec, la file d'avant est remise. Republication après une commande sans
  retarder l'accusé. Erreur 50 et « Jukebox is disabled » traduites dans le
  panneau. Langue des dossiers et des erreurs : champ `language`.
- **Pochettes** : clé SDK `artworkKey` d'une pseudo-URL
  `subsonic-cover://<serveur>/<taille>/<coverArt>` (jamais lue telle quelle) ;
  `onMusicGetArtwork` la relit avec les identifiants via `widgetCoverArt`
  (300 px pour le lecteur, 128 px pour les listes, plus petit si > 300 Ko).
  Navidrome redimensionne (PNG 7,9 Mo → 13 Ko en 128 px) et sert un WebP
  d'attente pour un album sans pochette : on ne publie alors pas de clé.

## Choix

- **Widgets sans réglage** : chacun suit le serveur configuré (une intégration = un serveur).
  Les tuiles chiffrées sont liées aux fonctionnalités publiées (`device_feature` =
  `gladys.externalIds('server', serverPlatformId(config)).feature(clé)`) : elles ne vivent que si
  l'appareil « Serveur Subsonic » a été ajouté à Gladys.
- **`now_playing` liste toutes les sessions de `getNowPlaying`**, les lectures réelles
  (`isPlaying`) d'abord, badge `success` pour elles et `neutral` pour les autres (le badge porte l'auditeur, le lecteur va dans la `description`, ouverte d'un clic) ; le capteur
  `active-streams`, lui, ne compte que les lectures réelles. La liste lue par le poll est mise
  en cache 30 s (`readNowPlaying` dans `server.js`) : le widget la réutilise, sinon il
  l'appelle.
- **`jukebox`** : les boutons sont des actions de widget (`toggle`, `previous`, `next`,
  `random`), pas des `device_feature` : ils marchent sans l'appareil jukebox ajouté. `toggle`
  relit `status` au moment du tap plutôt que de faire confiance à la carte affichée. Après
  chaque action, l'état de lecture est publié à Gladys depuis le `playing` de la réponse
  (`skip` et `start` renvoient un `jukeboxStatus`). Pas de toast pour toggle/précédent/suivant
  (le cœur recharge le widget dès la résolution), un toast pour aléatoire et scan.
- **`library`** : identité du serveur depuis le `ping` du démarrage (`serverInfo` dans
  `index.js`, remis à null à chaque `checkServerAndPublish`, relu à la demande s'il manque) ;
  `ttl_seconds` 900, 10 pendant un scan. `getScanStatus` refusé → ligne « Indisponible ».
- **Pochettes** : `src/covers.js`. Le contenu ne porte que des clés
  `cover-<id réduit à [a-z0-9], 40 car.>-<8 hex de sha1(id)>-300` (le hachage évite qu'un
  `al-1` et un `al1`, ou deux ids longs, partagent une clé et donc une pochette cachée 1 h) ;
  un registre borné (64) retient l'id derrière chaque clé, car l'id n'est pas reconstructible
  depuis la clé. `onWidgetGetImage` demande la pochette en 300 px, puis 160 px si elle
  dépasse 300 Ko décodés ou n'est pas un JPEG/PNG/WebP (seuls types acceptés par le cœur),
  et renvoie le base64 **brut** (le `image/jpeg;base64,` de `getCoverArt` est découpé par
  `splitDataImage`). Pas de repli sur l'image d'attente SVG du canal caméra : un morceau
  sans pochette est publié sans `image`.
- **États vides** : toujours un `text` body (non configuré, jukebox désactivé, rien en écoute,
  serveur injoignable avec le message d'erreur), jamais une erreur ; `ttl_seconds` 300 pour les
  états qui attendent l'utilisateur, 30 pour un serveur injoignable.
- `src/widgets.js` est **pur** (aucun réseau) : chaque contenu est passé à
  `validateWidgetContent` dans `test/widgets.test.js`. Les textes sont des objets
  `{ en, fr, de, es }`, le cœur choisit.
- **Langues** : manifeste et code en `en`, `fr`, `de`, `es` (les quatre langues du front).
  Tous les textes du code vivent dans `src/i18n.js` (`TEXT`, `MESSAGES`, `thrown()` qui
  joint les langues d'un message jeté) ; `test/i18n.test.js` refuse une langue manquante, un
  texte vide ou trop long, un « Sie »/« Ihr » de politesse en allemand (l'allemand tutoie,
  l'espagnol vouvoie), et tout `en:`/`fr:` écrit hors de `src/i18n.js`. La doc reste en
  `en`/`fr` (seules langues publiées par le store). Les noms de fonctionnalités restent en
  anglais (figés à la création, pas de réglage de langue).

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test` (`node --test`). Prettier contrôle **aussi le Markdown** : lancer `npm run format`
  après avoir modifié ce fichier ou le README, sinon la CI tombe.
- La CI tourne en Node 24. Une session cloud a Node 22 par défaut, ce qui suffit (`engines` :
  `>=20`).
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel passe par
  Guilhem ou par les testeurs du forum. Le dire, plutôt que de conclure que « ça marche ».
- **Publier est un geste de Guilhem** : Actions → Release (patch, minor ou major) construit
  l'image `ghcr.io/guim31/<dépôt>`, monte la version du manifeste et pose le tag. Un correctif
  poussé sur `main` sans Release n'atteint aucune installation : le signaler.
- Le workflow Release reformate le manifeste avec Prettier, publie l'image et crée la **release
  GitHub** (notes générées depuis les PR, ou `.github/release-notes/vX.Y.Z.md` s'il existe) : c'est
  elle que Gladys ouvre par « Voir le changelog de cette version ». Les trois workflows (`ci`,
  `build`, `release`) sont communs aux intégrations de guim31 : ne pas les modifier dans un seul dépôt.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys (communs aux intégrations de guim31)

Vérifiés dans le code du cœur ou payés sur une intégration publiée. Ils valent pour toutes.

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe (1000, 2000, 10000, 15000, 30000, 60000 ms).
  Publier seulement `poll_frequency` donne un appareil accepté mais jamais interrogé. Pour une
  cadence hors liste, publier `should_poll: false` et pousser les états depuis le conteneur, en
  gardant un `onPoll` de repli. Et même avec les deux, ne pas compter sur le cœur : un appareil
  créé sans `should_poll` ne sera jamais sondé, même une fois #3199 publié (Gladys#3198). Un
  minuteur du conteneur fait le travail (ici `src/poller.js`).
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié (`getDeviceFeatureName` du front).
- Depuis Gladys 4.84, un changement de structure fait proposer « Mettre à jour » dans l'onglet
  Découverte (`structure_changed`) : plus besoin de supprimer et recréer l'appareil. Un
  changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language`. Le superviseur injecte `TZ`, le
  fuseau de Gladys, dans le conteneur. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus en `<input type="number" min max>` **sans `step`** (le
  manifeste n'en accepte pas) : le navigateur n'accepte alors que `min + k`. Min et défaut
  **entiers** seulement ; une valeur décimale passe par un `select` ou par un `string` parsé
  (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir (la saisie
  s'efface à chaque frappe), et une action n'applique **aucun `default`**, ni à l'affichage ni
  côté serveur, tout en exigeant les champs `required` (422).

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- Budget du cœur : **8 composants par widget, dont 2 textes au plus**. Le validateur du SDK le
  signale ; `validateWidgetContent` est exporté pour les tests.
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées, ce que fait
  le bouton dans ses paramètres.
- Le vocabulaire des widgets n'a ni liste ni curseur. Seul un bouton `device_feature` numérique
  a un état actif natif.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil (Kp > 6) reste le travail
  d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- Passer `gladys_version` à `>=5.1.0` coupe les mises à jour des cœurs plus anciens, qui
  refusent les champs inconnus du manifeste.

## Publication et store

- Avant de demander une Release ou le topic, lancer le validateur officiel depuis la racine :
  `npx -y github:GladysAssistant/integration-store`. Il vérifie le schéma, la `description`
  (**100 caractères au plus par langue**), la documentation (300 caractères au moins), l'image
  Docker et la cover (**150 Ko au plus**).
- Le topic `gladys-assistant-integration` fait indexer le dépôt ; Guilhem le pose (le jeton de
  l'agent n'en a pas le droit). L'indexeur passe à H:13 chaque heure, souvent avec une demi-heure
  de retard, et rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  l'index `https://integration-store-storage.gladysassistant.com/index.json`.
- Sans topic, on installe par la carte « Installer depuis GitHub » (URL du dépôt, Gladys ≥ 4.84) :
  le cœur lit le manifeste sur `main` et propose les mises à jour à chaque rafraîchissement du
  catalogue.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi. Avant de pousser un dépôt neuf, tester sur
  un `git clone` propre, pas sur la copie de travail.
- Le validateur du store exige Node ≥ 24 dans son `engines` : sous Node 22 il affiche un
  `EBADENGINE` mais tourne quand même.

## Pièges propres à ce dépôt

- `getCoverArt` renvoie `<mime>;base64,…` pour le canal caméra (≤ 150 Ko **avec** le préfixe) ;
  une image de widget est du base64 brut, ≤ 300 Ko **décodés** : deux chemins, deux bornes.
- Les ids de pochette (`al-…`, `mf-…` chez Navidrome, numériques ailleurs) ne tiennent pas dans
  la grammaire des clés d'image sans perte : d'où le registre clé → id. Après un redémarrage, une
  clé inconnue est refusée ; le cœur recharge le contenu et la clé est réenregistrée.
- Un message **jeté** par une action (configuration ou widget) atteint l'écran tel quel, sans
  localisation. Un toast de widget fait **200 caractères au plus** (le français d'un message
  bilingue long disparaît) : le chemin widget jette des messages bilingues courts
  (`runScan(config, { widget: true })`, garde du jukebox), les longs restent aux boutons de
  configuration.
- Une publication d'état après un bouton de widget peut être **refusée par le cœur** (appareil
  jamais ajouté à Gladys : réponse non-2xx, le client HTTP du SDK lève). La commande a déjà agi :
  la publication est entourée d'un `try/catch` et loguée, l'action ne doit jamais échouer pour
  elle.
- `jukeboxControl` : `get` renvoie `jukeboxPlaylist` (avec `entry`, `currentIndex`, `playing`,
  `gain`), toute autre action renvoie `jukeboxStatus` (sans `entry`). `skip` lance la lecture.
  `currentIndex` peut manquer ou sortir de la file : `currentJukeboxTrack` se rabat sur 0.
