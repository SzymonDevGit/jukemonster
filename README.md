# Jukemonster

A one-screen music party game. Each player picks one of their Spotify playlists, and Jukemonster is the jukebox.

It is a plain static website (`index.html`, `style.css`, `app.js`). There is no server and no build step. Spotify sign-in uses the PKCE flow, so the Spotify **client secret is never needed and must never be added here**.

## Games

Pick **Solo** or **Multiplayer** first, then a game:

| Game | Solo | Multiplayer | How it works |
| --- | :-: | :-: | --- |
| Classic | | ✓ | The app plays a song; you place your own physical Hitster-style cards and press Reveal. |
| Guess the Song | ✓ | ✓ | Listen to 0.5, 1, 5 or 30 seconds (each unlocks after the last). 4, 3, 2 or 1 points for a right answer. Set the number of rounds. |
| Timeline | ✓ | ✓ | Place each song in your on-screen timeline. Everyone's timeline is shown. First to 10 cards wins; solo ends after 3 wrong placements. |
| Whose Playlist? | | ✓ (3+) | Guess which other player's playlist the song is from. |
| Older or Newer | ✓ | ✓ | Is the song older or newer than the last one? Same year counts as right. Solo is a streak until your first miss. |

Before starting, press **Test Audio** and **Heard it!** to check sound. Music plays in the browser tab itself (desktop Chrome, Edge or Firefox), or on any Spotify app you have open, picked under **Play on**. Short snippets are most accurate when playing in the browser tab.

## Spotify app settings

In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open the app and add these **Redirect URIs** exactly (with the trailing slash):

- `http://127.0.0.1:8000/` for running it on your own PC
- `https://jukemonster.szy.monster/` for the live site

Under **APIs used**, tick both **Web API** and **Web Playback SDK** (the second lets music play straight in the browser tab).

Songs are started from their playlist (or album), because since autumn 2026 some Spotify apps answer "OK" to a bare song and then play nothing. The app remembers which way works on each device.

Playing in the browser needs protected content (DRM) turned on. In Firefox: Settings › General › tick "Play DRM-controlled content". Chrome and Edge have it on by default.

If music doesn't start, press **Copy details for troubleshooting** in the app. It copies the device list and the last playback steps (no passwords or keys).

Spotify's rules for hobby ("Development mode") apps, as of 2026:

- The app owner needs Spotify Premium, and playing songs needs Premium.
- Only people added under **User Management** in the dashboard can sign in.
- The app can only read the songs of playlists the signed-in person **owns or collaborates on**. Saved playlists are listed too, and picking one explains how to copy it: open it in Spotify, press Ctrl+A, right-click › Add to playlist › New playlist.
- Spotify no longer shares song popularity, so "Most Popular" is greyed out and "Most Recently Added" is used.

## Default mode

`default-deck.json` holds the songs for the **★ Jukemonster default** choice in every playlist picker, so anyone can play without picking a playlist. The songs come from [this playlist](https://open.spotify.com/playlist/7epfU4cGVZ1xHWQbQJl7km), and each one is started from its album, which anyone can play.

To make or update the file:

1. In Spotify, copy that playlist into one of your own (open it, Ctrl+A, right-click › Add to playlist › New playlist).
2. Open the app with `?export` at the end of the address (for example http://127.0.0.1:8000/?export), pick your copy, and press **Save as default deck**.
3. Put the downloaded `default-deck.json` next to `index.html`.

## Run it on your PC

Double-click `run-local.bat` (Windows, needs Python), or run:

```
python -m http.server 8000 --bind 127.0.0.1
```

then open http://127.0.0.1:8000/ (use `127.0.0.1`, not `localhost`, because that is what Spotify allows).

## Hosting (Cloudflare Pages)

Create a Pages project from this repository with:

- Build command: *(leave empty)*
- Build output directory: `/`

Then add the custom domain `jukemonster.szy.monster` in the project's **Custom domains** tab.
