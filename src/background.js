// Background Service Worker — MV3 plain script (no module imports)
// Feature: yt-music-floating-lyrics

// ---------------------------------------------------------------------------
// AppState — single source of truth
// ---------------------------------------------------------------------------
let appState = {
  nowPlaying: null,      // Track | null
  lyrics: null,          // string | null
  lyricsStatus: "idle",  // "idle" | "loading" | "found" | "not_found" | "error"
  songStartTime: 0,      // video.currentTime when the current track started
  isPlaying: false,      // whether the video is currently playing
  thumbnailUrl: null,    // album art URL for the current track
};

// ---------------------------------------------------------------------------
// Lyrics fetcher — inlined from src/lyrics-fetcher.js (service workers can't use require)
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLyrics(track) {
  const RETRY_DELAYS = [500, 1000, 2000];
  const url =
    `https://lrclib.net/api/search` +
    `?track_name=${encodeURIComponent(track.title)}` +
    `&artist_name=${encodeURIComponent(track.artist)}`;

  console.log(`[lyrics-fetcher] Fetching lyrics for: "${track.title}" by "${track.artist}"`);
  console.log(`[lyrics-fetcher] URL: ${url}`);

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    let response;
    try {
      response = await fetch(url);
    } catch (networkError) {
      console.warn(`[lyrics-fetcher] Network error on attempt ${attempt + 1}:`, networkError.message);
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      console.error("[lyrics-fetcher] All retries exhausted, returning error");
      return { status: "error", lyrics: null };
    }

    console.log(`[lyrics-fetcher] Response status: ${response.status}`);

    if (response.status >= 400 && response.status < 500) {
      console.warn(`[lyrics-fetcher] 4xx response (${response.status}), returning not_found`);
      return { status: "not_found", lyrics: null };
    }

    if (!response.ok) {
      console.warn(`[lyrics-fetcher] Non-OK response (${response.status}), retrying...`);
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      return { status: "error", lyrics: null };
    }

    const results = await response.json();
    console.log(`[lyrics-fetcher] Got ${results.length} result(s) from LRCLib`);

    if (!Array.isArray(results) || results.length === 0) {
      console.warn("[lyrics-fetcher] Empty results array, returning not_found");
      return { status: "not_found", lyrics: null };
    }

    // Prefer a result with synced lyrics; fall back to any result with plain lyrics
    const withSynced = results.find(r => r.syncedLyrics && r.syncedLyrics.trim());
    const withPlain  = results.find(r => r.plainLyrics  && r.plainLyrics.trim());
    const best = withSynced || withPlain;

    if (!best) {
      console.warn("[lyrics-fetcher] No result has any lyrics text, returning not_found");
      return { status: "not_found", lyrics: null };
    }

    const lyrics = best.syncedLyrics || best.plainLyrics;
    const type = best.syncedLyrics ? "synced" : "plain";
    console.log(`[lyrics-fetcher] Using ${type} lyrics from "${best.trackName}" by "${best.artistName}"`);
    return { status: "found", lyrics };
  }

  return { status: "error", lyrics: null };
}

// ---------------------------------------------------------------------------
// Lyrics cache helpers
// Cache entries stored in chrome.storage.local keyed by `${title}::${artist}`
// ---------------------------------------------------------------------------

function clearLyricsCache() {
  chrome.storage.local.get(null, (all) => {
    const keysToRemove = Object.keys(all).filter(k => k.includes("::"));
    if (keysToRemove.length > 0) {
      chrome.storage.local.remove(keysToRemove, () => {
        console.log(`[lyrics-cache] Cleared ${keysToRemove.length} stale cache entries on startup`);
      });
    }
  });
}

clearLyricsCache();

function cacheKey(track) {
  return `${track.title.toLowerCase()}::${track.artist.toLowerCase()}`;
}

function getCacheEntry(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(result[key] ?? null);
    });
  });
}

function setCacheEntry(key, entry) {
  const value = { ...entry, fetchedAt: Date.now() };
  chrome.storage.local.set({ [key]: value }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[lyrics-cache] Failed to write cache:", chrome.runtime.lastError.message);
    }
  });
}

