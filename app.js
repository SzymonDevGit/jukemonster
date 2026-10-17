/*
 * Jukemonster: a one-screen companion for Hitster-style games with your own
 * physical timeline cards. Each player brings their own Spotify playlist; the
 * app builds a deck, plays a mystery song each round, and flips over the
 * answer when you're ready. You place the card and judge right/wrong yourselves.
 *
 * Runs fully in the browser. Spotify sign-in uses the PKCE flow, so no client
 * secret is needed (or allowed) here.
 */
"use strict";

// The Client ID is public by design. Never put the client secret in this file.
const CLIENT_ID = "a8509be20756492ca029547063dd8295";
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

const MAX_PLAYERS = 4;
const MAX_PER_YEAR = 3;
const SNIPPET_SECONDS = 30;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const PLAYER_COLORS = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)"];

const $ = (id) => document.getElementById(id);

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

async function accessToken() {
  let token = store.get("jm_token");
  if (!token) throw new Error("Not signed in.");
  if (Date.now() > token.expires) {
    if (!token.refresh) throw new Error("Not signed in.");
    token = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh });
  }
  return token.access;
}

function logout() {
  store.remove("jm_token");
  location.reload();
}

// ---------------------------------------------------------------------
// Spotify Web API
// ---------------------------------------------------------------------
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
  if (res.status === 429) throw new ApiError(429, "Spotify is rate-limiting requests right now. Wait a bit and try again.");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data.error && data.error.message) || `Spotify request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function parsePlaylistId(urlOrId) {
  const s = urlOrId.trim();
  if (s.includes("playlist/")) return s.split("playlist/").pop().split(/[?#/]/)[0];
  if (s.startsWith("spotify:playlist:")) return s.split(":").pop();
  return s;
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

async function fetchPlaylistCards(urlOrId) {
  const id = parsePlaylistId(urlOrId);
  const cards = [];
  const seen = new Set();
  let total = 0, noTrack = 0, noDate = 0;

  let page;
  try {
    page = await firstPlaylistPage(id);
  } catch (err) {
    if (err.status === 403) {
      throw new Error("Spotify only lets this app read playlists you own or collaborate on. Ask the owner to invite you as a collaborator, or copy the songs into a playlist of your own.");
    }
    if (err.status === 404) throw new Error("Spotify couldn't find that playlist. Check the whole link was copied (open.spotify.com/playlist/...).");
    throw err;
  }

  while (page) {
    for (const entry of page.items || []) {
      total++;
      const t = entry.track || entry.item;
      if (!t || !t.id || t.type === "episode") { noTrack++; continue; }
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
        popularity: t.popularity || 0,
        added_at: entry.added_at || "",
      });
    }
    page = page.next ? await api(page.next) : null;
  }

  if (!cards.length) {
    if (total > 0 && noTrack === total) {
      throw new Error(`Spotify returned no song data for any of the ${total} items. Spotify's own playlists can't be read; use one a person made.`);
    }
    throw new Error(`Found ${total} items, but none had a usable release date (${noTrack} had no song data, ${noDate} had no date).`);
  }
  return cards;
}

// ---------------------------------------------------------------------
// Playback: this browser (Web Playback SDK) or any Spotify app you own
// ---------------------------------------------------------------------
const playback = {
  player: null,
  browserDeviceId: null,
  chosenId: store.get("jm_device", ""),

  async listDevices() {
    const data = await api("/me/player/devices");
    const devices = (data && data.devices) || [];
    if (this.browserDeviceId && !devices.some((d) => d.id === this.browserDeviceId)) {
      devices.unshift({ id: this.browserDeviceId, name: "Jukemonster", type: "Computer" });
    }
    return devices;
  },

  async deviceId() {
    const devices = await this.listDevices();
    if (!devices.length) {
      throw new Error("No Spotify device found. Open Spotify on your phone or computer, play any song, then press ↻.");
    }
    return this.pick(devices).id;
  },

  // The device the user picked, else this browser, else whichever is active.
  pick(devices) {
    return devices.find((d) => d.id === this.chosenId)
      || devices.find((d) => d.id === this.browserDeviceId)
      || devices.find((d) => d.is_active)
      || devices[0];
  },

  async play(trackId) {
    if (this.player) {
      // Browsers only allow sound after a click; this unlocks it on mobile/Safari.
      try { await this.player.activateElement(); } catch { /* ignore */ }
    }
    const id = await this.deviceId();
    const start = 15000 + Math.floor(Math.random() * 30000);
    try {
      await api(`/me/player/play?device_id=${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { uris: [`spotify:track:${trackId}`], position_ms: start },
      });
    } catch (err) {
      if (err.status === 403) throw new Error("Spotify refused to play. Playing songs needs Spotify Premium.");
      if (err.status === 404) throw new Error("That Spotify device went to sleep. Open Spotify there and press ↻, or pick another device.");
      throw err;
    }
  },

  async pause() {
    try { await api("/me/player/pause", { method: "PUT" }); } catch { /* already paused */ }
  },
};

