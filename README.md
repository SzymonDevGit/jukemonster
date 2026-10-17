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

If music doesn't start, press **Copy details for troubleshooting** in the app. It copies the device list and the last playback steps (no passwords or keys).

Spotify's rules for hobby ("Development mode") apps, as of 2026:

- The app owner needs Spotify Premium, and playing songs needs Premium.
- Only people added under **User Management** in the dashboard can sign in.
- The app can only read playlists the signed-in person **owns or collaborates on**, so only those are listed. For a friend's playlist, ask them to invite you as a collaborator, or copy its songs into a playlist of your own.
- Spotify no longer shares song popularity, so "Most Popular" is greyed out and "Most Recently Added" is used.

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
