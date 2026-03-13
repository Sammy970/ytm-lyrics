/**
 * YTM Content Script — runs on music.youtube.com
 *
 * Detects track changes via MutationObserver on ytmusic-player-bar,
 * falls back to 2-second polling, and sends NOW_PLAYING messages to
 * the background service worker.
 *
 * NOTE: This is a plain content script (no module system). The
 * extractNowPlaying logic is inlined here to avoid require().
 */

(function () {
  // --- Inlined track extraction logic (mirrors src/track-extractor.js) ---

  /**
   * Strips album/year info from a YTM byline.
   * YTM byline format: "Artist • Album • Year" or "Artist • Album"
   * We only want the artist name (first segment).
   * Handles both the bullet character (•, U+2022) and the middle dot (·, U+00B7).
   * @param {string} byline
   * @returns {string}
   */
  function extractArtist(byline) {
    // Split on any of: " • ", " · ", " - " or just the bullet/dot with optional spaces
    return byline.split(/\s*[•·]\s*/)[0].trim();
  }

  /**
   * @returns {{ title: string, artist: string } | null}
   */
  function extractNowPlaying() {
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return null;

    const titleEl = playerBar.querySelector('yt-formatted-string.title');
    const artistEl = playerBar.querySelector('yt-formatted-string.byline');

    if (!titleEl || !artistEl) return null;

    const title = titleEl.textContent.trim();
    const artist = extractArtist(artistEl.textContent.trim());

    if (!title || !artist) return null;

    return { title, artist };
  }

  // --- Track change detection ---

  /** @type {{ title: string, artist: string } | null} */
  let lastTrack = null;

  /**
   * Compares two tracks for equality.
   * @param {object|null} a
   * @param {object|null} b
   * @returns {boolean}
   */
  function tracksEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.title === b.title && a.artist === b.artist;
  }

  /**
   * Checks the current track and sends a NOW_PLAYING message if it changed.
   */
  function checkAndNotify() {
    const track = extractNowPlaying();
    if (!tracksEqual(track, lastTrack)) {
      lastTrack = track;
      console.log("[ytm-content] Track changed:", track);
      chrome.runtime.sendMessage({ type: 'NOW_PLAYING', track });
    }
  }

  // --- MutationObserver setup ---

  function startObserver() {
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return false;

    const observer = new MutationObserver(() => {
      checkAndNotify();
    });

    observer.observe(playerBar, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    return true;
  }

  // --- Seek handler ---
  // Listens for SEEK_TO messages from the background (triggered by lyric line clicks)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SEEK_TO') {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = message.time;
        console.log(`[ytm-content] Seeked to ${message.time}s`);
      }
    }
  });

  // --- Playback time sync ---
  // Send current video time every 500ms so the overlay can highlight the active lyric line.
  setInterval(() => {
    const video = document.querySelector('video');
    if (video && !video.paused) {
      chrome.runtime.sendMessage({ type: 'TIME_UPDATE', currentTime: video.currentTime });
    }
  }, 500);

  // --- Polling fallback ---

  // Poll every 2 seconds. If the observer is already covering changes this
  // is a no-op (tracksEqual guard prevents duplicate messages).
  const POLL_INTERVAL_MS = 2000;
  setInterval(checkAndNotify, POLL_INTERVAL_MS);

  // --- Initialise ---

  // Try to attach the observer immediately; if the player bar isn't in the
  // DOM yet (e.g. SPA navigation), the polling will catch the first track
  // and we retry the observer on each poll tick until it succeeds.
  if (!startObserver()) {
    const retryInterval = setInterval(() => {
      if (startObserver()) {
        clearInterval(retryInterval);
      }
    }, POLL_INTERVAL_MS);
  }

  // Send the current track right away (covers page load / refresh).
  checkAndNotify();
})();
