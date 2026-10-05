# Intégration Subsonic

Cette intégration relie Gladys Assistant à un serveur musical compatible avec
l'[API Subsonic](https://www.subsonic.org/pages/api.jsp) :
[Navidrome](https://www.navidrome.org), Airsonic-Advanced, Gonic, LMS,
Subsonic… Elle a été pensée et testée d'abord pour **Navidrome**.

## Ce que vous obtenez

- Un appareil **Serveur Subsonic** avec cinq capteurs rafraîchis
  périodiquement, utilisables dans vos scènes et sur votre tableau de bord :
  - **En écoute** : le morceau joué en ce moment, au format
    `Artiste — Titre (auditeur)`. Gladys déclenche ses scènes sur le
    changement de cette valeur : vous pouvez donc réagir à chaque nouveau
    morceau ;
  - **Lectures en cours** : nombre de morceaux en train d'être écoutés
    (pratique pour une scène « ne pas couper le son si quelqu'un écoute de la
    musique ») ;
  - **Pochette de l'album** : l'image de l'album en cours d'écoute. Elle
    passe par le canal image de Gladys, donc elle s'affiche avec le widget
    **Caméra** du tableau de bord (choisissez l'appareil « Subsonic
    server »). Quand la lecture s'arrête, la dernière pochette reste
    affichée ; tant que rien n'a jamais été écouté, une image d'attente
    neutre prend sa place ;
  - **Morceaux**, **Artistes** et **Albums** de la bibliothèque.
- Un appareil **Jukebox Subsonic** (optionnel) pour piloter la lecture _côté
  serveur_ : lecture/pause, précédent/suivant, volume et état de lecture.
- Des boutons dans l'écran de configuration : tester la connexion, lancer un
  scan de la bibliothèque, lancer une lecture aléatoire ou une playlist sur le
  jukebox.
- Trois widgets de tableau de bord (Gladys 5.1 ou plus récent) : **En
  écoute**, **Jukebox** et **Bibliothèque** — voir plus bas.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Renseignez :
   - **URL du serveur** : la racine de votre serveur, sans `/rest` — par
     exemple `https://musique.mondomaine.fr` ou `http://192.168.1.10:4533`
     (port par défaut de Navidrome) ;
   - **Utilisateur** et **Mot de passe** : un compte de votre serveur. Créez
     de préférence un compte dédié à Gladys ;
   - **Méthode d'authentification** : laissez **Jeton** (le mot de passe ne
     transite jamais, seul un hachage md5 salé est envoyé). Ne passez en
     **Legacy** que pour un serveur très ancien (API < 1.13) ou un compte
     LDAP qui refuse le jeton (erreur 41) ;
   - **Intervalle de rafraîchissement** : fréquence d'interrogation des
     capteurs (60 s par défaut).
3. Enregistrez, puis cliquez sur **Tester la connexion** : le serveur répond
   avec son nom et sa version (par exemple `navidrome 0.52`).
4. Les appareils apparaissent dans l'onglet **Découverte**, prêts à être
   ajoutés.

## Le jukebox (lecture côté serveur)

Le mode jukebox fait jouer la musique **sur la machine qui héberge le
serveur** (celle reliée à vos enceintes), via la commande `jukeboxControl` de
l'API. Il faut l'activer des deux côtés :

