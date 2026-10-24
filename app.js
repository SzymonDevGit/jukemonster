/*
 * Jukemonster: a one-screen music party game. Each player brings a Spotify
 * playlist and Jukemonster is the jukebox, with five games:
 *   Classic         - the app plays songs, you use your own physical cards
 *   Guess the Song  - name it from a 0.5 / 1 / 5 / 30 second snippet (type it or say it)
 *   Timeline        - place songs in your on-screen timeline
 *   Whose Playlist? - guess which player's playlist a song is from
 *   Older or Newer  - is this song older or newer than the last one?
 *
 * Runs fully in the browser. Spotify sign-in uses the PKCE flow, so no client
 * secret is needed (or allowed) here.
 */
"use strict";

// Each host plays through their own Spotify app (Spotify lets only 5 people sign in
// to an app in development mode). Its Client ID is entered on the sign-in screen and
// kept in this browser. Never put a client secret in this file.
const CLIENT_ID = (() => {
  try { return JSON.parse(localStorage.getItem("jm_client_id")) || ""; } catch { return ""; }
})();
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",
  "user-read-private",
  "user-read-email",
].join(" ");
// Must match a Redirect URI in the Spotify dashboard exactly.
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, "");

// Default mode: a song list saved in default-deck.json (see README). Its songs
// start from their albums, which anyone can play and always hold the song.
const DEFAULT_ID = "default";
// Open the app with ?export to get a "Save as default deck" link on loaded playlists
// (remembered for this tab, because signing in reloads the page without it).
const EXPORT_MODE = (() => {
  try {
    if (new URLSearchParams(location.search).has("export")) sessionStorage.setItem("jm_export", "1");
    return sessionStorage.getItem("jm_export") === "1";
  } catch { return false; }
})();
const COPY_HELP = "Spotify only shares the songs of playlists you made or collaborate on. To use this one, make your own copy: open it in Spotify on a computer, press Ctrl+A (Cmd+A on a Mac), right-click › Add to playlist › New playlist. On a phone, use the playlist's ⋯ menu › Add to other playlist. Then press Refresh list here.";

const MAX_PLAYERS = 6;
const MAX_PER_YEAR = 3;
const FULL_PLAY_MS = 30000;
const TIMELINE_GOAL = 20;
const SOLO_LIVES = 6;          // Timeline solo: wrong placements allowed
const OLDER_NEWER_LIVES = 2;   // Older or Newer solo: misses allowed
const ALBUM_CHOICES = 5;       // Match the Album: albums to pick from
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const PLAYER_COLORS = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)", "var(--p5)"];

// Guess the Song: the less you hear, the more it's worth.
const LEVELS = [
  { ms: 500, label: "0.5 sec", points: 4 },
  { ms: 1000, label: "1 sec", points: 3 },
  { ms: 5000, label: "5 sec", points: 2 },
  { ms: 30000, label: "30 sec", points: 1 },
];

const MODES = {
  classic: {
    name: "Classic", color: "var(--p0)", solo: false,
    desc: "Play with your own physical cards. The app is just the jukebox.",
  },
  guess: {
    name: "Guess the Song", color: "var(--p1)", solo: true,
    desc: "Name it from a 0.5, 1, 5 or 30 second snippet. The less you hear, the more points.",
  },
  album: {
    name: "Match the Album", color: "var(--p4)", solo: true,
    desc: "Hear a song, then pick which of 5 albums by that artist it's from.",
  },
  timeline: {
    name: "Timeline", color: "var(--p2)", solo: true,
    desc: "Place each song in your own timeline. First to 20 cards wins.",
    soloDesc: "Build your timeline. Six wrong placements and it's over.",
  },
  whose: {
    name: "Whose Playlist?", color: "var(--p3)", solo: false, minPlayers: 3,
    desc: "Guess which player's playlist the song came from. 3 or more players.",
  },
  oldernewer: {
    name: "Older or Newer", color: "var(--p5)", solo: true,
    desc: "Is this song older or newer than the last one?",
    soloDesc: "Is each song older or newer than the last? Two misses and it's over.",
  },
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Storage (wrapped: private windows can throw)
// ---------------------------------------------------------------------
const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

// ---------------------------------------------------------------------
// Spotify auth (Authorization Code with PKCE)
// ---------------------------------------------------------------------
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startLogin() {
  if (!CLIENT_ID) return;
  const verifier = randomString(64);
  const state = randomString(16);
  store.set("jm_verifier", verifier);
  store.set("jm_state", state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: await codeChallenge(verifier),
    scope: SCOPES,
    state,
  });
  location.href = "https://accounts.spotify.com/authorize?" + params;
}

