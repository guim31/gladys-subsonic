# CLAUDE.md — Subsonic

Reliez Gladys à un serveur musical compatible Subsonic : Navidrome, Airsonic, Gonic...

Intégration externe pour [Gladys Assistant](https://gladysassistant.com), bâtie sur le template officiel `GladysAssistant/integration-template-js` (SDK `@gladysassistant/integration-sdk` ^0.14.0, `gladys_version` `>=5.1.0`). Mainteneur : Guilhem (`guim31`).

Ce fichier rassemble ce qu'une session de code doit savoir et qui ne se lit pas dans le code : choix de conception, faits vérifiés en réel, pièges déjà payés. Le compléter quand un nouveau piège est découvert.

## État au 05/10/2026

Version 1.0.8 publiée, indexée dans le store, sans widget. La branche
`feat/dashboard-widgets` (PR « feat: dashboard widgets (Gladys 5.1) ») passe au SDK 0.14 et à
`gladys_version >=5.1.0`, et ajoute trois widgets : `now_playing`, `jukebox`, `library`. Rien de
tout cela n'a été vu sur une instance Gladys ni sur un serveur Subsonic réel : seuls les tests, le
lint et le validateur du store ont tourné. Le passage à `>=5.1.0` coupe les mises à jour des cœurs
4.x : la Release qui l'embarque est une **minor**, à annoncer.

## Choix

- **Widgets sans réglage** : chacun suit le serveur configuré (une intégration = un serveur).
  Les tuiles chiffrées sont liées aux fonctionnalités publiées (`device_feature` =
  `gladys.externalIds('server', serverPlatformId(config)).feature(clé)`) : elles ne vivent que si
  l'appareil « Serveur Subsonic » a été ajouté à Gladys.
- **`now_playing` liste toutes les sessions de `getNowPlaying`**, les lectures réelles
  (`isPlaying`) d'abord, badge `success` pour elles et `neutral` pour les autres ; le capteur
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
- **Pochettes** : `src/covers.js`. Le contenu ne porte que des clés `cover-<id réduit à
[a-z0-9]>-300` ; un registre borné (64) retient l'id derrière chaque clé, car l'id n'est pas
  reconstructible depuis la clé. `onWidgetGetImage` demande la pochette en 300 px, puis 160 px
  si elle dépasse 300 Ko décodés, et renvoie le base64 **brut** (le `image/jpeg;base64,` de
  `getCoverArt` est découpé par `splitDataImage`). Pas de repli sur l'image d'attente SVG du
  canal caméra : le cœur n'accepte que PNG, JPEG et WebP, donc un morceau sans pochette est
  publié sans `image`.
- **États vides** : toujours un `text` body (non configuré, jukebox désactivé, rien en écoute,
  serveur injoignable avec le message d'erreur), jamais une erreur ; `ttl_seconds` 300 pour les
  états qui attendent l'utilisateur, 30 pour un serveur injoignable.
- `src/widgets.js` est **pur** (aucun réseau) : chaque contenu est passé à
  `validateWidgetContent` dans `test/widgets.test.js`. Les textes sont des objets `{ en, fr }`,
  le cœur choisit.

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
- Le workflow Release réindente le manifeste sans relancer la CI : passer `npm run format` au
  commit suivant.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys (communs aux intégrations de guim31)

Vérifiés dans le code du cœur ou payés sur une intégration publiée. Ils valent pour toutes.

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe (1000, 2000, 10000, 15000, 30000, 60000 ms).
  Publier seulement `poll_frequency` donne un appareil accepté mais jamais interrogé. Pour une
  cadence hors liste, publier `should_poll: false` et pousser les états depuis le conteneur, en
  gardant un `onPoll` de repli.
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
  localisation : les messages longs bilingues de `runScan` dépassent les 200 caractères d'un
  toast, le cœur les tronque sûrement. Non vérifié en réel.
- `jukeboxControl` : `get` renvoie `jukeboxPlaylist` (avec `entry`, `currentIndex`, `playing`,
  `gain`), toute autre action renvoie `jukeboxStatus` (sans `entry`). `skip` lance la lecture.
  `currentIndex` peut manquer ou sortir de la file : `currentJukeboxTrack` se rabat sur 0.