1. **Côté serveur.** Pour Navidrome, dans `navidrome.toml` :

   ```toml
   [Jukebox]
   Enabled = true
   ```

   ou via la variable d'environnement `ND_JUKEBOX_ENABLED=true`. La machine
   doit avoir une sortie audio fonctionnelle (voir la
   [documentation du mode jukebox de Navidrome](https://www.navidrome.org/docs/usage/jukebox/)).

2. **Côté Gladys.** Activez **Activer l'appareil jukebox** dans la
   configuration de l'intégration : l'appareil « Jukebox Subsonic » apparaît
   alors dans la découverte.

Vous pouvez ensuite, depuis vos scènes ou le tableau de bord : mettre en
lecture/pause, passer au morceau suivant ou précédent, régler le volume, et
déclencher les boutons **Lecture aléatoire** (N morceaux au hasard) ou
**Jouer une playlist** (par son nom exact, la casse est ignorée).

## Widgets du tableau de bord

Avec Gladys 5.1 ou plus récent, l'intégration propose trois widgets
(**Modifier le tableau de bord** → **Ajouter un widget**). Ils n'ont aucun
réglage : chacun suit le serveur configuré. Les tuiles chiffrées sont liées
aux capteurs de l'appareil « Serveur Subsonic » : ajoutez-le à Gladys pour
qu'elles affichent une valeur.

- **En écoute** — le nombre de lectures en cours (la tuile suit le capteur en
  direct) et une ligne par session que le serveur liste : titre, artiste ·
  album, la pochette, et en badge le nom du lecteur ou de l'auditeur, vert
  quand la session joue réellement, gris quand elle est en pause ou arrêtée
  (le serveur garde une session un moment après l'arrêt). Huit lignes au
  plus, les lectures actives en premier. Sans lecture : « Rien en écoute. »
  Rafraîchi toutes les 30 secondes ; la liste lue par le relevé périodique
  est réutilisée quand elle a moins de 30 secondes.
- **Jukebox** — la lecture côté serveur en télécommande : la pochette et le
  titre du morceau en cours, artiste · album, puis l'état (Lecture / Arrêt),
  le volume et la position dans la file (« 2 / 20 »), et quatre boutons :
  **Pause** ou **Lecture** selon l'état, **Précédent**, **Suivant** et
  **Aléatoire** (20 morceaux au hasard, comme le bouton de la configuration).
  Une file vide ne propose qu'**Aléatoire**. Tant que l'appareil jukebox
  n'est pas activé dans la configuration, le widget le dit. Rafraîchi toutes
  les 30 secondes, et dès qu'un bouton a agi. Les boutons fonctionnent même si
  l'appareil « Jukebox Subsonic » n'a pas été ajouté à Gladys ; l'état de
  lecture publié à Gladys suit chaque commande.
- **Bibliothèque** — trois tuiles en direct (**Morceaux**, **Artistes**,
  **Albums**), l'identité du serveur (type et version renvoyés par le ping,
  par exemple `navidrome 0.53.3`), l'état du scan (« En cours · n » ou
  « Terminé · n morceaux » ; « Indisponible » quand le serveur refuse
  `getScanStatus` à ce compte) et un bouton **Scanner**. Rafraîchi toutes les
  15 minutes, toutes les 10 secondes pendant un scan. Le bouton est soumis aux
  mêmes droits que celui de la configuration : Navidrome réserve le scan aux
  administrateurs.

Les pochettes des widgets sont servies par l'intégration (elles sont demandées
au serveur en 300 px) et mises en cache une heure par Gladys. Un morceau sans
pochette s'affiche sans image.

## Dépannage

- **« Wrong username or password » (erreur 40)** : vérifiez l'identifiant et
  le mot de passe en vous connectant à l'interface web du serveur.
- **Erreur 41** : votre compte (souvent LDAP) n'accepte pas
  l'authentification par jeton — passez la méthode sur **Legacy**.
- **« Cannot reach the Subsonic server »** : vérifiez que l'URL est joignable
  _depuis Gladys_ (même machine/réseau que le conteneur de l'intégration),
  pas seulement depuis votre navigateur.
- **Le jukebox ne produit aucun son** : le son sort sur l'hôte du serveur,
  pas sur l'appareil où tourne Gladys. Vérifiez `Jukebox.Enabled` et la
  sortie audio de l'hôte (accès au périphérique audio du conteneur Docker le
  cas échéant).
- **Les capteurs affichent « Pas de valeur récente »** : ils n'ont encore
  jamais été relevés. Après une mise à jour de l'intégration, retournez dans
  l'onglet **Découverte** et recliquez sur l'appareil : cela réapplique sa
  définition (dont l'activation du relevé périodique) à l'appareil déjà créé.
  La première valeur arrive au relevé suivant (60 s par défaut).
- **« Le serveur refuse le scan pour ce compte »** : lancer un scan est réservé
  aux administrateurs (c'est le cas dans Navidrome). Ce n'est pas gênant : le
  bouton n'est qu'un raccourci, le serveur scanne selon sa propre planification
  et les capteurs suivent. Passez le compte administrateur si vous tenez à ce
  bouton — rien d'autre dans l'intégration ne demande ces droits.
- **Un morceau reste affiché alors que la lecture est arrêtée** : le serveur
  garde la session dans sa liste « en cours de lecture » un moment après
  l'arrêt. L'intégration ne compte que les sessions dont l'état est réellement
  « en lecture », mais un lecteur qui se contente de se taire, sans prévenir le
  serveur (le protocole Subsonic classique n'a pas de notion d'arrêt), reste
  listé jusqu'à la fin théorique du morceau.
- **Les capteurs ne bougent pas** : le nombre d'artistes/albums ne change
  qu'après un scan de la bibliothèque — utilisez le bouton **Scanner la
  bibliothèque musicale**.