// The SDK can finish loading before sign-in does, so start the player once both are done.
let sdkLoaded = false;
let signedIn = false;
let playerStarted = false;

window.onSpotifyWebPlaybackSDKReady = () => {
  sdkLoaded = true;
  startBrowserPlayer();
};

function startBrowserPlayer() {
  if (!sdkLoaded || !signedIn || playerStarted) return;
  playerStarted = true;
  const player = new Spotify.Player({
    name: "Jukemonster",
    getOAuthToken: (cb) => accessToken().then(cb).catch(() => {}),
    volume: 0.8,
  });
  player.addListener("ready", ({ device_id }) => {
    playback.browserDeviceId = device_id;
    playback.player = player;
    refreshDevices();
  });
  player.addListener("not_ready", () => { playback.browserDeviceId = null; });
  player.addListener("account_error", () => {
    playback.player = null;
    setStatus($("setup-status"), "Playing in this browser needs Spotify Premium. You can still pick another device.", "warn");
  });
  player.connect();
}

// ---------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------
const saved = store.get("jm_setup", {});
const state = {
  numPlayers: saved.numPlayers || 2,
  names: saved.names || ["", "", "", ""],
  links: saved.links || ["", "", "", ""],
  mix: !!saved.mix,
  months: !!saved.months,
  reduce: !!saved.reduce,
  dedupe: saved.dedupe || "popularity",

  cards: [],
  playerCards: {},
  hasPopularity: true,
  deck: [],
  playerDecks: {},
  players: [],
  active: 0,
  current: null,
  revealed: false,
  snippetStart: null,
  busy: false,
};

function saveSetup() {
  store.set("jm_setup", {
    numPlayers: state.numPlayers, names: state.names, links: state.links,
    mix: state.mix, months: state.months, reduce: state.reduce, dedupe: state.dedupe,
  });
}

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "") + (el.classList.contains("center") ? " center" : "");
}

async function runBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  try { await fn(); } finally { state.busy = false; }
}

function showScreen(id) {
  const fade = $("fade");
  const current = document.querySelector(".screen:not(.hidden)");
  if (!current) {
    $(id).classList.remove("hidden");
    return;
  }
  fade.classList.add("on");
  setTimeout(() => {
    document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
    $(id).classList.remove("hidden");
    window.scrollTo(0, 0);
    fade.classList.remove("on");
  }, 350);
}

// ---------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------
function renderPlayerCount() {
  const wrap = $("player-count");
  wrap.replaceChildren();
  for (let n = 1; n <= MAX_PLAYERS; n++) {
    const b = document.createElement("button");
    b.className = "btn" + (n === state.numPlayers ? " filled" : "");
    b.textContent = n;
    b.addEventListener("click", () => {
      state.numPlayers = n;
      saveSetup();
      renderPlayerCount();
      renderPlayerRows();
    });
    wrap.append(b);
  }
}

function renderPlayerRows() {
  const wrap = $("player-rows");
  wrap.replaceChildren();
  for (let i = 0; i < state.numPlayers; i++) {
    const row = document.createElement("div");
    row.className = "player-row";
    const stripe = document.createElement("div");
    stripe.className = "stripe";
    stripe.style.background = PLAYER_COLORS[i];
    const name = document.createElement("input");
    name.className = "name";
    name.placeholder = `Player ${i + 1}`;
    name.value = state.names[i];
    name.maxLength = 30;
    name.addEventListener("input", () => { state.names[i] = name.value; saveSetup(); });
    const link = document.createElement("input");
    link.className = "link";
    link.placeholder = "Their Spotify playlist link...";
    link.value = state.links[i];
    link.addEventListener("input", () => { state.links[i] = link.value; saveSetup(); });
    row.append(stripe, name, link);
    wrap.append(row);
  }
}

function playerName(i) {
  return state.names[i].trim() || `Player ${i + 1}`;
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
    for (const d of devices) {
      const label = d.id === playback.browserDeviceId ? "This browser (Jukemonster)" : `${d.name} (${d.type})`;
      select.append(new Option(label + (d.is_active ? " · active" : ""), d.id));
    }
    select.value = playback.pick(devices).id;
  } catch (err) {
    select.replaceChildren(new Option("Couldn't list devices", ""));
  }
}