async function fetchLyricsWithCache(track) {
  const key = cacheKey(track);
  const cached = await getCacheEntry(key);
  if (cached && (cached.status === "found" || cached.status === "not_found")) {
    console.log(`[lyrics-cache] Cache hit for "${key}" → status: ${cached.status}`);
    return { status: cached.status, lyrics: cached.lyrics ?? null };
  }

  console.log(`[lyrics-cache] Cache miss for "${key}", fetching from API...`);
  const result = await fetchLyrics(track);

  if (result.status === "found" || result.status === "not_found") {
    setCacheEntry(key, { lyrics: result.lyrics ?? null, status: result.status });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Broadcast helpers — sends state only to the YTM tab (PiP lives there)
// ---------------------------------------------------------------------------

function sendToYtmTab(message) {
  chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, message, () => {
      void chrome.runtime.lastError;
    });
  });
}

function broadcastState() {
  sendToYtmTab({ type: "LYRICS_UPDATE", state: appState });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function handleNowPlaying(track, songStartTime, thumbnailUrl) {
  appState.nowPlaying = track;

  if (!track) {
    console.log("[background] Track cleared, resetting state");
    appState.lyrics = null;
    appState.lyricsStatus = "idle";
    appState.songStartTime = 0;
    appState.thumbnailUrl = null;
    broadcastState();
    return;
  }

  // Clean artist: strip album/year suffix (e.g. "Justin Bieber • SWAG II • 2025" → "Justin Bieber")
  const cleanArtist = track.artist.split(/\s*[•·]\s*/)[0].trim();
  const cleanTrack = cleanArtist !== track.artist
    ? { title: track.title, artist: cleanArtist }
    : track;

  if (cleanArtist !== track.artist) {
    console.log(`[background] Cleaned artist: "${track.artist}" → "${cleanArtist}"`);
  }

  appState.nowPlaying = cleanTrack;
  appState.songStartTime = songStartTime || 0;
  appState.thumbnailUrl = thumbnailUrl || null;
  console.log(`[background] Now playing: "${cleanTrack.title}" by "${cleanTrack.artist}" (songStartTime: ${appState.songStartTime})`);
  appState.lyricsStatus = "loading";
  appState.lyrics = null;
  broadcastState();

  try {
    const result = await fetchLyricsWithCache(cleanTrack);
    if (
      appState.nowPlaying &&
      appState.nowPlaying.title === cleanTrack.title &&
      appState.nowPlaying.artist === cleanTrack.artist
    ) {
      appState.lyrics = result.lyrics ?? null;
      appState.lyricsStatus = result.status;
      broadcastState();
    }
  } catch (err) {
    if (
      appState.nowPlaying &&
      appState.nowPlaying.title === cleanTrack.title &&
      appState.nowPlaying.artist === cleanTrack.artist
    ) {
      appState.lyrics = null;
      appState.lyricsStatus = "error";
      broadcastState();
    }
  }
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "NOW_PLAYING") {
    handleNowPlaying(message.track, message.songStartTime, message.thumbnailUrl);
    return false;
  }

  if (message.type === "SEEK_TO") {
    sendToYtmTab({ type: "SEEK_TO", time: message.time });
    return false;
  }

  if (message.type === "TIME_UPDATE") {
    if (typeof message.isPlaying === "boolean") {
      appState.isPlaying = message.isPlaying;
    }
    // SYNC_UPDATE only goes to the YTM tab — PiP runs there
    sendToYtmTab({ type: "SYNC_UPDATE", currentTime: message.currentTime, isPlaying: appState.isPlaying });
    return false;
  }

  if (message.type === "PLAY_STATE") {
    if (typeof message.isPlaying === "boolean") {
      appState.isPlaying = message.isPlaying;
    }
    sendToYtmTab({ type: "SYNC_UPDATE", currentTime: null, isPlaying: appState.isPlaying });
    return false;
  }

  if (message.type === "MEDIA_CONTROL") {
    sendToYtmTab({ type: "MEDIA_CONTROL", action: message.action });
    return false;
  }

  if (message.type === "GET_STATE") {
    sendResponse({ state: appState });
    return false;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Global keyboard shortcut — "open-pip" command
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-pip") return;
  chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: "ISOLATED",
      func: () => {
        window.dispatchEvent(new CustomEvent("ytm-lyrics-open-pip"));
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Tab removal — clear state when the YTM tab closes
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(() => {
  chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      appState.nowPlaying = null;
      appState.lyrics = null;
      appState.lyricsStatus = "idle";
    }
  });
});
