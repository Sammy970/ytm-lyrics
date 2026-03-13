// Background Service Worker — MV3 plain script (no module imports)
// Feature: yt-music-floating-lyrics

// ---------------------------------------------------------------------------
// AppState — single source of truth (Requirements 1.3, 5.3)
// ---------------------------------------------------------------------------
let appState = {
  nowPlaying: null,      // Track | null
  lyrics: null,          // string | null
  lyricsStatus: "idle",  // "idle" | "loading" | "found" | "not_found" | "error"
  songStartTime: 0,      // video.currentTime when the current track started
};

// ---------------------------------------------------------------------------
// Active overlay tab tracking — Requirements 5.2
// Tracks which tab IDs currently have an active overlay so we can broadcast.
// ---------------------------------------------------------------------------
const activeOverlayTabs = new Set();

// ---------------------------------------------------------------------------
// Lyrics window tracking — reuse existing window instead of opening duplicates
// ---------------------------------------------------------------------------
let lyricsWindowId = null;

function createLyricsWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL("src/lyrics-window.html"),
    type: "popup",
    width: 380,
    height: 600,
    focused: true,
  }, (win) => {
    if (win) lyricsWindowId = win.id;
  });
}

// Clear the tracked ID when the window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === lyricsWindowId) lyricsWindowId = null;
});

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
// Lyrics cache helpers — Requirements 2.5
// Cache entries stored in chrome.storage.local keyed by `${title}::${artist}`
// ---------------------------------------------------------------------------

/**
 * Clear all cached lyrics entries (keys that contain "::").
 * Called on service worker startup to wipe stale entries from previous sessions.
 */
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

// Clear cache on startup so improved fetch logic runs fresh
clearLyricsCache();

/**
 * Build the cache key for a track.
 * @param {{ title: string, artist: string }} track
 * @returns {string}
 */
function cacheKey(track) {
  return `${track.title.toLowerCase()}::${track.artist.toLowerCase()}`;
}

/**
 * Read a cache entry from chrome.storage.local.
 * @param {string} key
 * @returns {Promise<{ lyrics: string|null, status: "found"|"not_found"|"error", fetchedAt: number }|null>}
 */
function getCacheEntry(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(result[key] ?? null);
    });
  });
}

/**
 * Write a cache entry to chrome.storage.local.
 * @param {string} key
 * @param {{ lyrics: string|null, status: "found"|"not_found"|"error" }} entry
 */
function setCacheEntry(key, entry) {
  const value = { ...entry, fetchedAt: Date.now() };
  chrome.storage.local.set({ [key]: value }, () => {
    if (chrome.runtime.lastError) {
      // Storage quota exceeded or other error — log and continue (design: skip cache write)
      console.warn("[lyrics-cache] Failed to write cache:", chrome.runtime.lastError.message);
    }
  });
}

/**
 * Fetch lyrics with cache-aside logic.
 * Checks chrome.storage.local first; only calls fetchLyrics on a cache miss.
 * Stores the result after a successful fetch.
 * @param {{ title: string, artist: string }} track
 * @returns {Promise<{ status: "found"|"not_found"|"error", lyrics: string|null }>}
 */
async function fetchLyricsWithCache(track) {
  const key = cacheKey(track);

  // Cache hit — return stored result directly
  const cached = await getCacheEntry(key);
  if (cached && (cached.status === "found" || cached.status === "not_found")) {
    console.log(`[lyrics-cache] Cache hit for "${key}" → status: ${cached.status}`);
    return { status: cached.status, lyrics: cached.lyrics ?? null };
  }

  console.log(`[lyrics-cache] Cache miss for "${key}", fetching from API...`);
  const result = await fetchLyrics(track);

  // Persist result (skip caching transient "error" status to allow retries later)
  if (result.status === "found" || result.status === "not_found") {
    setCacheEntry(key, { lyrics: result.lyrics ?? null, status: result.status });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Broadcast helpers — Requirements 5.2
// ---------------------------------------------------------------------------

/**
 * Send the current appState to every tab that has an active overlay.
 * Errors per-tab are silently ignored (tab may have navigated away).
 */
function broadcastState() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "LYRICS_UPDATE", state: appState }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
  // Also notify extension pages (floating lyrics window)
  chrome.runtime.sendMessage({ type: "LYRICS_UPDATE", state: appState }, () => {
    void chrome.runtime.lastError;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Update appState and kick off a lyrics fetch for the given track.
 * @param {Track|null} track
 * @param {number} songStartTime - video.currentTime when this track started
 */
async function handleNowPlaying(track, songStartTime) {
  appState.nowPlaying = track;

  if (!track) {
    console.log("[background] Track cleared, resetting state");
    appState.lyrics = null;
    appState.lyricsStatus = "idle";
    appState.songStartTime = 0;
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
  console.log(`[background] Now playing: "${cleanTrack.title}" by "${cleanTrack.artist}" (songStartTime: ${appState.songStartTime})`);
  appState.lyricsStatus = "loading";
  appState.lyrics = null;
  broadcastState();

  try {
    const result = await fetchLyricsWithCache(cleanTrack);
    // Only apply the result if the track hasn't changed while we were fetching
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
// Message listener (Requirements 1.3, 5.3)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "OPEN_LYRICS_WINDOW") {
    // If a lyrics window is already open, focus it instead of opening a new one
    if (lyricsWindowId != null) {
      chrome.windows.update(lyricsWindowId, { focused: true }, (win) => {
        if (chrome.runtime.lastError || !win) {
          // Window no longer exists, open a fresh one
          lyricsWindowId = null;
          createLyricsWindow();
        }
      });
    } else {
      createLyricsWindow();
    }
    return false;
  }

  if (message.type === "NOW_PLAYING") {
    // Fire-and-forget; sendResponse not needed for this message type
    handleNowPlaying(message.track, message.songStartTime);
    return false;
  }

  if (message.type === "SEEK_TO") {
    // Find the YTM tab and tell its content script to seek the video
    chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "SEEK_TO", time: message.time }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
    return false;
  }

  if (message.type === "TIME_UPDATE") {
    // Forward playback time to all tabs AND the lyrics window (extension pages)
    const syncMsg = { type: "SYNC_UPDATE", currentTime: message.currentTime };
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, syncMsg, () => { void chrome.runtime.lastError; });
      }
    });
    // Also broadcast to extension pages (e.g. the floating lyrics window)
    chrome.runtime.sendMessage(syncMsg, () => { void chrome.runtime.lastError; });
    return false;
  }

  if (message.type === "GET_STATE") {
    sendResponse({ state: appState });
    return false;
  }

  if (message.type === "OVERLAY_ACTIVE") {
    if (sender.tab && sender.tab.id != null) {
      activeOverlayTabs.add(sender.tab.id);
    }
    return false;
  }

  if (message.type === "OVERLAY_INACTIVE") {
    if (sender.tab && sender.tab.id != null) {
      activeOverlayTabs.delete(sender.tab.id);
    }
    return false;
  }

  // Unknown message — no response
  return false;
});

// ---------------------------------------------------------------------------
// Tab removal — clear state when the YTM tab closes (Requirement 1.4)
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener((tabId, _removeInfo) => {
  // Remove the closed tab from the active overlay set
  activeOverlayTabs.delete(tabId);

  // If no YTM tab remains, clear the now-playing state
  chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      appState.nowPlaying = null;
      appState.lyrics = null;
      appState.lyricsStatus = "idle";
    }
  });
});