function saveToken(data) {
  const token = {
    access: data.access_token,
    refresh: data.refresh_token || (store.get("jm_token") || {}).refresh,
    scope: data.scope || (store.get("jm_token") || {}).scope || "",
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  store.set("jm_token", token);
  return token;
}

async function tokenRequest(body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Spotify sign-in failed (${res.status})`);
  return saveToken(data);
}

async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  history.replaceState(null, "", REDIRECT_URI);
  if (params.get("error")) throw new Error(`Spotify sign-in was cancelled (${params.get("error")}).`);
  if (params.get("state") !== store.get("jm_state")) throw new Error("Sign-in check failed. Please try again.");
  await tokenRequest({
    grant_type: "authorization_code",
    code: params.get("code"),
    redirect_uri: REDIRECT_URI,
    code_verifier: store.get("jm_verifier"),
  });
  store.remove("jm_verifier");
  store.remove("jm_state");
}

// Many requests can find the token expired at once; they share one refresh, because
// Spotify may replace the refresh token and a second refresh with the old one would fail.
let refreshing = null;
async function accessToken() {
  let token = store.get("jm_token");
  if (!token) throw new Error("Not signed in.");
  if (Date.now() > token.expires) {
    if (!token.refresh) throw new Error("Not signed in.");
    refreshing = refreshing || tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh })
      .finally(() => { refreshing = null; });
    token = await refreshing;
  }
  return token.access;
}

function logout() {
  store.remove("jm_token");
  location.reload();
}

// Switches to another Spotify app (or forgets it when id is empty).
// A sign-in belongs to one app, so it signs you out too.
function setClientId(id) {
  if (id) store.set("jm_client_id", id);
  else store.remove("jm_client_id");
  store.remove("jm_token");
  location.reload();
}

// First-time setup lives on the sign-in screen: until a Client ID is saved the steps are
// open and Sign in is disabled; afterwards they fold away behind "Use a different app".
function renderOwnApp() {
  $("own-redirect").textContent = REDIRECT_URI;
  $("login-btn").disabled = !CLIENT_ID;
  const using = $("own-using");
  using.textContent = "";
  if (!CLIENT_ID) {
    $("own-app").open = true;
    return;
  }
  $("own-summary").textContent = "Use a different Spotify app";
  $("own-id").value = CLIENT_ID;
  using.append(`Using your Spotify app (…${CLIENT_ID.slice(-4)}).`);
}

function onOwnAppSave() {
  const id = $("own-id").value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    $("own-status").textContent = "That doesn't look like a Client ID. It's 32 letters and numbers, shown on your app's page in the Spotify dashboard.";
    return;
  }
  setClientId(id.toLowerCase());
}

// ---------------------------------------------------------------------
// Spotify Web API
// ---------------------------------------------------------------------
// Recent playback calls and player events, for the "Copy details" link.
const debugLog = [];
function debug(line) {
  debugLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (debugLog.length > 80) debugLog.shift();
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = "GET", body } = {}, retried = false) {
  const url = path.startsWith("http") ? path : "https://api.spotify.com/v1" + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + await accessToken(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    const token = store.get("jm_token") || {};
    token.expires = 0;
    store.set("jm_token", token);
    return api(path, { method, body }, true);
  }
  const logIt = url.includes("/me/player") && !(method === "GET" && url.endsWith("/me/player"));
  const short = url.replace("https://api.spotify.com/v1", "") + (body ? " " + JSON.stringify(body) : "");
  if (res.status === 429) {
    if (logIt) debug(`${method} ${short} -> 429`);
    throw new ApiError(429, "Spotify is rate-limiting requests right now. Wait a bit and try again.");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = (data.error && data.error.message) || `Spotify request failed (${res.status})`;
    if (logIt) debug(`${method} ${short} -> ${res.status} ${message}`);
    throw new ApiError(res.status, message);
  }
  if (logIt) debug(`${method} ${short} -> ${res.status}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function extractYearMonth(releaseDate) {
  const m = /^(\d{4})(-(\d{2}))?/.exec(releaseDate || "");
  if (!m) return [null, null];
  const year = Number(m[1]);
  if (year < 1900 || year > 2100) return [null, null];
  let month = m[3] ? Number(m[3]) : null;
  if (month !== null && (month < 1 || month > 12)) month = null;
  return [year, month];
}

function formatCardDate(card, includeMonths) {
  return includeMonths && card.month ? `${MONTH_NAMES[card.month - 1]} ${card.year}` : String(card.year);
}

function applyYearLimit(cards, mode) {
  const byYear = new Map();
  for (const c of cards) {
    if (!byYear.has(c.year)) byYear.set(c.year, []);
    byYear.get(c.year).push(c);
  }
  const result = [];
  for (const group of byYear.values()) {
    if (mode === "recent") group.sort((a, b) => (b.added_at || "").localeCompare(a.added_at || ""));
    else group.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    result.push(...group.slice(0, MAX_PER_YEAR));
  }
  return result;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Playlists this app may read: ones you own or collaborate on (Spotify's 2026 rule).
// Every playlist in your library. Spotify only shares the songs of the ones
// you made or collaborate on ("mine"); the others are listed so we can say how to copy them.
async function fetchPlaylists(me) {
  const list = [];
  let page = await api("/me/playlists?limit=50");
  for (let n = 0; page && n < 20; n++) {
    list.push(...(page.items || []).filter(Boolean));
    page = page.next ? await api(page.next) : null;
  }
  return list.map((p) => ({
    id: p.id,
    name: p.name || "Untitled playlist",
    total: ((p.items || p.tracks) || {}).total,
    mine: (!!p.owner && p.owner.id === me.id) || !!p.collaborative,
  }));
}

// The Default mode songs: a ready-made deck (default-deck.json) if this copy has one,
// otherwise the song list in default-songs.json, looked up on Spotify when first used.
let defaultDeck = null;
async function loadDefaultDeck() {
  for (const file of ["default-deck.json", "default-songs.json"]) {
    try {
      const res = await fetch(file, { cache: "no-cache" });
      const deck = res.ok ? await res.json() : null;
      if (deck && ((Array.isArray(deck.cards) && deck.cards.length) || (Array.isArray(deck.songs) && deck.songs.length))) {
        defaultDeck = deck;
        return;
      }
    } catch { /* try the next file */ }
  }
}

// Saves loaded songs as default-deck.json, for Default mode.
function exportDeck(cards, source) {
  const deck = {
    name: "Jukemonster default",
    source,
    saved: new Date().toISOString().slice(0, 10),
    cards: cards.map(({ title, artists, year, month, track_id, duration_ms, album_uri }) =>
      ({ title, artists, year, month, track_id, duration_ms, album_uri })),
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(deck)], { type: "application/json" }));
  a.download = "default-deck.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const SONG_CACHE = "jm_song_cache_v1";
const DEFAULT_READY = 60;
const VERSION_WORDS = /\b(live|karaoke|instrumental|sped up|slowed|acoustic|cover|remix|demo)\b/gi;
const songKey = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
const bareTitle = (s) => s.replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+.*$/, "").replace(/\s+(feat|ft)\.?\s.*$/i, "").trim() || s;

function trackCard(t) {
  const [year, month] = extractYearMonth((t.album || {}).release_date);
  if (year === null || !t.id || t.is_playable === false) return null;
  return {
    title: t.name || "Unknown Title",
    artists: (t.artists || []).map((a) => a.name).join(", ") || "Unknown Artist",
    year,
    month,
    track_id: t.id,
    duration_ms: t.duration_ms || 0,
    album_uri: (t.album || {}).uri || "",
  };
}

// The words that say which version a track is: what follows its title, plus its album's name
// unless the album is named after the song.
function versionWords(t, want) {
  const album = (t.album || {}).name || "";
  return `${t.name.slice(bareTitle(t.name).length)} ${songKey(album).includes(want) ? "" : album}`;
}

// Finds one song of the default list on Spotify. Prefers an exact title match and,
// among those, the earliest release, so remasters and best-ofs don't change the year.
async function findSong(artist, title) {
  const name = bareTitle(title);
  const want = songKey(name), who = songKey(artist);
  // A version word (live, remix...) is only OK when the list names that version too.
  const ownWords = new Set((title.slice(name.length).match(VERSION_WORDS) || []).map((w) => w.toLowerCase()));
  const wrongVersion = (t) => (versionWords(t, want).match(VERSION_WORDS) || []).some((w) => !ownWords.has(w.toLowerCase()));
  for (const q of [`track:${name} artist:${artist}`, `${name} ${artist}`]) {
    const res = await api(`/search?type=track&limit=10&market=from_token&q=${encodeURIComponent(q)}`);
    const hits = ((res && res.tracks && res.tracks.items) || []).filter((t) => t && t.id
      && songKey(t.name).includes(want)
      && (t.artists || []).some((a) => { const n = songKey(a.name); return n && (n.includes(who) || who.includes(n)); })
      && !wrongVersion(t));
    const exact = hits.filter((t) => songKey(bareTitle(t.name)) === want).map(trackCard).filter(Boolean);
    if (exact.length) return exact.reduce((best, c) => (c.year < best.year ? c : best));
    const close = hits.map(trackCard).filter(Boolean);
    if (close.length) return close[0];
  }
  return null;
}

// Looks up the default song list a few at a time, remembering results in this browser.
// The deck is usable once DEFAULT_READY songs are found; the rest keep coming in.
async function findDefaultSongs(load) {
  const cache = store.get(SONG_CACHE, {}) || {};
  const seen = new Set();
  const add = (card) => {
    if (!card || seen.has(card.track_id)) return;
    seen.add(card.track_id);
    load.cards.push({ ...card, popularity: 0, added_at: "" });
  };
  const todo = [];
  for (const [artist, title] of defaultDeck.songs) {
    const key = `${artist} - ${title}`;
    if (key in cache) { add(cache[key]); load.done++; } else todo.push([key, artist, title]);
  }
  shuffle(todo);
  const update = () => {
    const wasLoading = load.status === "loading";
    if (wasLoading && (load.cards.length >= DEFAULT_READY || !load.finding)) load.status = load.cards.length ? "ok" : "err";
    renderRowInfo();
    if (wasLoading && load.status !== "loading") renderOptions();
  };
  load.finding = todo.length > 0;
  update();
  let limited = 0;
  const worker = async () => {
    while (todo.length) {
      const job = todo.pop();
      try {
        const card = await findSong(job[1], job[2]);
        cache[job[0]] = card; // null = not on Spotify, so it isn't looked up again
        add(card);
      } catch (err) {
        if (err.status === 429 && ++limited <= 10) { todo.push(job); await sleep(5000); continue; }
      }
      load.done++;
      if (load.done % 25 === 0) { store.set(SONG_CACHE, cache); update(); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  store.set(SONG_CACHE, cache);
  load.finding = false;
  if (!load.cards.length) load.error = "Couldn't find the default songs on Spotify. Press Refresh list to try again.";
  update();
}

async function firstPlaylistPage(id) {
  // Spotify renamed /tracks to /items; try the new one first.
  const qs = "?limit=50&market=from_token";
  try {
    return await api(`/playlists/${encodeURIComponent(id)}/items${qs}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    return api(`/playlists/${encodeURIComponent(id)}/tracks${qs}`);
  }
}

async function fetchPlaylistCards(id) {
  const cards = [];
  const seen = new Set();
  let total = 0, noTrack = 0, noDate = 0, unplayable = 0;

  let page;
  try {
    page = await firstPlaylistPage(id);
  } catch (err) {
    if (err.status === 403) throw new Error("Spotify won't let this app read that playlist.");
    if (err.status === 404) throw new Error("Spotify couldn't find that playlist.");
    throw err;
  }

  while (page) {
    for (const entry of page.items || []) {
      total++;
      const t = entry.track || entry.item;
      if (!t || !t.id || t.type === "episode" || t.is_local) { noTrack++; continue; }
      if (t.is_playable === false) { unplayable++; continue; }
      const [year, month] = extractYearMonth((t.album || {}).release_date);
      if (year === null) { noDate++; continue; }
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      cards.push({
        title: t.name || "Unknown Title",
        artists: (t.artists || []).map((a) => a.name).join(", ") || "Unknown Artist",
        year,
        month,
        track_id: t.id,
        duration_ms: t.duration_ms || 0,
        album_uri: (t.album || {}).uri || "",
        popularity: t.popularity || 0,
        added_at: entry.added_at || "",
      });
    }
    page = page.next ? await api(page.next) : null;
  }

  if (!cards.length) {
    if (total === 0) throw new Error("That playlist is empty.");
    throw new Error(`None of its ${total} songs can be used (${unplayable} can't be played in your country, ${noTrack} aren't songs, ${noDate} have no date).`);
  }
  return cards;
}

// A start point 15-45 s in, kept short of the end so a 30 s play fits.
function randomStart(card) {
  const max = Math.max(0, Math.min(45000, (card.duration_ms || 180000) - 35000));
  const min = Math.min(15000, max);
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ---------------------------------------------------------------------
// Playback: this browser (Web Playback SDK) or any Spotify app you own
// ---------------------------------------------------------------------
// Thrown inside play() when pause() or a newer play() has taken over.
class Superseded extends Error {}

// Rate limits and sign-in problems stop everything; anything else is worth another try.
function softFail(err) {
  if (err instanceof Superseded || [401, 429].includes(err.status)) throw err;
  return null;
}

// What to do when this browser can't play Spotify's protected audio.
function browserHelp() {
  const firefox = /Firefox\//.test(navigator.userAgent);
  const name = firefox ? "Firefox" : "This browser";
  if (drmResult === "ok") {
    // DRM is switched on, so the browser itself is fine; Spotify's player just won't work in it here.
    return `${name} has protected content turned on, but Spotify's player still can't play in it on this computer. Open Jukemonster in ${firefox ? "Edge or Chrome" : "another browser (Chrome or Edge)"}, or open your Spotify app and pick it under Play on.`;
  }
  return firefox
    ? "Firefox isn't letting Spotify's protected music play. In Firefox Settings, tick \"Play DRM-controlled content\" and reload this page. Or open Jukemonster in Edge or Chrome, or pick your Spotify app under Play on."
    : "This browser isn't letting Spotify's protected music play. Turn on protected content (DRM) in its settings and reload, or pick your Spotify app under Play on.";
}

const playback = {
  player: null,
  browserDeviceId: null,
  chosenId: store.get("jm_device", ""), // a device id, "browser", or "" for automatic
  lastDevice: null,
  lastName: "",
  snippetTimer: null,
  endTimer: null,
  gen: 0,            // bumped by every play() and pause(), so an older start notices and stops
  activePlay: null,  // gen of the play() that should be making sound, null after pause()
  late: 0,           // how far past its start point the last song already was when confirmed
  errors: 0,         // playback_error events from this browser's player
  browserOk: false,  // this browser has played a song with no errors
  browserBad: "",    // why this browser can't play, if we know
  playStarted: 0,    // when the last play on this browser was confirmed

  async listDevices() {
    const data = await api("/me/player/devices");
    const devices = (data && data.devices) || [];
    if (this.browserDeviceId && !devices.some((d) => d.id === this.browserDeviceId)) {
      devices.unshift({ id: this.browserDeviceId, name: "Jukemonster", type: "Computer" });
    }
    return devices;
  },

  // The device the user picked, else this browser (if it can play), else whichever is active.
  pick(devices) {
    const chosen = this.chosenId === "browser" ? this.browserDeviceId : this.chosenId;
    return devices.find((d) => d.id === chosen)
      || (!this.browserBad && devices.find((d) => d.id === this.browserDeviceId))
      || devices.find((d) => d.is_active)
      || devices.find((d) => d.id !== this.browserDeviceId)
      || devices[0];
  },

  async device() {
    const devices = await this.listDevices();
    if (!devices.length) {
      throw new Error("No Spotify device found. Open Spotify on your phone or computer, then press ↻ in Setup.");
    }
    const d = this.pick(devices);
    if (d.is_restricted) throw new Error(`Spotify doesn't let apps control "${d.name}". Pick another device in Setup.`);
    return d;
  },

  inBrowser() {
    return !!this.player && this.lastDevice === this.browserDeviceId;
  },

  check(gen) {
    if (gen !== this.gen) throw new Superseded();
  },

  // Makes `id` the active device. Idle desktop/phone apps often ignore a play
  // command until playback has been moved to them.
  async transfer(id) {
    await api("/me/player", { method: "PUT", body: { device_ids: [id], play: false } });
  },

  // A sleeping Spotify app takes a couple of seconds to wake after a transfer.
  async waitActive(id, gen, timeout = 3000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      await sleep(500);
      this.check(gen);
      const data = await api("/me/player/devices").catch(softFail);
      if (data && (data.devices || []).some((d) => d.id === id && d.is_active)) return true;
    }
    debug(`device still idle after ${timeout} ms`);
    return false;
  },

  async nowPlaying() {
    return api("/me/player").catch(softFail);
  },

  // Spotify can answer "OK" while the device stays silent, so wait until it really
  // plays. Resolves how far past startMs the song already is, or null if it never started.
  async confirmStarted(id, card, startMs, gen, timeout, errorsBefore) {
    const start = performance.now();
    const local = id === this.browserDeviceId && !!this.player;
    let prev = null;
    let misses = 0;
    let firstOk = null;
    let lastAsked = 0;
    let lastWhy = "";
    while (performance.now() - start < timeout) {
      // Checking this browser is instant, so look often: short snippets start their timer from here.
      await sleep(local ? 25 : 500);
      this.check(gen);
      if (local) {
        // The browser player's state says "playing" even when it can't decode
        // the audio, so its error events are the only sign of silence.
        if (this.errors > errorsBefore) return null;
        const st = await this.player.getCurrentState().catch(() => null);
        const t = st && st.track_window && st.track_window.current_track;
        let late = null;
        if (st && !st.paused && !st.loading && sameTrack(t, card)) {
          late = Math.max(0, (st.position || 0) - startMs);
        } else {
          // Note what the player says (once per change), for "Copy details".
          const why = !st ? "no state yet" : `${st.paused ? "paused" : "playing"}${st.loading ? ", loading" : ""}, "${t ? t.name : "no song"}"`;
          if (why !== lastWhy) { debug(`browser player says: ${why}`); lastWhy = why; }
          // Its own state can lag (seen in Firefox), so ask Spotify every half second too.
          if (performance.now() - lastAsked > 500) {
            lastAsked = performance.now();
            const now = await this.nowPlaying();
            this.check(gen);
            if (playingOn(now, id, card)) late = Math.max(0, (now.progress_ms || 0) - startMs);
          }
        }
        if (late === null) continue;
        if (this.browserOk) return late;
        // First song in this browser: make sure no error follows before trusting it.
        if (firstOk === null) firstOk = performance.now();
        else if (performance.now() - firstOk > 1500) { this.browserOk = true; return late; }
        continue;
      }
      const now = await this.nowPlaying();
      this.check(gen);
      if (!playingOn(now, id, card)) {
        prev = null;
        // A refused command leaves the device stopped; no need to wait the full time.
        const idle = !now || !now.is_playing || !now.item || !sameTrack(now.item, card);
        misses = idle ? misses + 1 : 0;
        if (misses >= 2 && performance.now() - start > 2500) return null;
        continue;
      }
      misses = 0;
      // "Playing" can be reported before any sound, so wait for the position to move.
      const pos = now.progress_ms || 0;
      if ((prev !== null && pos > prev) || pos > startMs + 150) {
        this.lastVolume = now.device.volume_percent;
        return Math.max(0, pos - startMs);
      }
      prev = pos;
    }
    return null;
  },

  // Resolves true once the song is audibly playing, false if pause() or another
  // play() took over meanwhile. Tries a few ways of starting it, because some
  // Spotify apps ignore some of them. `note` gets progress messages for slow starts.
  async play(card, startMs, note = () => {}) {
    const gen = ++this.gen;
    this.activePlay = gen;
    clearTimeout(this.snippetTimer);
    clearTimeout(this.endTimer);
    this.late = 0;
    this.lastVolume = undefined;
    let d = null;
    let sent = false;
    try {
      if (this.player) {
        // Browsers only allow sound after a click; this unlocks it on mobile/Safari.
        try { await this.player.activateElement(); } catch { /* ignore */ }
      }
      d = await this.device();
      this.check(gen);
      const local = d.id === this.browserDeviceId;
      if (local && this.browserBad) throw new Error(this.browserBad);
      const at = `device_id=${encodeURIComponent(d.id)}`;
      const uri = `spotify:track:${card.track_id}`;
      if (card.duration_ms) startMs = Math.max(0, Math.min(startMs, card.duration_ms - 5000));
      // Since autumn 2026 some Spotify apps answer "OK" to a bare song and then
      // play nothing, but play the same song from its playlist or album fine.
      let attempts = [];
      if (card.playlist) {
        attempts.push({ name: "from playlist", body: { context_uri: `spotify:playlist:${card.playlist}`, offset: { uri }, position_ms: startMs }, context: true });
      }
      if (card.album_uri) {
        attempts.push({ name: "from album", body: { context_uri: card.album_uri, offset: { uri }, position_ms: startMs }, context: true });
      }
      attempts.push({ name: "song", body: { uris: [uri], position_ms: startMs } });
      // Remember what worked on each device (this browser's id changes every visit).
      const methods = store.get("jm_methods", {});
      const key = local ? "browser" : d.id;
      const known = attempts.find((a) => a.name === methods[key]);
      // Playing from the playlist has made sound on every Spotify app so far, so it stays
      // first; a start method remembered from Default mode songs only orders the rest.
      if (known && !card.playlist) attempts = [known, ...attempts.filter((a) => a !== known)];
      debug(`play "${card.title}" on ${d.name} (${local ? "this browser" : d.type}, ${d.is_active ? "active" : "idle"})`);

      const errorsBefore = this.errors;
      if (!d.is_active) {
        if (!local) note(`Waking up ${d.name}...`);
        await this.transfer(d.id).catch(softFail); // best effort; the play call reports real problems
        this.check(gen);
        if (local) await sleep(300);
        else await this.waitActive(d.id, gen);
      }

      let late = null;
      let used = null;
      let lastErr = null;
      for (const [i, a] of attempts.entries()) {
        if (local && this.errors > errorsBefore) break; // other ways fail the same way in this browser
        if (i > 0) {
          // A slow device may have started after all; don't restart a song that's already going.
          const now = await this.nowPlaying();
          this.check(gen);
          if (playingOn(now, d.id, card)) {
            late = Math.max(0, (now.progress_ms || 0) - startMs);
            used = attempts[i - 1];
            break;
          }
          note("Still starting, trying another way...");
        }
        this.lastDevice = d.id;
        this.lastName = local ? "this browser" : `"${d.name}"`;
        sent = true;
        try {
          await api(`/me/player/play?${at}`, { method: "PUT", body: a.body });
        } catch (err) {
          // A 403 can mean only this way of starting is blocked, so try the others first.
          if ([401, 429].includes(err.status)) throw err;
          lastErr = err;
          this.check(gen);
          continue;
        }
        this.check(gen);
        const wait = local ? 4000 : i === 0 && !d.is_active ? 6000 : 4000;
        late = await this.confirmStarted(d.id, card, startMs, gen, wait, errorsBefore);
        if (late !== null) { used = a; break; }
        debug(`"${a.name}" didn't start`);
      }

      if (late === null) {
        if (local && this.errors > errorsBefore) {
          debug(`gave up: ${this.errors - errorsBefore} playback errors in this browser`);
          this.browserOk = false;
          await this.stop(d.id);
          throw new Error(`No sound: this browser couldn't play "${card.title}". ${browserHelp()}`);
        }
        const now = await this.nowPlaying();
        const seen = !now ? "Spotify shows nothing playing anywhere."
          : `Spotify shows ${now.device ? `"${now.device.name}"` : "a device"} ${now.is_playing ? "playing" : "stopped"}${now.item ? ` with "${now.item.name}"` : " with no song loaded"}.`;
        debug(`gave up. ${seen}`);
        // Make sure a late start doesn't surprise anyone after we've said it failed.
        await this.stop(d.id);
        if (lastErr && [403, 404].includes(lastErr.status)) throw lastErr;
        throw new Error(local
          ? `This browser didn't start "${card.title}". ${seen} Click anywhere on the page and try again, or pick your Spotify app under Play on.`
          : `"${d.name}" didn't start "${card.title}". ${seen} Try again, or pick "This browser" under Play on.`);
      }
      debug(`playing (${used.name}), ${late} ms in${!local && typeof this.lastVolume === "number" ? `, volume ${this.lastVolume}%` : ""}`);
      if (methods[key] !== used.name) {
        methods[key] = used.name;
        store.set("jm_methods", methods);
      }
      if (used.context && card.duration_ms) {
        // A playlist or album would carry on to its next song (a spoiler), so stop before the end.
        const left = card.duration_ms - startMs - late - 3000;
        this.endTimer = setTimeout(() => { if (gen === this.gen) this.pause(); }, Math.max(0, left));
      }
      if (local) this.playStarted = performance.now();
      this.late = late;
      return true;
    } catch (err) {
      if (err instanceof Superseded || gen !== this.gen) {
        // Paused while starting: the play command may have landed after the pause, so pause again.
        if (sent && this.activePlay === null) await this.stop(d.id);
        return false;
      }
      if (err.status === 403) throw new Error(`Spotify refused to play (${err.message}). Playing songs needs Spotify Premium.`);
      if (err.status === 404) throw new Error(`Spotify can't reach "${d ? d.name : "your device"}" right now. Open Spotify there and press ↻ in Setup, or pick another device.`);
      throw err;
    }
  },

  // Plays exactly `ms` of a song. play() only returns once the music has started
  // and says how much has already played, so the timer allows for that.
  async snippet(card, startMs, ms, onStart, note) {
    if (!(await this.play(card, startMs, note))) return false;
    const gen = this.gen;
    if (onStart) onStart();
    this.snippetTimer = setTimeout(() => {
      if (gen === this.gen) this.pause();
    }, Math.max(0, ms - this.late));
    return true;
  },

  // Pauses one device without touching the play/pause bookkeeping.
  async stop(id) {
    if (this.player && id === this.browserDeviceId) {
      try { await this.player.pause(); return; } catch { /* fall back to the API */ }
    }
    try { await api(`/me/player/pause?device_id=${encodeURIComponent(id)}`, { method: "PUT" }); } catch { /* already paused */ }
  },

  async pause() {
    this.gen++;
    this.activePlay = null;
    clearTimeout(this.snippetTimer);
    clearTimeout(this.endTimer);
    // Nothing of ours has played yet, so leave whatever else is playing alone.
    if (this.lastDevice) await this.stop(this.lastDevice);
  },
};

// Spotify may swap in a regional copy of a song with a different id (and no
// longer says so for hobby apps), so the same title by the same artist counts too.
function sameTrack(t, card) {
  if (!t) return false;
  if (t.id === card.track_id || t.uri === `spotify:track:${card.track_id}`) return true;
  if (t.linked_from && t.linked_from.id === card.track_id) return true;
  if (!t.name || t.name !== card.title) return false;
  const artist = t.artists && t.artists[0] && t.artists[0].name;
  return !artist || card.artists.startsWith(artist);
}

function playingOn(now, id, card) {
  return !!now && now.is_playing && !!now.device && now.device.id === id && sameTrack(now.item, card);
}

// Asks the browser whether it can decrypt Spotify's protected audio at all.
// In Firefox this also brings up its "enable DRM" bar when DRM is off.
async function checkDrm() {
  if (!window.isSecureContext) return "page not secure";
  if (!navigator.requestMediaKeySystemAccess) return "no DRM support";
  try {
    const access = await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{
      initDataTypes: ["cenc"],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
    }]);
    await access.createMediaKeys();
    return "ok";
  } catch (err) {
    return err.name || "failed";
  }
}

// The SDK can finish loading before sign-in does, so start the player once both are done.
let sdkLoaded = false;
let signedIn = false;
let playerStarted = false;
let playerNote = "";
let drmResult = "not checked";

window.onSpotifyWebPlaybackSDKReady = () => {
  sdkLoaded = true;
  debug("browser player script loaded");
  startBrowserPlayer();
};

function startBrowserPlayer() {
  if (!sdkLoaded || !signedIn || playerStarted) return;
  playerStarted = true;
  const problem = (text) => {
    debug(`browser player problem: ${text}`);
    playerNote = text;
    playback.player = null;
    playback.browserDeviceId = null;
    setStatus($("setup-status"), text, "warn");
    refreshDevices();
  };
  checkDrm().then((result) => {
    drmResult = result;
    debug(`DRM check: ${result}`);
    if (result !== "ok") {
      playback.browserBad = `No sound in this browser. ${browserHelp()}`;
      refreshDevices();
    }
  });
  const player = new Spotify.Player({
    name: "Jukemonster",
    getOAuthToken: (cb) => accessToken().then(cb).catch(() => problem("This browser couldn't sign in to play music. Sign out and sign in again, or pick your Spotify app under Play on.")),
    volume: 0.8,
  });
  player.addListener("ready", ({ device_id }) => {
    debug("browser player ready");
    playerNote = "";
    playback.browserDeviceId = device_id;
    playback.player = player;
    refreshDevices();
  });
  player.addListener("not_ready", () => {
    debug("browser player went offline");
    playback.player = null;
    playback.browserDeviceId = null;
    refreshDevices();
  });
  player.addListener("account_error", () => problem("Playing in this browser needs Spotify Premium. You can still pick your Spotify app under Play on."));
  player.addListener("initialization_error", () => problem("This browser can't play Spotify music itself (it needs protected content turned on). Pick your Spotify app under Play on."));
  player.addListener("authentication_error", () => problem("This browser couldn't sign in to play music. Sign out and sign in again, or pick your Spotify app under Play on."));
  player.addListener("playback_error", ({ message }) => {
    playback.errors++;
    debug(`browser playback error: ${message}`);
    // An error just after a confirmed start means the browser went silent after all.
    if (playback.inBrowser() && playback.activePlay !== null && performance.now() - playback.playStarted < 5000) {
      playback.browserOk = false;
      setStatus($(game ? "play-status" : "setup-status"), `No sound: this browser couldn't play that song. ${browserHelp()}`, "err");
      if (!game) $("heard-btn").disabled = true;
    }
  });
  player.addListener("autoplay_failed", () => setStatus($(game ? "play-status" : "setup-status"), "The browser blocked sound. Click anywhere on the page, then press Replay.", "warn"));
  player.connect().then((ok) => {
    debug(`browser player connect: ${ok}`);
    if (!ok) problem("This browser couldn't start Spotify's player. Pick your Spotify app under Play on.");
  });
  setTimeout(() => {
    if (!playback.browserDeviceId && !playerNote) {
      playerNote = "still not ready after 12 s";
      debug("browser player still not ready after 12 s");
    }
  }, 12000);
}

async function copyDetails(e) {
  e.preventDefault();
  const lines = ["Jukemonster details (no passwords or keys)", `Browser: ${navigator.userAgent}`,
    `Browser player: ${playback.browserDeviceId ? "ready" : sdkLoaded ? `script loaded, not ready${playerNote ? ` (${playerNote})` : ""}` : "script not loaded"}`,
    `Chosen device: ${playback.chosenId || "(automatic)"}`,
    `Permissions: ${(store.get("jm_token") || {}).scope || "(not recorded)"}`,
    `Spotify app: …${CLIENT_ID.slice(-4)}`,
    `Secure page: ${window.isSecureContext} · DRM check: ${drmResult} · browser playback errors: ${playback.errors}${playback.browserOk ? " · browser has played OK" : ""}`,
    `Start method per device: ${JSON.stringify(store.get("jm_methods", {}))}`];
  try {
    const devices = await playback.listDevices();
    lines.push("Devices:", ...devices.map((d) => `  ${d.name} | ${d.type} | ${d.is_active ? "active" : "idle"}${typeof d.volume_percent === "number" ? ` | volume ${d.volume_percent}%` : ""}${d.is_restricted ? " | restricted" : ""}${d.id === playback.browserDeviceId ? " | this browser" : ""}${d.id === playback.chosenId || (playback.chosenId === "browser" && d.id === playback.browserDeviceId) ? " | chosen" : ""}`));
  } catch (err) {
    lines.push(`Devices: couldn't list (${err.message})`);
  }
  lines.push("Log:", ...debugLog.map((l) => "  " + l));
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    e.target.textContent = "Copied! Paste it in a message.";
  } catch {
    window.prompt("Copy these details:", text);
  }
}

// ---------------------------------------------------------------------
// Setup state
// ---------------------------------------------------------------------
const saved = store.get("jm_setup2", {});
const state = {
  solo: typeof saved.solo === "boolean" ? saved.solo : null,
  mode: MODES[saved.mode] ? saved.mode : null,
  numPlayers: saved.numPlayers || 2,
  names: saved.names || ["", "", "", "", "", ""],
  picks: saved.picks || ["", "", "", "", "", ""],
  mix: !!saved.mix,
  months: !!saved.months,
  reduce: !!saved.reduce,
  dedupe: saved.dedupe || "popularity",
  // Game lengths were doubled in October 2026, so double lengths saved before then too.
  lengths: saved.lengthsDoubled ? saved.lengths || {}
    : Object.fromEntries(Object.entries(saved.lengths || {}).map(([k, v]) => [k, v * 2])),

  me: null,
  playlists: null,       // allowed playlists, once fetched
  loads: new Map(),      // playlist id -> { status: "loading" | "ok" | "err", cards, error }
  heard: false,
};

function saveSetup() {
  const { solo, mode, numPlayers, names, picks, mix, months, reduce, dedupe, lengths } = state;
  store.set("jm_setup2", { solo, mode, numPlayers, names, picks, mix, months, reduce, dedupe, lengths, lengthsDoubled: true });
}

function activeCount() {
  return state.solo ? 1 : state.numPlayers;
}

function minPlayers() {
  return (state.mode && MODES[state.mode].minPlayers) || 2;
}

function playerName(i) {
  return (state.names[i] || "").trim() || (state.solo ? "You" : `Player ${i + 1}`);
}

function pickExists(id) {
  if (id === DEFAULT_ID) return !!defaultDeck;
  return !!id && !!state.playlists && state.playlists.some((p) => p.id === id);
}

function activeLoads() {
  return Array.from({ length: activeCount() }, (_, i) => state.loads.get(state.picks[i]));
}

function hasPopularity() {
  const loads = activeLoads().filter((l) => l && l.status === "ok");
  return !loads.length || loads.some((l) => l.cards.some((c) => c.popularity > 0));
}

function dedupeMode() {
  return hasPopularity() ? state.dedupe : "recent";
}

function lengthSetting() {
  if (state.mode === "guess" || state.mode === "album") {
    return state.solo ? { label: "Songs", values: [10, 20, 40], def: 20 } : { label: "Rounds", values: [6, 10, 20], def: 10 };
  }
  if (state.mode === "whose" || (state.mode === "oldernewer" && !state.solo)) {
    return { label: "Rounds", values: [6, 10, 20], def: 10 };
  }
  return null;
}

function lengthKey() {
  return `${state.mode}-${state.solo ? "solo" : "multi"}`;
}

function lengthValue() {
  const s = lengthSetting();
  if (!s) return null;
  const v = state.lengths[lengthKey()];
  return s.values.includes(v) ? v : s.def;
}

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.classList.remove("ok", "warn", "err");
  if (kind) el.classList.add(kind);
}

function showScreen(id) {
  const fade = $("fade");
  const current = document.querySelector(".screen:not(.hidden)");
  const swap = () => {
    document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
    $(id).classList.remove("hidden");
    window.scrollTo(0, 0);
  };
  if (!current) { swap(); return; }
  fade.classList.add("on");
  setTimeout(() => { swap(); fade.classList.remove("on"); }, 300);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, cls, onClick, disabled = false) {
  const b = el("button", "btn" + (cls ? " " + cls : ""), label);
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------
function renderSetup() {
  $("pick-solo").classList.toggle("selected", state.solo === true);
  $("pick-multi").classList.toggle("selected", state.solo === false);
  $("step-mode").classList.toggle("hidden", state.solo === null);
  const ready = state.solo !== null && state.mode !== null;
  $("step-players").classList.toggle("hidden", !ready);
  $("step-options").classList.toggle("hidden", !ready);
  renderModes();
  if (ready) {
    $("players-title").textContent = state.solo ? "Your name and playlist" : "Players and playlists";
    $("count-row").classList.toggle("hidden", state.solo);
    renderPlayerCount();
    renderPlayerRows();
    renderOptions();
  }
  updateStart();
}

function renderModes() {
  const wrap = $("mode-list");
  wrap.replaceChildren();
  for (const [key, m] of Object.entries(MODES)) {
    if (state.solo && !m.solo) continue;
    const card = el("button", "mode-card" + (state.mode === key ? " selected" : ""));
    card.style.setProperty("--c", m.color);
    card.append(el("b", "", m.name), el("span", "", state.solo && m.soloDesc ? m.soloDesc : m.desc));
    card.addEventListener("click", () => {
      state.mode = key;
      if (!state.solo && state.numPlayers < minPlayers()) state.numPlayers = minPlayers();
      saveSetup();
      renderSetup();
    });
    wrap.append(card);
  }
}

function setSolo(solo) {
  state.solo = solo;
  if (solo && state.mode && !MODES[state.mode].solo) state.mode = null;
  if (!solo && state.numPlayers < minPlayers()) state.numPlayers = minPlayers();
  saveSetup();
  renderSetup();
  loadActivePicks();
}

function renderPlayerCount() {
  const wrap = $("player-count");
  wrap.replaceChildren();
  for (let n = minPlayers(); n <= MAX_PLAYERS; n++) {
    wrap.append(button(String(n), n === state.numPlayers ? "selected" : "", () => {
      state.numPlayers = n;
      saveSetup();
      renderSetup();
      loadActivePicks();
    }));
  }
}

// Rows where the player chose "Pick a playlist..." themselves, so the default stays off.
const clearedPicks = new Set();

function renderPlayerRows() {
  const wrap = $("player-rows");
  wrap.replaceChildren();
  for (let i = 0; i < activeCount(); i++) {
    const row = el("div", "player-row");
    const stripe = el("div", "stripe");
    stripe.style.background = PLAYER_COLORS[i];
    const name = el("input", "name");
    name.placeholder = state.solo ? "Your name" : `Player ${i + 1}`;
    name.value = state.names[i] || "";
    name.maxLength = 24;
    name.setAttribute("aria-label", `Player ${i + 1} name`);
    name.addEventListener("input", () => { state.names[i] = name.value; saveSetup(); });

    const select = el("select");
    select.setAttribute("aria-label", `Player ${i + 1} playlist`);
    if (!state.playlists) {
      select.append(new Option("Loading your playlists...", ""));
      select.disabled = true;
    } else if (!state.playlists.length && !defaultDeck) {
      select.append(new Option("No playlists found. Make one in Spotify, then Refresh list", ""));
      select.disabled = true;
    } else {
      select.append(new Option("Pick a playlist...", ""));
      const group = (label, items) => {
        if (!items.length) return;
        const g = document.createElement("optgroup");
        g.label = label;
        for (const p of items) g.append(new Option(p.total != null ? `${p.name} (${p.total})` : p.name, p.id));
        select.append(g);
      };
      if (defaultDeck) group("Jukemonster", [{ id: DEFAULT_ID, name: `★ ${defaultDeck.name}`, total: (defaultDeck.cards || defaultDeck.songs).length }]);
      group("Your playlists", state.playlists.filter((p) => p.mine));
      group("Saved playlists (copy them to use them)", state.playlists.filter((p) => !p.mine));
      // New players start on the default songs, so you can go straight to Start.
      if (!state.picks[i] && defaultDeck && !clearedPicks.has(i)) {
        state.picks[i] = DEFAULT_ID;
        saveSetup();
      }
      select.value = pickExists(state.picks[i]) ? state.picks[i] : "";
    }
    select.addEventListener("change", () => {
      state.picks[i] = select.value;
      if (!select.value) clearedPicks.add(i);
      saveSetup();
      loadPick(state.picks[i]);
      renderRowInfo();
    });

    const info = el("div", "info");
    info.dataset.index = i;
    row.append(stripe, name, select, info);
    wrap.append(row);
  }
  if (state.picks.slice(0, activeCount()).includes(DEFAULT_ID)) loadPick(DEFAULT_ID);
  renderRowInfo();
}

function renderRowInfo() {
  document.querySelectorAll("#player-rows .info").forEach((info) => {
    const id = state.picks[Number(info.dataset.index)];
    const load = id && state.loads.get(id);
    info.className = "info";
    if (!pickExists(id)) info.textContent = "";
    else if (!load || load.status === "loading") {
      info.textContent = load && load.total
        ? `Finding the default songs on Spotify... ${load.cards.length} found (${load.done}/${load.total} checked)`
        : "Loading songs...";
    } else if (load.status === "ok") {
      info.textContent = `✓ ${load.cards.length} songs ready` + (load.finding ? ` (finding more: ${load.done}/${load.total})` : "");
      info.classList.add("ok");
      if (EXPORT_MODE && !load.finding && (id !== DEFAULT_ID || !defaultDeck.cards)) {
        const link = el("a", "", "Save as default deck");
        link.href = "#";
        link.addEventListener("click", (e) => {
          e.preventDefault();
          exportDeck(load.cards, id === DEFAULT_ID ? "default-songs.json" : `spotify:playlist:${id}`);
        });
        info.append(" · ", link);
      }
    } else {
      const meta = (state.playlists || []).find((p) => p.id === id);
      info.textContent = meta && !meta.mine ? COPY_HELP : load.error;
      info.classList.add("err");
    }
  });
  updateStart();
}

async function loadPick(id) {
  if (!id || state.loads.has(id)) return;
  if (id === DEFAULT_ID) {
    if (!defaultDeck) return;
    if (!defaultDeck.cards) {
      const load = { status: "loading", cards: [], done: 0, total: defaultDeck.songs.length, finding: true };
      state.loads.set(id, load);
      renderRowInfo();
      findDefaultSongs(load);
      return;
    }
    const cards = defaultDeck.cards.map((c) => ({ ...c, popularity: 0, added_at: "" }));
    state.loads.set(id, { status: "ok", cards });
    renderRowInfo();
    renderOptions();
    return;
  }
  state.loads.set(id, { status: "loading" });
  renderRowInfo();
  try {
    const cards = await fetchPlaylistCards(id);
    cards.forEach((c) => { c.playlist = id; });
    state.loads.set(id, { status: "ok", cards });
  } catch (err) {
    state.loads.set(id, { status: "err", error: err.message });
  }
  renderRowInfo();
  renderOptions();
}

function loadActivePicks() {
  if (!state.playlists) return;
  for (let i = 0; i < activeCount(); i++) {
    if (pickExists(state.picks[i])) loadPick(state.picks[i]);
  }
}

async function refreshPlaylists() {
  state.playlists = null;
  // Try failed playlists again (e.g. one you've just been made a collaborator on).
  for (const [id, load] of state.loads) if (load.status === "err") state.loads.delete(id);
  renderSetup();
  try {
    state.playlists = await fetchPlaylists(state.me);
  } catch (err) {
    state.playlists = [];
    setStatus($("setup-status"), "Couldn't load your playlists: " + err.message, "err");
  }
  renderSetup();
  loadActivePicks();
}

async function refreshDevices() {
  const select = $("device-select");
  try {
    const devices = await playback.listDevices();
    select.replaceChildren();
    if (!devices.length) {
      select.append(new Option("No devices: open Spotify somewhere, then press ↻", ""));
      return;
    }
    // This browser gets a new id every visit, so it's saved as "browser".
    const value = (d) => (d.id === playback.browserDeviceId ? "browser" : d.id);
    for (const d of devices) {
      const label = d.id !== playback.browserDeviceId ? `${d.name} (${d.type})`
        : playback.browserBad ? "This browser (can't play here)" : "This browser (Jukemonster)";
      select.append(new Option(label + (d.is_active ? " · active" : ""), value(d)));
    }
    select.value = value(playback.pick(devices));
  } catch {
    select.replaceChildren(new Option("Couldn't list devices", ""));
  }
}

function renderOptions() {
  const len = lengthSetting();
  $("length-row").classList.toggle("hidden", !len);
  if (len) {
    $("length-label").textContent = len.label;
    const seg = $("length-seg");
    seg.replaceChildren();
    const current = lengthValue();
    for (const v of len.values) {
      seg.append(button(String(v), v === current ? "selected" : "", () => {
        state.lengths[lengthKey()] = v;
        saveSetup();
        renderOptions();
      }));
    }
  }
  $("mix-row").classList.toggle("hidden", !!state.solo || state.mode === "whose");
  $("opt-mix").checked = state.mix;
  $("opt-months").checked = state.months;
  $("opt-reduce").checked = state.reduce;
  const pop = hasPopularity();
  $("mode-recent").disabled = !state.reduce;
  $("mode-popular").disabled = !state.reduce || !pop;
  $("mode-popular").title = pop ? "" : "Spotify doesn't share song popularity with this app";
  const dedupe = dedupeMode();
  $("mode-popular").classList.toggle("active", dedupe === "popularity");
  $("mode-recent").classList.toggle("active", dedupe === "recent");
}

function startProblem() {
  if (state.solo === null) return "Pick Solo or Multiplayer.";
  if (!state.mode) return "Pick a game.";
  const loads = activeLoads();
  if (loads.some((l) => !l)) return state.solo ? "Pick your playlist." : "Pick a playlist for every player.";
  if (loads.some((l) => l.status === "loading")) return "Loading songs...";
  if (loads.some((l) => l.status === "err")) return "One of the playlists can't be used. Pick another.";
  if (state.mode === "whose" && new Set(state.picks.slice(0, activeCount())).size < activeCount()) {
    return "Whose Playlist? needs every player to pick a different playlist.";
  }
  if (!state.heard) return "Press Test Audio and check you can hear music.";
  return "";
}

function updateStart() {
  const problem = startProblem();
  $("start-btn").disabled = !!problem;
  $("start-hint").textContent = problem;
  const anyLoaded = activeLoads().some((l) => l && l.status === "ok");
  $("test-btn").disabled = !anyLoaded;
}

async function onTestAudio() {
  const pool = activeLoads().filter((l) => l && l.status === "ok").flatMap((l) => l.cards);
  if (!pool.length) return;
  const status = $("setup-status");
  const note = (text) => setStatus(status, text);
  $("heard-btn").disabled = true;
  note("Starting a test song...");
  try {
    const sample = pool[Math.floor(Math.random() * pool.length)];
    if (!(await playback.play(sample, randomStart(sample), note))) return;
    $("heard-btn").disabled = false;
    setStatus(status, `"${sample.title}" is playing on ${playback.lastName}. Can you hear it? Press "Heard it!" if you do.`);
  } catch (err) {
    setStatus(status, err.message, "err");
  }
}

function onHeardIt() {
  playback.pause();
  state.heard = true;
  setStatus($("setup-status"), "Audio works! Press Start Game when you're ready.", "ok");
  updateStart();
}

// ---------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------
let game = null;

function newGame() {
  const n = activeCount();
  const lists = Array.from({ length: n }, (_, i) => state.loads.get(state.picks[i]).cards);

  // One shared object per song, remembering whose playlists it's on.
  const merged = new Map();
  lists.forEach((cards, i) => cards.forEach((c) => {
    let m = merged.get(c.track_id);
    if (!m) { m = { ...c, owners: [] }; merged.set(c.track_id, m); }
    if (!m.owners.includes(i)) m.owners.push(i);
  }));
  // Shuffle first so "Max 3 songs per year" doesn't always keep the same three.
  const prep = (cards) => shuffle(state.reduce ? applyYearLimit(shuffle(cards.slice()), dedupeMode()) : cards.slice());
  // Players on the same playlist share one pile, so nobody gets a song someone already had.
  const samePicks = new Set(state.picks.slice(0, n)).size < n;

  game = {
    mode: state.mode,
    solo: state.solo,
    months: state.months,
    rounds: lengthValue(),
    players: Array.from({ length: n }, (_, i) => ({
      name: playerName(i), color: PLAYER_COLORS[i], score: 0, turns: 0, timeline: [],
      lives: state.mode === "oldernewer" ? OLDER_NEWER_LIVES : SOLO_LIVES,
    })),
    useShared: state.solo || state.mix || state.mode === "whose" || samePicks,
    // Guess the Song: every song in the game, one per title and artist, for typed guesses.
    pool: [...new Map([...merged.values()].map((c) => [songKey(bareTitle(c.title)) + "|" + songKey(c.artists), c])).values()],
    typed: false,      // Guess the Song: the guess was typed in and judged already
    shared: prep([...merged.values()]),
    own: lists.map((cards) => prep(cards.map((c) => merged.get(c.track_id)))),
    active: 0,
    current: null,
    phase: "idle",     // idle -> playing -> revealed
    result: null,      // { ok, text }
    level: 0,          // Guess the Song: snippets unlocked
    slot: null,        // Timeline: chosen position
    placed: null,      // Timeline: card just added
    reference: null,   // Older or Newer: the previous song
    albums: null,      // Match the Album: { right, choices, picked }
    preparing: false,  // Match the Album: looking up the next song's albums
    barStart: null,
    barMs: FULL_PLAY_MS,
    over: null,        // reason the game ended
  };

  if (game.mode === "timeline") {
    for (let i = 0; i < n; i++) {
      game.active = i;
      const first = drawCard();
      if (first) game.players[i].timeline.push(first);
    }
    game.active = 0;
  }
  if (game.mode === "oldernewer") game.reference = drawCard();

  setStatus($("play-status"), "");
  clearGuess();
  $("mode-name").textContent = MODES[game.mode].name;
  renderGame(0);
  showScreen("screen-play");
}

function deckFor(i) {
  return game.useShared ? game.shared : game.own[i];
}

function drawCard() {
  const deck = deckFor(game.active);
  let card = null;
  if (game.mode === "whose") {
    // Never ask someone about a song from their own playlist.
    for (let i = deck.length - 1; i >= 0; i--) {
      if (!deck[i].owners.includes(game.active)) { card = deck.splice(i, 1)[0]; break; }
    }
  } else {
    card = deck.pop() || null;
  }
  if (card && card.start == null) card.start = randomStart(card);
  return card;
}

// Draws the turn's song if there isn't one yet. Returns false when nothing is left.
function ensureCard() {
  if (game.current) return true;
  const card = drawCard();
  if (!card) {
    const who = game.players[game.active].name;
    if (game.mode === "classic") {
      setStatus($("play-status"), game.useShared
        ? "That's every song!"
        : `${who} is out of songs. Pick another player.`, "err");
    } else {
      endGame(game.useShared ? "Out of songs!" : `${who} ran out of songs.`);
    }
    return false;
  }
  game.current = card;
  game.phase = "playing";
  game.result = null;
  game.slot = null;
  game.level = 0;
  return true;
}

async function playFull() {
  const card = game.current;
  const note = (text) => setStatus($("play-status"), text);
  note("Starting the music...");
  try {
    if (!(await playback.play(card, card.start, note))) return;
    game.barStart = performance.now() - playback.late;
    game.barMs = FULL_PLAY_MS;
    note("");
  } catch (err) {
    setStatus($("play-status"), err.message, "err");
  }
}

function onPlayCard() {
  if (!ensureCard()) return;
  renderGame();
  playFull();
}

function onSnippet(levelIndex) {
  if (!ensureCard()) return;
  renderGame();
  const card = game.current;
  const ms = LEVELS[levelIndex].ms;
  game.barStart = null;
  const note = (text) => setStatus($("play-status"), text);
  note("Starting the music...");
  playback.snippet(card, card.start, ms, () => {
    // Only unlock the next snippet once this one is actually heard.
    if (game.current === card) {
      game.level = Math.max(game.level, levelIndex + 1);
      renderGame();
    }
    game.barStart = performance.now() - playback.late;
    game.barMs = ms;
    note("");
  }, note).catch((err) => setStatus($("play-status"), err.message, "err"));
}

// ---------------------------------------------------------------------
// Match the Album
// ---------------------------------------------------------------------
// Titles made only of symbols ("÷", "+") keep their symbols instead of becoming empty.
const albumKey = (name) => {
  const bare = bareTitle(name || "");
  return songKey(bare) || bare.trim().toLowerCase();
};
// Editions count as the same album: "DAMN." and "DAMN. COLLECTORS EDITION.", "Kid A" and "KID A MNESIA".
// (Treating two different albums as one only means one fewer wrong choice.)
const sameAlbum = (a, b) => a === b || (!!a && !!b && (a.startsWith(b) || b.startsWith(a)));
const isAlbum = (a) => !!a && (a.album_type || "").toLowerCase() === "album";
// True when the album is the artist's own (not a soundtrack or various-artists album).
const byArtist = (a, artistId) => !a.artists || a.artists.some((x) => x.id === artistId);
const artistAlbumCache = new Map();

function albumChoice(a) {
  const images = a.images || [];
  const image = (images.find((i) => i.width && i.width <= 320) || images[images.length - 1] || images[0] || {}).url || "";
  return { id: a.id, name: a.name || "Untitled album", image };
}

// An artist's own albums (no singles, compilations or albums they only appear on),
// one per title, so "After Hours" and "After Hours (Deluxe)" count once.
async function artistAlbums(artistId) {
  if (artistAlbumCache.has(artistId)) return artistAlbumCache.get(artistId);
  const base = `/artists/${encodeURIComponent(artistId)}/albums?include_groups=album&market=from_token`;
  let items = [];
  try {
    const page = await api(`${base}&limit=50`);
    items = (page && page.items) || [];
  } catch (err) {
    if (err.status !== 400) throw err;
    // Development-mode apps may get a smaller page size.
    for (let offset = 0; offset < 50; offset += 10) {
      const page = await api(`${base}&limit=10&offset=${offset}`);
      items.push(...((page && page.items) || []));
      if (!page || !page.next) break;
    }
  }
  const seen = [];
  const albums = [];
  for (const a of items) {
    if (!a || !a.id || (a.album_type && !isAlbum(a))) continue;
    const key = albumKey(a.name);
    if (!key || seen.some((k) => sameAlbum(k, key))) continue;
    seen.push(key);
    albums.push(albumChoice(a));
  }
  artistAlbumCache.set(artistId, albums);
  return albums;
}

// The album a song is on. When the song's own release is a single or a best-of,
// looks for the same song on one of the artist's albums; null if it has none.
async function songAlbum(t, artist) {
  if (isAlbum(t.album) && byArtist(t.album, artist.id)) return t.album;
  const name = bareTitle(t.name || "");
  const want = songKey(name);
  if (!want) return null; // a title with no Latin letters or digits can't be matched safely
  const res = await api(`/search?type=track&limit=10&market=from_token&q=${encodeURIComponent(`track:${name} artist:${artist.name}`)}`);
  const hits = ((res && res.tracks && res.tracks.items) || []).filter((h) => h
    && isAlbum(h.album) && byArtist(h.album, artist.id)
    && (h.artists || []).some((a) => a.id === artist.id)
    && songKey(bareTitle(h.name || "")) === want
    && !(versionWords(h, want).match(VERSION_WORDS) || []).length);
  hits.sort((a, b) => (a.album.release_date || "").localeCompare(b.album.release_date || ""));
  return hits.length ? hits[0].album : null;
}

// Builds a round for one song: its album plus 4 other albums by the same artist.
// Returns null when the song isn't on an album or the artist has too few albums.
async function buildAlbumRound(card) {
  const t = await api(`/tracks/${encodeURIComponent(card.track_id)}?market=from_token`);
  const artist = t && (t.artists || [])[0];
  if (!artist || !artist.id) return null;
  const album = await songAlbum(t, artist);
  if (!album) return null;
  const key = albumKey(album.name);
  const others = shuffle((await artistAlbums(artist.id)).filter((a) => !sameAlbum(albumKey(a.name), key)));
  // Live albums only fill in when there aren't enough studio ones.
  const isLive = (a) => /\blive\b/i.test(a.name);
  const pick = [...others.filter((a) => !isLive(a)), ...others.filter(isLive)].slice(0, ALBUM_CHOICES - 1);
  if (pick.length < ALBUM_CHOICES - 1) return null;
  const right = albumChoice(album);
  return { right: right.id, rightName: right.name, choices: shuffle([right, ...pick]), picked: null };
}

// Draws songs until one has 5 albums to pick from, then plays it.
async function onAlbumPlay() {
  const g = game;
  if (g.current || g.preparing) return;
  g.preparing = true;
  renderGame();
  const note = (text, kind) => setStatus($("play-status"), text, kind);
  note("Picking the albums...");
  let round = null;
  let card = null;
  try {
    for (let tries = 0; tries < 15 && !round; tries++) {
      card = drawCard();
      if (!card) break;
      try {
        round = await buildAlbumRound(card);
      } catch (err) {
        // Spotify not knowing the song (400/404) skips it. Anything else (offline, rate limit,
        // server trouble) puts it back and stops, so a hiccup doesn't throw songs away.
        if (![400, 404].includes(err.status)) { deckFor(g.active).push(card); throw err; }
        round = null;
      }
      // Stop if the game was left (Setup) or replaced while looking up.
      if (game !== g || g.over || $("screen-play").classList.contains("hidden")) { g.preparing = false; return; }
    }
  } catch (err) {
    g.preparing = false;
    if (game !== g || $("screen-play").classList.contains("hidden")) return;
    note(err.message, "err");
    renderGame();
    return;
  }
  g.preparing = false;
  if (!round) {
    if (!card) {
      endGame(g.useShared ? "Out of songs!" : `${g.players[g.active].name} ran out of songs.`);
    } else {
      note("Couldn't find 5 albums for the last few songs' artists. Press Play Card to try more, or pick another playlist.", "err");
      renderGame();
    }
    return;
  }
  g.current = card;
  g.albums = round;
  g.phase = "playing";
  g.result = null;
  note("");
  renderGame();
  playFull();
}

function onAlbumPick(id) {
  const a = game.albums;
  if (!a || game.phase !== "playing") return;
  a.picked = id;
  const ok = id === a.right;
  if (ok) game.players[game.active].score++;
  reveal({ ok, text: ok ? "✓ Right album!" : "✗ Wrong album" });
}

// A song that never started can be swapped for another without using up the turn.
function onSkipSong() {
  playback.pause();
  game.current = null;
  game.phase = "idle";
  game.level = 0;
  game.barStart = null;
  setStatus($("play-status"), "Skipped. Try the next song.");
  renderGame();
}

// Guess the Song: songs in the game whose title or artist matches what's typed.
function guessMatches(text) {
  const q = songKey(text);
  if (!q) return [];
  const starts = [], inside = [];
  for (const c of game.pool) {
    const t = songKey(c.title);
    if (t.startsWith(q)) starts.push(c);
    else if (t.includes(q) || songKey(c.artists).includes(q)) inside.push(c);
    if (starts.length >= 8) break;
  }
  return [...starts, ...inside].slice(0, 8);
}

function renderGuessList() {
  const list = $("guess-list");
  list.replaceChildren();
  for (const c of guessMatches($("guess-input").value)) {
    const b = el("button");
    b.type = "button";
    b.append(el("b", "", c.title), " ", el("span", "a", "· " + c.artists));
    b.addEventListener("click", () => onTypedGuess(c));
    const li = el("li");
    li.append(b);
    list.append(li);
  }
}

function clearGuess() {
  $("guess-input").value = "";
  $("guess-list").replaceChildren();
}

function onTypedGuess(pick) {
  if (!game.current || game.phase !== "playing" || !game.level) return;
  const c = game.current;
  const ok = pick.track_id === c.track_id
    || (songKey(bareTitle(pick.title)) === songKey(bareTitle(c.title)) && songKey(pick.artists) === songKey(c.artists));
  const p = game.players[game.active];
  const points = ok ? LEVELS[game.level - 1].points : 0;
  p.score += points;
  game.typed = true;
  clearGuess();
  reveal({ ok, text: ok ? "✓ Right song!" : `✗ Not "${pick.title}"` });
  setStatus($("play-status"), ok ? `${p.name} +${points} ${points === 1 ? "point" : "points"}` : `No points for ${p.name}`, ok ? "ok" : "");
}

function reveal(result = null) {
  if (!game.current) return;
  game.phase = "revealed";
  game.result = result;
  game.barStart = null;
  playback.pause();
  setStatus($("play-status"), "");
  renderGame();
}

function onTimelineReveal() {
  const p = game.players[game.active];
  const tl = p.timeline;
  const y = game.current.year;
  const i = game.slot;
  const ok = (i === 0 || tl[i - 1].year <= y) && (i === tl.length || y <= tl[i].year);
  if (ok) {
    tl.splice(i, 0, game.current);
    game.placed = game.current;
  } else {
    game.placed = null;
    if (game.solo) p.lives--;
  }
  reveal(ok ? { ok, text: "✓ Right spot!" } : { ok, text: "✗ Wrong spot" });
}

function onWhoseGuess(guess) {
  const card = game.current;
  const ok = card.owners.includes(guess);
  if (ok) game.players[game.active].score++;
  reveal({ ok, text: ok ? "✓ Correct!" : "✗ Nope" });
}

function onOlderNewer(older) {
  const y = game.current.year;
  const ref = game.reference.year;
  const ok = older ? y <= ref : y >= ref;
  if (ok) game.players[game.active].score++;
  else if (game.solo) game.players[0].lives--;
  reveal({ ok, text: ok ? "✓ Correct!" : "✗ Wrong" });
}

function onGuessJudged(correct) {
  const p = game.players[game.active];
  const points = correct ? LEVELS[game.level - 1].points : 0;
  p.score += points;
  setStatus($("play-status"), correct ? `${p.name} +${points} ${points === 1 ? "point" : "points"}` : `No points for ${p.name}`, correct ? "ok" : "");
  finishTurn();
}

function finishTurn() {
  const p = game.players[game.active];
  p.turns++;
  if (game.mode === "oldernewer" && game.current) game.reference = game.current;
  game.current = null;
  game.phase = "idle";
  game.result = null;
  game.slot = null;
  game.level = 0;
  game.albums = null;
  game.barStart = null;
  game.typed = false;
  clearGuess();

  const reason = overReason();
  if (reason) { endGame(reason); return; }
  game.active = (game.active + 1) % game.players.length;
  renderGame(game.active);
  if (game.mode !== "guess") setStatus($("play-status"), "");
}

function overReason() {
  const ps = game.players;
  switch (game.mode) {
    case "timeline": {
      if (game.solo) return ps[0].lives <= 0 ? "Six wrong placements." : null;
      const winner = ps.find((p) => p.timeline.length >= TIMELINE_GOAL);
      return winner ? `${winner.name} reached ${TIMELINE_GOAL} cards!` : null;
    }
    case "oldernewer":
      if (game.solo) return ps[0].lives <= 0 ? "Out of lives." : null;
      return ps.every((p) => p.turns >= game.rounds) ? "All rounds played." : null;
    case "guess":
    case "album":
    case "whose":
      return ps.every((p) => p.turns >= game.rounds) ? "All rounds played." : null;
    default:
      return null;
  }
}

// True when finishing the current turn will end the game.
function endsAfterThisTurn() {
  const p = game.players[game.active];
  p.turns++;
  const ends = !!overReason();
  p.turns--;
  return ends;
}

function scoreOf(p) {
  return game.mode === "timeline" ? p.timeline.length : p.score;
}

function scoreLabel(p) {
  switch (game.mode) {
    case "guess":
    case "album":
    case "whose": return `${p.score} ${p.score === 1 ? "pt" : "pts"}`;
    case "timeline":
      return game.solo
        ? `${p.timeline.length} ${p.timeline.length === 1 ? "card" : "cards"} · ${"♥".repeat(Math.max(0, p.lives))}${"♡".repeat(SOLO_LIVES - Math.max(0, p.lives))}`
        : `${p.timeline.length} / ${TIMELINE_GOAL}`;
    case "oldernewer":
      return game.solo
        ? `${p.score} right · ${"♥".repeat(Math.max(0, p.lives))}${"♡".repeat(OLDER_NEWER_LIVES - Math.max(0, p.lives))}`
        : `${p.score} pts`;
    default: return "";
  }
}

function endGame(reason) {
  playback.pause();
  game.over = reason;
  // The play screen stays up during the fade; a second click there would end the game again.
  $("controls").replaceChildren();
  const ranked = game.players.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
  let sub;
  if (game.solo) {
    const p = game.players[0];
    // Timeline and Older or Newer got more lives in October 2026, so their bests start fresh.
    const fresh = game.mode === "timeline" || game.mode === "oldernewer" ? "_long" : "";
    const key = `jm_best_${game.mode}${game.rounds ? "_" + game.rounds : ""}${fresh}`;
    const best = store.get(key, 0);
    const score = scoreOf(p);
    if (score > best) store.set(key, score);
    const what = game.mode === "timeline" ? `${score} ${score === 1 ? "card" : "cards"} in your timeline`
      : game.mode === "oldernewer" ? `${score} right` : `${score} ${score === 1 ? "point" : "points"}`;
    sub = `${reason} You got ${what}. ${score > best ? "New best!" : `Your best is ${best}.`}`;
  } else {
    const top = scoreOf(ranked[0]);
    const winners = ranked.filter((p) => scoreOf(p) === top).map((p) => p.name);
    sub = `${reason} ${winners.length > 1 ? `It's a tie between ${winners.join(" and ")}!` : `${winners[0]} wins!`}`;
  }
  $("end-sub").textContent = sub;
  const list = $("end-list");
  list.replaceChildren();
  ranked.forEach((p, i) => {
    const li = el("li");
    li.style.setProperty("--c", p.color);
    li.append(el("span", "pos", String(i + 1)), el("span", "who", p.name), el("span", "", scoreLabel(p)));
    list.append(li);
  });
  showScreen("screen-end");
}

// ---------------------------------------------------------------------
// Play screen rendering
// ---------------------------------------------------------------------
function renderGame(popIndex = -1) {
  const g = game;
  const p = g.players[g.active];

  // Top bar
  const left = deckFor(g.active).length;
  let deckText = g.useShared ? `${left} songs left` : `${p.name}: ${left} songs left`;
  if (g.rounds) {
    const round = Math.min(g.rounds, Math.min(...g.players.map((x) => x.turns)) + 1);
    deckText = (g.solo ? `Song ${round} of ${g.rounds}` : `Round ${round} of ${g.rounds}`) + " · " + deckText;
  }
  $("deck-label").textContent = deckText;

  renderScoreboard(popIndex);

  // Turn line
  const line = $("turn-line");
  line.replaceChildren();
  const prompts = {
    classic: g.phase === "playing" ? ", place your card!" : "'s turn",
    guess: ", name that song!",
    album: ", which album is this song from?",
    timeline: g.phase === "playing" ? ", tap where this song goes" : "'s turn",
    whose: ", whose playlist is this on?",
    oldernewer: ", older or newer than the last song?",
  };
  const soloPrompts = {
    guess: "Name that song!",
    album: "Which album is this song from?",
    timeline: g.phase === "playing" ? "Tap where this song goes" : "Your turn",
    oldernewer: "Older or newer than the last song?",
  };
  if (g.solo) line.textContent = soloPrompts[g.mode];
  else line.append(el("b", "", p.name), document.createTextNode(prompts[g.mode]));

  // Older or Newer reference
  const showRef = g.mode === "oldernewer" && g.reference;
  $("ref-card").classList.toggle("hidden", !showRef);
  if (showRef) {
    $("ref-date").textContent = formatCardDate(g.reference, g.months);
    $("ref-title").textContent = `${g.reference.title} · ${g.reference.artists}`;
  }

  // Card
  const has = !!g.current;
  $("card-empty").classList.toggle("hidden", has);
  $("card-mystery").classList.toggle("hidden", !has);
  $("card-empty").textContent = g.mode === "guess" ? "Start with the 0.5 sec snippet" : "Press \"Play Card\" to spin one up";
  $("card-hint").textContent = {
    classic: "Place your card, then hit Reveal",
    guess: "Type your guess below, or say it out loud and Reveal",
    album: "Pick the album below",
    timeline: "Tap a + in your timeline",
    whose: "Pick a player below",
    oldernewer: "Older or newer?",
  }[g.mode];
  $("tape-label").textContent = g.mode === "guess" ? "Name that tune" : "Mystery mix";
  $("card").classList.toggle("flipped", has && g.phase === "revealed");
  if (has) {
    $("card-date").textContent = formatCardDate(g.current, g.months);
    $("card-title").textContent = g.current.title;
    $("card-artist").textContent = g.current.artists;
    const res = $("card-result");
    res.textContent = g.result ? g.result.text : "";
    res.className = "result" + (g.result ? (g.result.ok ? " ok" : " err") : "");
    const extra = $("card-extra");
    extra.replaceChildren();
    if (g.mode === "whose") {
      extra.append("On ", el("b", "", g.current.owners.map((o) => g.players[o].name).join(" and ")), "'s playlist");
    }
    if (g.mode === "album" && g.albums) {
      extra.append("From ", el("b", "", g.albums.rightName));
    }
    if (g.mode === "oldernewer" && g.reference) {
      extra.append("Last song was ", el("b", "", formatCardDate(g.reference, g.months)));
    }
  }

  renderControls();
  renderTimelines();
}

function renderScoreboard(popIndex) {
  const g = game;
  const wrap = $("scoreboard");
  wrap.replaceChildren();
  g.players.forEach((p, i) => {
    const classic = g.mode === "classic";
    const s = el(classic ? "button" : "div", "score" + (i === g.active ? " active" : "") + (i === popIndex ? " pop" : ""));
    s.style.setProperty("--c", p.color);
    s.append(el("b", "", p.name));
    const label = scoreLabel(p);
    if (label) s.append(el("span", "", label));
    if (classic) s.addEventListener("click", () => { g.active = i; renderGame(i); });
    wrap.append(s);
  });
}

function renderControls() {
  const g = game;
  const c = $("controls");
  c.replaceChildren();
  const hint = $("play-hint");
  hint.textContent = "";
  const guessing = g.mode === "guess" && !!g.current && g.phase === "playing";
  $("guess-box").classList.toggle("hidden", !guessing);
  $("guess-input").disabled = !g.level;
  $("guess-input").placeholder = g.level ? "Type the song name..." : "Play a snippet, then type your guess";
  const has = !!g.current;
  const playing = g.phase === "playing";
  const revealed = g.phase === "revealed";
  const nextLabel = g.mode === "classic" ? "Next Card" : revealed && endsAfterThisTurn() ? "See results" : "Next turn";
  const playBtn = () => button(has ? "Replay" : "Play Card", has ? "" : "primary", has ? playFull : onPlayCard);

  switch (g.mode) {
    case "classic":
      if (revealed) c.append(button(nextLabel, "primary", finishTurn));
      else c.append(playBtn(), button("Reveal", "teal", () => reveal(), !has));
      break;

    case "guess":
      if (revealed && g.typed) {
        c.append(button(nextLabel, "primary", finishTurn));
      } else if (revealed) {
        const pts = LEVELS[g.level - 1].points;
        c.append(
          button(`Got it! +${pts}`, "teal", () => onGuessJudged(true)),
          button("Wrong", "danger", () => onGuessJudged(false)),
        );
        hint.textContent = "Was the guess right?";
      } else {
        LEVELS.forEach((lv, i) => {
          const b = button(lv.label, "snip" + (i < g.level ? " selected" : ""), () => onSnippet(i), i > g.level);
          b.append(el("small", "", `${lv.points} pt${lv.points > 1 ? "s" : ""}`));
          c.append(b);
        });
        c.append(el("div", "break"), button("Reveal", "teal", () => reveal(), g.level === 0));
        if (has && g.level === 0) c.append(button("Skip song", "", onSkipSong));
        hint.textContent = g.level
          ? `Worth ${LEVELS[g.level - 1].points} ${g.level === 4 ? "point" : "points"} right now. Type your guess below, or say it out loud and press Reveal.`
          : "Each longer snippet unlocks after the one before.";
      }
      break;

    case "timeline":
      if (revealed) c.append(button(nextLabel, "primary", finishTurn));
      else {
        c.append(playBtn(), button("Reveal", "teal", onTimelineReveal, !(playing && g.slot !== null)));
        if (playing && g.slot === null) hint.textContent = "Tap a + in your timeline to place the song.";
      }
      break;

    case "whose":
      if (revealed) c.append(button(nextLabel, "primary", finishTurn));
      else if (!has) c.append(playBtn());
      else {
        c.append(playBtn(), el("div", "break"));
        g.players.forEach((p, i) => {
          if (i === g.active) return;
          const b = button(p.name, "guess", () => onWhoseGuess(i));
          b.style.setProperty("--c", p.color);
          c.append(b);
        });
      }
      break;

    case "album":
      if (!has) {
        c.append(button(g.preparing ? "Picking albums..." : "Play Card", "primary", onAlbumPlay, g.preparing));
        break;
      }
      if (revealed) c.append(button(nextLabel, "primary", finishTurn));
      else c.append(playBtn());
      c.append(albumGrid());
      break;

    case "oldernewer":
      if (revealed) c.append(button(nextLabel, "primary", finishTurn));
      else if (!has) c.append(playBtn());
      else c.append(playBtn(), el("div", "break"), button("◀ Older", "teal", () => onOlderNewer(true)), button("Newer ▶", "primary", () => onOlderNewer(false)));
      break;
  }
}

// The 5 album choices. After a pick, the right one is marked (and a wrong pick too).
function albumGrid() {
  const a = game.albums;
  const grid = el("div", "album-grid");
  if (!a) return grid;
  const done = game.phase === "revealed";
  for (const choice of a.choices) {
    const b = el("button", "album-choice"
      + (done && choice.id === a.right ? " right" : "")
      + (done && choice.id === a.picked && choice.id !== a.right ? " wrong" : ""));
    b.disabled = done;
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    if (choice.image) img.src = choice.image;
    b.append(img, el("span", "", choice.name));
    b.addEventListener("click", () => onAlbumPick(choice.id));
    grid.append(b);
  }
  return grid;
}

function renderTimelines() {
  const g = game;
  const wrap = $("timelines");
  const show = g.mode === "timeline";
  wrap.classList.toggle("hidden", !show);
  $("play-grid").classList.toggle("with-timelines", show);
  if (!show) return;
  wrap.replaceChildren();
  // Active player first on small screens is handled by order; keep seating order here.
  g.players.forEach((p, i) => {
    const active = i === g.active;
    const row = el("div", "tl" + (active ? " active" : ""));
    row.style.setProperty("--c", p.color);
    const head = el("div", "tl-head");
    head.append(el("b", "", p.name), el("span", "", scoreLabel(p)));
    const cards = el("div", "tl-cards");
    const canPlace = active && g.phase === "playing";
    const slot = (pos) => {
      const b = el("button", "slot" + (g.slot === pos ? " sel" : ""), g.slot === pos ? "?" : "+");
      b.setAttribute("aria-label", `Place the song at position ${pos + 1}`);
      b.addEventListener("click", () => { g.slot = pos; renderGame(); });
      return b;
    };
    p.timeline.forEach((card, j) => {
      if (canPlace) cards.append(slot(j));
      const chip = el("div", "chip" + (card === g.placed && g.phase === "revealed" ? " new" : ""));
      chip.style.setProperty("--c", p.color);
      chip.append(el("b", "", formatCardDate(card, false)), el("span", "t", card.title), el("span", "a", card.artists));
      cards.append(chip);
    });
    if (canPlace) cards.append(slot(p.timeline.length));
    row.append(head, cards);
    wrap.append(row);
  });
}

function tickBar() {
  const fill = $("bar-fill");
  if (game && game.barStart !== null && game.phase === "playing") {
    const frac = Math.min(1, (performance.now() - game.barStart) / game.barMs);
    fill.style.width = (frac * 100) + "%";
  } else {
    fill.style.width = "0";
  }
  requestAnimationFrame(tickBar);
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
function wire() {
  $("login-btn").addEventListener("click", () => startLogin());
  $("own-save").addEventListener("click", onOwnAppSave);
  $("own-id").addEventListener("keydown", (e) => { if (e.key === "Enter") onOwnAppSave(); });
  renderOwnApp();
  $("logout-link").addEventListener("click", (e) => { e.preventDefault(); logout(); });

  $("pick-solo").addEventListener("click", () => setSolo(true));
  $("pick-multi").addEventListener("click", () => setSolo(false));
  $("reload-playlists").addEventListener("click", (e) => { e.preventDefault(); refreshPlaylists(); });
  $("test-btn").addEventListener("click", onTestAudio);
  $("heard-btn").addEventListener("click", onHeardIt);
  $("refresh-devices").addEventListener("click", refreshDevices);
  document.querySelectorAll(".copy-debug").forEach((a) => a.addEventListener("click", copyDetails));
  $("device-select").addEventListener("change", (e) => {
    playback.chosenId = e.target.value;
    store.set("jm_device", playback.chosenId);
    playback.pause();
    state.heard = false;
    $("heard-btn").disabled = true;
    setStatus($("setup-status"), "Press Test Audio to check this device.");
    updateStart();
  });

  $("opt-mix").addEventListener("change", (e) => { state.mix = e.target.checked; saveSetup(); });
  $("opt-months").addEventListener("change", (e) => { state.months = e.target.checked; saveSetup(); });
  $("opt-reduce").addEventListener("change", (e) => { state.reduce = e.target.checked; saveSetup(); renderOptions(); });
  $("mode-popular").addEventListener("click", () => { state.dedupe = "popularity"; saveSetup(); renderOptions(); });
  $("mode-recent").addEventListener("click", () => { state.dedupe = "recent"; saveSetup(); renderOptions(); });
  $("start-btn").addEventListener("click", () => { if (!startProblem()) newGame(); });

  $("guess-input").addEventListener("input", renderGuessList);
  $("guess-input").addEventListener("keydown", (e) => {
    const first = $("guess-list").querySelector("button");
    if (e.key === "Enter" && first) first.click();
  });

  $("back-btn").addEventListener("click", () => { playback.pause(); renderSetup(); showScreen("screen-setup"); });
  $("again-btn").addEventListener("click", newGame);
  $("change-btn").addEventListener("click", () => { renderSetup(); showScreen("screen-setup"); });
}

async function main() {
  wire();
  requestAnimationFrame(tickBar);

  try {
    await handleRedirect();
  } catch (err) {
    setStatus($("login-status"), err.message, "err");
  }

  // A sign-in from before Jukemonster asked for your own Spotify app can't be refreshed.
  if (!CLIENT_ID) store.remove("jm_token");
  if (!store.get("jm_token")) {
    showScreen("screen-login");
    return;
  }
  try {
    state.me = await api("/me");
    $("user-name").textContent = state.me.display_name || state.me.id;
    await loadDefaultDeck();
  } catch (err) {
    store.remove("jm_token");
    showScreen("screen-login");
    // Spotify answers 403 when the account isn't on the app's User Management list (development mode).
    setStatus($("login-status"), err.status === 403
      ? "Spotify hasn't let this account use your Spotify app. In the Spotify dashboard, check that Web API and Web Playback SDK are ticked, and add any other account under User Management."
      : "Please sign in again. " + err.message, "err");
    return;
  }
  renderSetup();
  showScreen("screen-setup");
  const granted = ((store.get("jm_token") || {}).scope || "").split(" ");
  if (granted[0] && SCOPES.split(" ").some((s) => !granted.includes(s))) {
    setStatus($("setup-status"), "Jukemonster needs more Spotify permissions to play music. Please sign out and sign in again.", "warn");
  }
  signedIn = true;
  startBrowserPlayer();
  refreshDevices();
  refreshPlaylists();
}

main();