function onLoadPlaylists() {
  const status = $("setup-status");
  const entries = [];
  for (let i = 0; i < state.numPlayers; i++) {
    if (state.links[i].trim()) entries.push([i, playerName(i), state.links[i].trim()]);
  }
  if (!entries.length) {
    setStatus(status, "Paste at least one playlist link.", "err");
    return;
  }
  runBusy(async () => {
    $("load-btn").disabled = true;
    const merged = new Map();
    const perPlayer = {};
    const errors = [];
    for (const [i, name, link] of entries) {
      setStatus(status, `Loading ${name}'s playlist...`);
      try {
        const cards = await fetchPlaylistCards(link);
        perPlayer[i] = cards;
        for (const c of cards) if (!merged.has(c.track_id)) merged.set(c.track_id, c);
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }
    $("load-btn").disabled = false;
    if (merged.size < 3) {
      setStatus(status, "Not enough usable songs across those playlists." + (errors.length ? " " + errors.join(" | ") : ""), "err");
      return;
    }
    state.cards = [...merged.values()];
    state.playerCards = perPlayer;
    // Spotify stopped sharing popularity with hobby apps in 2026.
    state.hasPopularity = state.cards.some((c) => c.popularity > 0);
    syncOptions();
    $("test-btn").disabled = false;
    const msg = `Loaded ${state.cards.length} unique songs from ${entries.length} playlist(s).`;
    if (errors.length) setStatus(status, msg + " Some issues: " + errors.join(" | "), "warn");
    else setStatus(status, msg, "ok");
  });
}

function onTestAudio() {
  if (!state.cards.length) return;
  const status = $("setup-status");
  runBusy(async () => {
    setStatus(status, "Playing a test song... listen for it.");
    try {
      const sample = state.cards[Math.floor(Math.random() * state.cards.length)];
      await playback.play(sample.track_id);
      $("heard-btn").disabled = false;
      setStatus(status, "Did you hear music? Press \"Heard it!\" once confirmed.");
    } catch (err) {
      setStatus(status, err.message, "err");
    }
  });
}

function onHeardIt() {
  playback.pause();
  $("start-btn").disabled = false;
  $("start-hint").classList.add("hidden");
  setStatus($("setup-status"), "Audio confirmed! Set your options and start the game.", "ok");
}

function syncOptions() {
  $("opt-mix").checked = state.mix;
  $("opt-months").checked = state.months;
  $("opt-reduce").checked = state.reduce;
  $("mode-recent").disabled = !state.reduce;
  $("mode-popular").disabled = !state.reduce || !state.hasPopularity;
  $("mode-popular").title = state.hasPopularity ? "" : "Spotify doesn't share song popularity with this app";
  const dedupe = state.hasPopularity ? state.dedupe : "recent";
  $("mode-popular").classList.toggle("active", dedupe === "popularity");
  $("mode-recent").classList.toggle("active", dedupe === "recent");
}

function dedupeMode() {
  return state.hasPopularity ? state.dedupe : "recent";
}

function onStartGame() {
  state.players = Array.from({ length: state.numPlayers }, (_, i) => playerName(i));
  state.active = 0;
  if (state.mix) {
    let pool = state.cards.slice();
    if (state.reduce) pool = applyYearLimit(pool, dedupeMode());
    state.deck = shuffle(pool);
    state.playerDecks = {};
  } else {
    state.deck = [];
    state.playerDecks = {};
    for (let i = 0; i < state.numPlayers; i++) {
      let pool = (state.playerCards[i] || []).slice();
      if (state.reduce) pool = applyYearLimit(pool, dedupeMode());
      state.playerDecks[i] = shuffle(pool);
    }
  }
  state.current = null;
  state.revealed = false;
  state.snippetStart = null;
  setStatus($("play-status"), "");
  renderPlay();
  showScreen("screen-play");
}

// ---------------------------------------------------------------------
// Play screen
// ---------------------------------------------------------------------
function activeDeck() {
  if (state.mix) return state.deck;
  if (!state.playerDecks[state.active]) state.playerDecks[state.active] = [];
  return state.playerDecks[state.active];
}

function renderTurns(popIndex = -1) {
  const wrap = $("turn-buttons");
  wrap.replaceChildren();
  state.players.forEach((name, i) => {
    const b = document.createElement("button");
    b.className = "turn" + (i === state.active ? " active" : "") + (i === popIndex ? " pop" : "");
    b.style.setProperty("--c", PLAYER_COLORS[i]);
    b.textContent = name;
    b.addEventListener("click", () => { state.active = i; renderPlay(i); });
    wrap.append(b);
  });
}

function renderPlay(popIndex = -1) {
  renderTurns(popIndex);
  $("deck-label").textContent = state.mix
    ? `Cards left: ${state.deck.length}`
    : `${state.players[state.active]}'s cards left: ${(state.playerDecks[state.active] || []).length}`;

  const has = state.current !== null;
  $("card-empty").classList.toggle("hidden", has);
  $("card-mystery").classList.toggle("hidden", !has);
  $("card").classList.toggle("flipped", has && state.revealed);
  if (has) {
    $("card-date").textContent = formatCardDate(state.current, state.months);
    $("card-title").textContent = state.current.title;
    $("card-artist").textContent = state.current.artists;
  }

  const showNext = has && state.revealed;
  $("play-btn").classList.toggle("hidden", showNext);
  $("reveal-btn").classList.toggle("hidden", showNext);
  $("next-btn").classList.toggle("hidden", !showNext);
  $("play-btn").textContent = has ? "Replay Snippet" : "Play Card";
  $("reveal-btn").disabled = !has;
}

function playCurrent() {
  const card = state.current;
  runBusy(async () => {
    state.snippetStart = performance.now();
    try {
      await playback.play(card.track_id);
      setStatus($("play-status"), "");
    } catch (err) {
      setStatus($("play-status"), err.message, "err");
    }
  });
}

function onPlayCard() {
  if (state.current !== null && !state.revealed) {
    playCurrent();
    return;
  }
  const deck = activeDeck();
  if (!deck.length) {
    setStatus($("play-status"), state.mix
      ? "Deck is empty. That's every song!"
      : `${state.players[state.active]} is out of songs. Pick another player or add more to their playlist.`, "err");
    return;
  }
  state.current = deck.pop();
  state.revealed = false;
  renderPlay();
  playCurrent();
}

function onReveal() {
  if (state.current === null) return;
  state.revealed = true;
  state.snippetStart = null;
  playback.pause();
  renderPlay();
}

function onNextCard() {
  state.current = null;
  state.revealed = false;
  state.snippetStart = null;
  if (state.players.length) state.active = (state.active + 1) % state.players.length;
  renderPlay(state.active);
}

function tickBar() {
  const fill = $("bar-fill");
  if (state.snippetStart !== null && !state.revealed) {
    const frac = Math.min(1, (performance.now() - state.snippetStart) / (SNIPPET_SECONDS * 1000));
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
  $("logout-link").addEventListener("click", (e) => { e.preventDefault(); logout(); });

  $("load-btn").addEventListener("click", onLoadPlaylists);
  $("test-btn").addEventListener("click", onTestAudio);
  $("heard-btn").addEventListener("click", onHeardIt);
  $("refresh-devices").addEventListener("click", refreshDevices);
  $("device-select").addEventListener("change", (e) => {
    playback.chosenId = e.target.value;
    store.set("jm_device", playback.chosenId);
  });

  $("opt-mix").addEventListener("change", (e) => { state.mix = e.target.checked; saveSetup(); });
  $("opt-months").addEventListener("change", (e) => { state.months = e.target.checked; saveSetup(); });
  $("opt-reduce").addEventListener("change", (e) => { state.reduce = e.target.checked; saveSetup(); syncOptions(); });
  $("mode-popular").addEventListener("click", () => { state.dedupe = "popularity"; saveSetup(); syncOptions(); });
  $("mode-recent").addEventListener("click", () => { state.dedupe = "recent"; saveSetup(); syncOptions(); });
  $("start-btn").addEventListener("click", onStartGame);

  $("play-btn").addEventListener("click", onPlayCard);
  $("reveal-btn").addEventListener("click", onReveal);
  $("next-btn").addEventListener("click", onNextCard);
  $("back-btn").addEventListener("click", () => { playback.pause(); showScreen("screen-setup"); });
}

async function main() {
  wire();
  renderPlayerCount();
  renderPlayerRows();
  syncOptions();
  requestAnimationFrame(tickBar);

  try {
    await handleRedirect();
  } catch (err) {
    setStatus($("login-status"), err.message, "err");
  }

  if (!store.get("jm_token")) {
    showScreen("screen-login");
    return;
  }
  try {
    const me = await api("/me");
    $("user-name").textContent = me.display_name || me.id;
  } catch (err) {
    store.remove("jm_token");
    showScreen("screen-login");
    setStatus($("login-status"), "Please sign in again. " + err.message, "err");
    return;
  }
  showScreen("screen-setup");
  signedIn = true;
  startBrowserPlayer();
  refreshDevices();
}

main();
