# Jukemonster

A one-screen companion for Hitster-style music timeline games. Each player brings their own Spotify playlist, Jukemonster plays a mystery song from it, and you flip the card to check the year once everyone has placed their guess. You keep score with your own physical cards, exactly like the board game.

It is a plain static website (`index.html`, `style.css`, `app.js`). There is no server and no build step. Spotify sign-in uses the PKCE flow, so the Spotify **client secret is never needed and must never be added here**.

## How to play

1. Sign in with Spotify (needs Premium).
2. Pick how many players and paste each player's playlist link.
3. Press **Load Playlists**, then **Test Audio**, and **Heard it!** once you hear music.
4. Choose options (mix playlists, include months, max 3 songs per year), then **Start Game**.
5. Pick whose turn it is, press **Play Card**, place your card, then **Reveal**.
6. Press **Next Card** for the next player.

Music plays in the browser tab itself (desktop Chrome, Edge or Firefox), or on any Spotify app you have open, picked under **Play on**.

## Spotify app settings

In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open the app and add these **Redirect URIs** exactly (with the trailing slash):

- `http://127.0.0.1:8000/` for running it on your own PC
- `https://jukemonster.szy.monster/` for the live site

Spotify's rules for hobby ("Development mode") apps, as of 2026:

- The app owner needs Spotify Premium, and playing songs needs Premium.
- Only people added under **User Management** in the dashboard can sign in.
- The app can only read playlists the signed-in person **owns or collaborates on**. For a friend's playlist, ask them to invite you as a collaborator, or copy its songs into a playlist of your own.
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
