# Subsonic integration

This integration links Gladys Assistant with any music server implementing
the [Subsonic API](https://www.subsonic.org/pages/api.jsp):
[Navidrome](https://www.navidrome.org), Airsonic-Advanced, Gonic, LMS,
Subsonic… It was designed and tested first against **Navidrome**.

## What you get

- A **Subsonic server** device with five periodically refreshed sensors,
  usable in your scenes and on your dashboard:
  - **Now playing**: the track being played right now, as
    `Artist — Title (listener)`. Gladys fires its scene triggers when this
    value changes, so you can react to every new track;
  - **Active streams**: how many songs are being played right now (handy for
    a "don't cut the sound while someone is listening" scene);
  - **Songs**, **Artists** and **Albums** counted in the library.
- An optional **Subsonic jukebox** device to control _server-side_ playback:
  play/pause, previous/next, volume and playback state.
- Buttons in the Configuration screen: test the connection, start a library
  scan, play random songs or a playlist on the jukebox.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Fill in:
   - **Server URL**: the root of your server, without `/rest` — for example
     `https://music.mydomain.com` or `http://192.168.1.10:4533` (Navidrome's
     default port);
   - **Username** and **Password**: an account on your server. Prefer a
     dedicated account for Gladys;
   - **Authentication method**: keep **Token** (the password never transits,
     only a salted md5 hash is sent). Switch to **Legacy** only for very old
     servers (API < 1.13) or LDAP accounts that reject tokens (error 41);
   - **Refresh interval**: how often the sensors are polled (60 s by
     default).
3. Save, then click **Test the connection**: the server answers with its name
   and version (for example `navidrome 0.52`).
4. The devices show up in the **Discovery** tab, ready to be added.

## The jukebox (server-side playback)

Jukebox mode plays the music **on the machine hosting the server** (the one
wired to your speakers), through the `jukeboxControl` API endpoint. It must
be enabled on both sides:

1. **Server side.** For Navidrome, in `navidrome.toml`:

   ```toml
   [Jukebox]
   Enabled = true
   ```

   or with the `ND_JUKEBOX_ENABLED=true` environment variable. The host needs
   a working audio output (see the
   [Navidrome jukebox mode documentation](https://www.navidrome.org/docs/usage/jukebox/)).

2. **Gladys side.** Turn on **Enable the jukebox device** in the integration
   configuration: the "Subsonic jukebox" device then appears in discovery.

From your scenes or the dashboard you can then: play/pause, skip to the next
or previous track, set the volume, and trigger the **Play random songs**
(N random tracks) or **Play a playlist** (by exact name, case-insensitive)
buttons.

## Troubleshooting

- **"Wrong username or password" (error 40)**: double-check the credentials
  by logging into the server's web interface.
- **Error 41**: your account (often LDAP) does not accept token
  authentication — switch the method to **Legacy**.
- **"Cannot reach the Subsonic server"**: make sure the URL is reachable
  _from Gladys_ (same machine/network as the integration container), not
  only from your browser.
- **The jukebox makes no sound**: the audio comes out of the server host, not
  the device running Gladys. Check `Jukebox.Enabled` and the host's audio
  output (audio device access for a Docker container, if applicable).
- **The sensors show "no recent value"**: they have never been polled yet.
  After updating the integration, go back to the **Discovery** tab and click
  the device again: this re-applies its definition (including the periodic
  polling flag) to the already created device. The first value lands on the
  next poll (60 s by default).
- **The sensors never change**: the artist/album counters only move after a
  library scan — use the **Scan the music library** button.
