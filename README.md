# Gladys Subsonic — intégration externe pour Gladys Assistant

Intégration externe [Gladys Assistant](https://gladysassistant.com) pour les
serveurs musicaux compatibles avec l'[API Subsonic](https://www.subsonic.org/pages/api.jsp) :
**[Navidrome](https://www.navidrome.org)**, Airsonic-Advanced, Gonic, LMS,
Subsonic…

Construite à partir du
[template officiel JavaScript](https://github.com/GladysAssistant/integration-template-js)
et du SDK [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## Fonctionnalités

| Appareil             | Fonctionnalités                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Serveur Subsonic** | Capteurs : en écoute (texte), pochette de l'album (canal image), lectures en cours, morceaux/artistes/albums de la bibliothèque |
| **Jukebox Subsonic** | Lecture/pause, précédent/suivant, volume, état de lecture — via `jukeboxControl` (optionnel)                                    |

Boutons de l'écran de configuration :

- **Tester la connexion** — `ping` du serveur, affiche son identité
  (ex. `navidrome 0.52`, API 1.16.1) ;
- **Scanner la bibliothèque musicale** — `startScan` ;
- **Jukebox : lecture aléatoire** — met N morceaux au hasard dans la file du
  jukebox et lance la lecture ;
- **Jukebox : jouer une playlist** — retrouve une playlist par son nom et la
  joue sur le jukebox.

L'authentification utilise par défaut le **jeton salé** de l'API
(`t = md5(password + salt)`, le mot de passe ne transite jamais), avec un
repli `legacy` pour les serveurs pré-1.13 et les comptes LDAP.

La documentation utilisateur (configuration côté Gladys et côté Navidrome,
dépannage) est dans [`docs/fr.md`](./docs/fr.md) / [`docs/en.md`](./docs/en.md) —
Gladys la ré-héberge et l'affiche via le lien **Documentation** de l'écran de
configuration.

## Structure du projet

```
.
├─ index.js                          # bootstrap SDK + câblage des événements
├─ src/
│  ├─ subsonic.js                    # client de l'API Subsonic (auth, endpoints)
│  ├─ config.js                      # valeurs par défaut + normalisation
│  └─ devices/
│     ├─ index.js                    # registre des appareils
│     ├─ server.js                   # capteurs du serveur + actions scan/test
│     └─ jukebox.js                  # lecture côté serveur (jukeboxControl)
├─ docs/fr.md, docs/en.md            # documentation utilisateur
├─ gladys-assistant-integration.json # manifest (config, actions, image Docker)
├─ Dockerfile                        # Node 24 Alpine, rootfs read-only
└─ .github/workflows/                # CI + build multi-arch + release
```

## Lancer en local

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="subsonic" \
LOG_LEVEL=debug \
npm start
```

Les trois variables `GLADYS_*` sont injectées automatiquement par le
superviseur Gladys quand l'intégration tourne dans son conteneur.

## Qualité

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # tests unitaires (node --test)
```

Les trois vérifications tournent en CI sur chaque push et pull request.

Avant de publier, le validateur du store peut être exécuté localement :

```bash
npx github:GladysAssistant/integration-store .
```

## Publication

1. Le dépôt porte le topic GitHub `gladys-assistant-integration`.
2. **Actions → Release → Run workflow** (patch / minor / major) : bump de
   version (`package.json` + manifest), tag `vX.Y.Z`, build multi-arch
   (`linux/amd64` + `linux/arm64`) poussé sur
   `ghcr.io/guim31/gladys-subsonic`.
3. L'indexeur décentralisé du store détecte la nouvelle version ; Gladys
   propose l'installation/mise à jour en un clic.

## Licence

Apache-2.0
