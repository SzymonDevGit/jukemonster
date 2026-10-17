/*
 * Jukemonster: a one-screen music party game. Each player brings a Spotify
 * playlist and Jukemonster is the jukebox, with five games:
 *   Classic         - the app plays songs, you use your own physical cards
 *   Guess the Song  - name it from a 0.5 / 1 / 5 / 30 second snippet
 *   Timeline        - place songs in your on-screen timeline
 *   Whose Playlist? - guess which player's playlist a song is from
 *   Older or Newer  - is this song older or newer than the last one?
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

const MAX_PLAYERS = 6;
const MAX_PER_YEAR = 3;
const FULL_PLAY_MS = 30000;
const TIMELINE_GOAL = 10;
const SOLO_LIVES = 3;
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
  timeline: {
    name: "Timeline", color: "var(--p2)", solo: true,
    desc: "Place each song in your own timeline. First to 10 cards wins.",
    soloDesc: "Build your timeline. Three wrong placements and it's over.",
  },
  whose: {
    name: "Whose Playlist?", color: "var(--p3)", solo: false, minPlayers: 3,
    desc: "Guess which player's playlist the song came from. 3 or more players.",
  },
  oldernewer: {
    name: "Older or Newer", color: "var(--p5)", solo: true,
    desc: "Is this song older or newer than the last one?",
    soloDesc: "Keep your streak going: is each song older or newer than the last?",
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
async function fetchAllowedPlaylists(me) {
  const list = [];
  let page = await api("/me/playlists?limit=50");
  for (let n = 0; page && n < 20; n++) {
    list.push(...(page.items || []).filter(Boolean));
    page = page.next ? await api(page.next) : null;
  }
  return list
    .filter((p) => (p.owner && p.owner.id === me.id) || p.collaborative)
    .map((p) => ({ id: p.id, name: p.name || "Untitled playlist", total: ((p.items || p.tracks) || {}).total }));
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
  let total = 0, noTrack = 0, noDate = 0;

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
        duration_ms: t.duration_ms || 0,
        popularity: t.popularity || 0,
        added_at: entry.added_at || "",
      });
    }
    page = page.next ? await api(page.next) : null;
  }

  if (!cards.length) {
    if (total === 0) throw new Error("That playlist is empty.");
    throw new Error(`None of its ${total} songs had a usable release date (${noTrack} had no song data, ${noDate} had no date).`);
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
const playback = {
  player: null,
  browserDeviceId: null,
  chosenId: store.get("jm_device", ""),
  lastDevice: null,
  snippetTimer: null,
  snippetToken: 0,

  async listDevices() {
    const data = await api("/me/player/devices");
    const devices = (data && data.devices) || [];
    if (this.browserDeviceId && !devices.some((d) => d.id === this.browserDeviceId)) {
      devices.unshift({ id: this.browserDeviceId, name: "Jukemonster", type: "Computer" });
    }
    return devices;
  },

  // The device the user picked, else this browser, else whichever is active.
  pick(devices) {
    return devices.find((d) => d.id === this.chosenId)
      || devices.find((d) => d.id === this.browserDeviceId)
      || devices.find((d) => d.is_active)
      || devices[0];
  },

  async deviceId() {
    const devices = await this.listDevices();
    if (!devices.length) {
      throw new Error("No Spotify device found. Open Spotify on your phone or computer, play any song, then press ↻ in Setup.");
    }
    return this.pick(devices).id;
  },

  inBrowser() {
    return !!this.player && this.lastDevice === this.browserDeviceId;
  },

  async play(trackId, startMs) {
    this.cancelSnippet();
    if (this.player) {
      // Browsers only allow sound after a click; this unlocks it on mobile/Safari.
      try { await this.player.activateElement(); } catch { /* ignore */ }
    }
    const id = await this.deviceId();
    try {
      await api(`/me/player/play?device_id=${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { uris: [`spotify:track:${trackId}`], position_ms: startMs },
      });
    } catch (err) {
      if (err.status === 403) throw new Error("Spotify refused to play. Playing songs needs Spotify Premium.");
      if (err.status === 404) throw new Error("That Spotify device went to sleep. Open Spotify there and press ↻ in Setup, or pick another device.");
      throw err;
    }
    this.lastDevice = id;
  },

  // Plays exactly `ms` of a song. Timing is tight in this browser; other
  // devices take a moment to start, so short snippets are only approximate there.
  async snippet(trackId, startMs, ms, onStart) {
    const token = ++this.snippetToken;
    await this.play(trackId, startMs);
    this.snippetToken = token; // play() cancels; claim the slot back
    if (this.inBrowser()) await this.waitUntilPlaying(trackId, 4000);
    else await sleep(600);
    if (token !== this.snippetToken) return;
    if (onStart) onStart();
    this.snippetTimer = setTimeout(() => {
      if (token === this.snippetToken) this.pause();
    }, ms);
  },

  async waitUntilPlaying(trackId, timeout) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const s = await this.player.getCurrentState().catch(() => null);
      if (s && !s.paused && !s.loading) {
        const t = s.track_window && s.track_window.current_track;
        if (!t || t.id === trackId || t.uri === `spotify:track:${trackId}` || (t.linked_from && t.linked_from.id === trackId)) return;
      }
      await sleep(30);
    }
  },

  cancelSnippet() {
    this.snippetToken++;
    clearTimeout(this.snippetTimer);
  },

  async pause() {
    this.cancelSnippet();
    if (this.inBrowser()) {
      try { await this.player.pause(); return; } catch { /* fall back to the API */ }
    }
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
  lengths: saved.lengths || {},

  me: null,
  playlists: null,       // allowed playlists, once fetched
  loads: new Map(),      // playlist id -> { status: "loading" | "ok" | "err", cards, error }
  heard: false,
  busy: false,
};

function saveSetup() {
  const { solo, mode, numPlayers, names, picks, mix, months, reduce, dedupe, lengths } = state;
  store.set("jm_setup2", { solo, mode, numPlayers, names, picks, mix, months, reduce, dedupe, lengths });
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
  if (state.mode === "guess") {
    return state.solo ? { label: "Songs", values: [5, 10, 20], def: 10 } : { label: "Rounds", values: [3, 5, 10], def: 5 };
  }
  if (state.mode === "whose" || (state.mode === "oldernewer" && !state.solo)) {
    return { label: "Rounds", values: [3, 5, 10], def: 5 };
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

async function runBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  try { await fn(); } finally { state.busy = false; }
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
    } else if (!state.playlists.length) {
      select.append(new Option("No playlists found. Make one in Spotify, then Refresh list", ""));
      select.disabled = true;
    } else {
      select.append(new Option("Pick a playlist...", ""));
      for (const p of state.playlists) {
        select.append(new Option(p.total != null ? `${p.name} (${p.total})` : p.name, p.id));
      }
      select.value = state.playlists.some((p) => p.id === state.picks[i]) ? state.picks[i] : "";
    }
    select.addEventListener("change", () => {
      state.picks[i] = select.value;
      saveSetup();
      loadPick(state.picks[i]);
      renderRowInfo();
    });

    const info = el("div", "info");
    info.dataset.index = i;
    row.append(stripe, name, select, info);
    wrap.append(row);
  }
  renderRowInfo();
}

function renderRowInfo() {
  document.querySelectorAll("#player-rows .info").forEach((info) => {
    const id = state.picks[Number(info.dataset.index)];
    const load = id && state.loads.get(id);
    info.className = "info";
    if (!id || !state.playlists || !state.playlists.some((p) => p.id === id)) info.textContent = "";
    else if (!load || load.status === "loading") info.textContent = "Loading songs...";
    else if (load.status === "ok") { info.textContent = `✓ ${load.cards.length} songs ready`; info.classList.add("ok"); }
    else { info.textContent = load.error; info.classList.add("err"); }
  });
  updateStart();
}

async function loadPick(id) {
  if (!id || state.loads.has(id)) return;
  state.loads.set(id, { status: "loading" });
  renderRowInfo();
  try {
    const cards = await fetchPlaylistCards(id);
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
    if (state.playlists.some((p) => p.id === state.picks[i])) loadPick(state.picks[i]);
  }
}

async function refreshPlaylists() {
  state.playlists = null;
  renderSetup();
  try {
    state.playlists = await fetchAllowedPlaylists(state.me);
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
    for (const d of devices) {
      const label = d.id === playback.browserDeviceId ? "This browser (Jukemonster)" : `${d.name} (${d.type})`;
      select.append(new Option(label + (d.is_active ? " · active" : ""), d.id));
    }
    select.value = playback.pick(devices).id;
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
  if (state.mode === "whose" && new Set(state.picks.slice(0, activeCount())).size < 2) {
    return "Whose Playlist? needs players to pick different playlists.";
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

function onTestAudio() {
  const pool = activeLoads().filter((l) => l && l.status === "ok").flatMap((l) => l.cards);
  if (!pool.length) return;
  const status = $("setup-status");
  runBusy(async () => {
    setStatus(status, "Playing a test song... listen for it.");
    try {
      const sample = pool[Math.floor(Math.random() * pool.length)];
      await playback.play(sample.track_id, randomStart(sample));
      $("heard-btn").disabled = false;
      setStatus(status, "Did you hear music? Press \"Heard it!\" once you do.");
    } catch (err) {
      setStatus(status, err.message, "err");
    }
  });
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
  const prep = (cards) => shuffle(state.reduce ? applyYearLimit(cards, dedupeMode()) : cards.slice());

  game = {
    mode: state.mode,
    solo: state.solo,
    months: state.months,
    rounds: lengthValue(),
    players: Array.from({ length: n }, (_, i) => ({
      name: playerName(i), color: PLAYER_COLORS[i], score: 0, turns: 0, timeline: [], lives: SOLO_LIVES,
    })),
    useShared: state.solo || state.mix || state.mode === "whose",
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

function playFull() {
  const card = game.current;
  runBusy(async () => {
    try {
      await playback.play(card.track_id, card.start);
      game.barStart = performance.now();
      game.barMs = FULL_PLAY_MS;
      setStatus($("play-status"), "");
    } catch (err) {
      setStatus($("play-status"), err.message, "err");
    }
  });
}

function onPlayCard() {
  if (!ensureCard()) return;
  renderGame();
  playFull();
}

function onSnippet(levelIndex) {
  if (!ensureCard()) return;
  game.level = Math.max(game.level, levelIndex + 1);
  renderGame();
  const card = game.current;
  const ms = LEVELS[levelIndex].ms;
  game.barStart = null;
  runBusy(async () => {
    try {
      await playback.snippet(card.track_id, card.start, ms, () => {
        game.barStart = performance.now();
        game.barMs = ms;
      });
      setStatus($("play-status"), "");
    } catch (err) {
      setStatus($("play-status"), err.message, "err");
    }
  });
}

function reveal(result = null) {
  if (!game.current) return;
  game.phase = "revealed";
  game.result = result;
  game.barStart = null;
  playback.pause();
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
  } else if (game.solo) {
    p.lives--;
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
  else if (game.solo) game.players[0].lives = 0;
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
  game.barStart = null;

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
      if (game.solo) return ps[0].lives <= 0 ? "Three wrong placements." : null;
      const winner = ps.find((p) => p.timeline.length >= TIMELINE_GOAL);
      return winner ? `${winner.name} reached ${TIMELINE_GOAL} cards!` : null;
    }
    case "oldernewer":
      if (game.solo) return ps[0].lives <= 0 ? "Streak over." : null;
      return ps.every((p) => p.turns >= game.rounds) ? "All rounds played." : null;
    case "guess":
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
    case "guess": return `${p.score} pts`;
    case "whose": return `${p.score} pts`;
    case "timeline":
      return game.solo
        ? `${p.timeline.length} ${p.timeline.length === 1 ? "card" : "cards"} · ${"♥".repeat(Math.max(0, p.lives))}${"♡".repeat(SOLO_LIVES - Math.max(0, p.lives))}`
        : `${p.timeline.length} / ${TIMELINE_GOAL}`;
    case "oldernewer": return game.solo ? `Streak ${p.score}` : `${p.score} pts`;
    default: return "";
  }
}

function endGame(reason) {
  playback.pause();
  game.over = reason;
  const ranked = game.players.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
  let sub;
  if (game.solo) {
    const p = game.players[0];
    const key = `jm_best_${game.mode}${game.rounds ? "_" + game.rounds : ""}`;
    const best = store.get(key, 0);
    const score = scoreOf(p);
    if (score > best) store.set(key, score);
    const what = game.mode === "timeline" ? `${score} ${score === 1 ? "card" : "cards"} in your timeline`
      : game.mode === "oldernewer" ? `a streak of ${score}` : `${score} points`;
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
    timeline: g.phase === "playing" ? ", tap where this song goes" : "'s turn",
    whose: ", whose playlist is this on?",
    oldernewer: ", older or newer than the last song?",
  };
  const soloPrompts = {
    guess: "Name that song!",
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
    guess: "Say your guess out loud, then Reveal",
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
      if (revealed) {
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
        hint.textContent = g.level
          ? `Worth ${LEVELS[g.level - 1].points} ${g.level === 4 ? "point" : "points"} right now. Longer snippets are worth less.`
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

    case "oldernewer":
      if (revealed) c.append(button(nextLabel, "primary", finishTurn));
      else if (!has) c.append(playBtn());
      else c.append(playBtn(), el("div", "break"), button("◀ Older", "teal", () => onOlderNewer(true)), button("Newer ▶", "primary", () => onOlderNewer(false)));
      break;
  }
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
  $("logout-link").addEventListener("click", (e) => { e.preventDefault(); logout(); });

  $("pick-solo").addEventListener("click", () => setSolo(true));
  $("pick-multi").addEventListener("click", () => setSolo(false));
  $("reload-playlists").addEventListener("click", (e) => { e.preventDefault(); refreshPlaylists(); });
  $("test-btn").addEventListener("click", onTestAudio);
  $("heard-btn").addEventListener("click", onHeardIt);
  $("refresh-devices").addEventListener("click", refreshDevices);
  $("device-select").addEventListener("change", (e) => {
    playback.chosenId = e.target.value;
    store.set("jm_device", playback.chosenId);
  });

  $("opt-mix").addEventListener("change", (e) => { state.mix = e.target.checked; saveSetup(); });
  $("opt-months").addEventListener("change", (e) => { state.months = e.target.checked; saveSetup(); });
  $("opt-reduce").addEventListener("change", (e) => { state.reduce = e.target.checked; saveSetup(); renderOptions(); });
  $("mode-popular").addEventListener("click", () => { state.dedupe = "popularity"; saveSetup(); renderOptions(); });
  $("mode-recent").addEventListener("click", () => { state.dedupe = "recent"; saveSetup(); renderOptions(); });
  $("start-btn").addEventListener("click", () => { if (!startProblem()) newGame(); });

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

  if (!store.get("jm_token")) {
    showScreen("screen-login");
    return;
  }
  try {
    state.me = await api("/me");
    $("user-name").textContent = state.me.display_name || state.me.id;
  } catch (err) {
    store.remove("jm_token");
    showScreen("screen-login");
    setStatus($("login-status"), "Please sign in again. " + err.message, "err");
    return;
  }
  renderSetup();
  showScreen("screen-setup");
  signedIn = true;
  startBrowserPlayer();
  refreshDevices();
  refreshPlaylists();
}

main();
