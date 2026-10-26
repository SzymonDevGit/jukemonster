# Jukemonster

A one-screen music party game. Each player picks one of their Spotify playlists, and Jukemonster is the jukebox.

It is a plain static website (`index.html`, `style.css`, `app.js`). There is no server and no build step. Spotify sign-in uses the PKCE flow, so the Spotify **client secret is never needed and must never be added here**.

## Games

Pick **Solo** or **Multiplayer** first, then a game:

| Game | Solo | Multiplayer | How it works |
| --- | :-: | :-: | --- |
| Classic | | ✓ | The app plays a song; you place your own physical Hitster-style cards and press Reveal. |
| Guess the Song | ✓ | ✓ | Listen to 0.5, 1, 5 or 30 seconds (each unlocks after the last). 4, 3, 2 or 1 points for a right answer. 10, 20 or 40 songs solo; 6, 10 or 20 rounds in multiplayer. |
| Match the Album | ✓ | ✓ | Hear a song and pick which of 5 albums by that artist it's from (covers and names shown). 1 point per right album; same lengths as Guess the Song. Songs that only came out as singles are skipped, as are artists with fewer than 5 albums. |
| Timeline | ✓ | ✓ | Place each song in your on-screen timeline. Everyone's timeline is shown. First to 20 cards wins; solo ends after 6 wrong placements. |
| Whose Playlist? | | ✓ (3+) | Guess which other player's playlist the song is from. 6, 10 or 20 rounds. |
| Older or Newer | ✓ | ✓ | Is the song older or newer than the last one? Same year counts as right. 6, 10 or 20 rounds; solo ends after 2 misses. |

Before starting, press **Test Audio** and **Heard it!** to check sound. Music plays in the browser tab itself (desktop Chrome or Edge; Firefox and Zen don't work for now), or on any Spotify app you have open, picked under **Play on**. Short snippets are most accurate when playing in the browser tab.

## Your Spotify app

Jukemonster has no Spotify app of its own: each host makes a free one (needs Spotify Premium), and the sign-in screen walks through it the first time. In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), create an app (no Create app button? use [developer.spotify.com/dashboard/create](https://developer.spotify.com/dashboard/create)) and add the address you open Jukemonster at as a **Redirect URI**, exactly, with the trailing slash:

- `http://127.0.0.1:8000/` for running it on your own PC
- `https://jukemonster.szy.monster/` for the live site

Under **APIs used**, tick both **Web API** and **Web Playback SDK** (the second lets music play straight in the browser tab). Then paste the app's **Client ID** on the sign-in screen. It's kept in that browser only.

Songs are started from their playlist (or album), because since autumn 2026 some Spotify apps answer "OK" to a bare song and then play nothing. The app remembers which way works on each device.

Playing in the browser needs protected content (DRM) turned on. In Firefox: Settings › General › tick "Play DRM-controlled content". Chrome and Edge have it on by default.

If music doesn't start, press **Copy details for troubleshooting** in the app. It copies the device list and the last playback steps (no passwords or keys).

Spotify's rules for hobby ("Development mode") apps, as of 2026:

- The app owner needs Spotify Premium, and playing songs needs Premium.
- Only the app's owner and up to 5 people added under **User Management** can sign in to it. Anyone else makes their own app.
- The app can only read the songs of playlists the signed-in person **owns or collaborates on**. Saved playlists are listed too, and picking one explains how to copy it: open it in Spotify, press Ctrl+A, right-click › Add to playlist › New playlist.
- Spotify no longer shares song popularity, so "Most Popular" is greyed out and "Most Recently Added" is used.

## Default mode

The **★ Jukemonster default** choice in every playlist picker lets anyone play without picking a playlist. Its songs are listed in `default-songs.json`: Spotify's most streamed songs of all time (907 of them, from kworb.net, October 2026). The first time someone uses it, the app looks each song up on Spotify (the game can start once 60 are found; the rest keep coming in) and remembers the results in that browser. Each song is started from its album, which anyone can play.

To skip the lookup for everyone, open the app with `?export` at the end of the address (for example http://127.0.0.1:8000/?export), wait until the default songs are all found, press **Save as default deck**, and put the downloaded `default-deck.json` next to `index.html`. The same link saves any of your own playlists as the default instead.

## Run it on your PC

Double-click `run-local.bat` (Windows, needs Python), or run:

```
python -m http.server 8000 --bind 127.0.0.1
```

then open http://127.0.0.1:8000/ (use `127.0.0.1`, not `localhost`, because that is what Spotify allows).

## Hosting (Cloudflare)

`wrangler.jsonc` serves this folder as a static site, and `.assetsignore` keeps the README, `run-local.bat` and git files out of it. In Cloudflare, create a Worker from this repository with:

- Build command: *(leave empty)*
- Deploy command: `npx wrangler deploy`

Then add the custom domain `jukemonster.szy.monster` under the Worker's **Settings › Domains & Routes**.
