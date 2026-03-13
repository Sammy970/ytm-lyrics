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
  // ---------------------------------------------------------------------------
  // LRC parsing helpers (needed for PiP lyrics sync)
  // ---------------------------------------------------------------------------

  function parseLRC(lrc) {
    const lines = lrc.split('\n');
    const parsed = [];
    const re = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) {
        const time = parseInt(m[1]) * 60 + parseFloat(m[2] + '.' + m[3]);
        parsed.push({ time, text: m[4].trim() });
      }
    }
    return parsed.length > 0 ? parsed : null;
  }

  function getActiveLine(lines, currentTime) {
    let active = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= currentTime) active = i;
      else break;
    }
    return active;
  }

  // ---------------------------------------------------------------------------
  // Document Picture-in-Picture — lives here so we can use the mediaSession API
  // alongside the real <video> element that Chrome requires for auto-PiP.
  // ---------------------------------------------------------------------------

  let pipWindow = null;
  let pipParsedLRC = null;
  let pipEnabled = false;
  let pipLastState = null;
  let pipSongStartTime = 0;

  function renderPiP(state) {
    if (!pipWindow || pipWindow.closed) return;
    const doc = pipWindow.document;
    doc.body.innerHTML = "";

    const title = state && state.nowPlaying
      ? `${state.nowPlaying.title} — ${state.nowPlaying.artist}`
      : "YT Music Lyrics";

    const header = doc.createElement("div");
    header.style.cssText = "background:#16213e;padding:8px 12px;flex-shrink:0;border-bottom:1px solid #1e2d50;font-size:12px;font-weight:bold;color:#a0c4ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    header.textContent = title;
    doc.body.appendChild(header);

    const body = doc.createElement("div");
    body.id = "pip-body";
    body.style.cssText = "flex:1;overflow-y:auto;padding:12px 14px;scroll-behavior:smooth;";
    doc.body.appendChild(body);

    pipParsedLRC = null;

    const noLyrics = (text) => {
      body.style.cssText += "display:flex;align-items:center;justify-content:center;color:#666;font-style:italic;font-size:13px;";
      body.textContent = text;
    };

    if (!state || !state.nowPlaying) return noLyrics("No song currently playing");
    if (state.lyricsStatus === "loading") return noLyrics("Loading lyrics...");
    if (state.lyricsStatus === "not_found") return noLyrics("Lyrics not found");
    if (state.lyricsStatus === "error") return noLyrics("Error fetching lyrics");

    if (state.lyricsStatus === "found" && state.lyrics) {
      pipParsedLRC = parseLRC(state.lyrics);
      if (pipParsedLRC) {
        pipParsedLRC.forEach((line, i) => {
          const p = doc.createElement("p");
          p.dataset.lineIndex = String(i);
          p.style.cssText = "margin:4px 0;padding:3px 8px;border-radius:4px;font-size:14px;line-height:1.6;color:#555;cursor:pointer;transition:color 0.2s,background 0.2s;";
          p.textContent = line.text || "♪";
          p.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "SEEK_TO", time: line.time + pipSongStartTime });
          });
          body.appendChild(p);
        });
      } else {
        body.style.cssText += "white-space:pre-wrap;font-size:13px;color:#ccc;";
        body.textContent = state.lyrics;
      }
    }
  }

  function syncPiP(currentTime) {
    if (!pipWindow || pipWindow.closed || !pipParsedLRC) return;
    const body = pipWindow.document.getElementById("pip-body");
    if (!body) return;
    const activeIdx = getActiveLine(pipParsedLRC, currentTime - pipSongStartTime);
    body.querySelectorAll("[data-line-index]").forEach((el, i) => {
      if (i === activeIdx) {
        Object.assign(el.style, { color: "#fff", fontWeight: "bold", fontSize: "15px", background: "rgba(160,196,255,0.12)" });
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (i < activeIdx) {
        Object.assign(el.style, { color: "#444", fontWeight: "normal", fontSize: "14px", background: "" });
      } else {
        Object.assign(el.style, { color: "#555", fontWeight: "normal", fontSize: "14px", background: "" });
      }
    });
  }

  async function openPiPWindow(state) {
    if (!("documentPictureInPicture" in window)) {
      console.warn("[pip] Document PiP API not supported in this context.");
      return;
    }
    if (pipWindow && !pipWindow.closed) {
      renderPiP(state);
      return;
    }
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 340,
        height: 520,
      });
      pipWindow.document.body.style.cssText = "margin:0;padding:0;background:#0d0d1a;color:#e0e0e0;font-family:Arial,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden;user-select:none;";
      renderPiP(state);
      pipWindow.addEventListener("pagehide", () => {
        pipWindow = null;
        pipParsedLRC = null;
        // User explicitly closed the window (X button) — disable auto-reopen
        if (document.visibilityState === "visible") {
          pipEnabled = false;
        }
        // If page is hidden the mediaSession handler will reopen it automatically
        // when the user switches away again, so we leave pipEnabled as-is.
      });
    } catch (e) {
      console.error("[pip] requestWindow failed:", e.message);
    }
  }

  // Listen for the custom event dispatched by scripting.executeScript from the popup.
  // executeScript carries the popup click's user gesture into this context, which
  // satisfies documentPictureInPicture.requestWindow()'s activation requirement.
  window.addEventListener("ytm-lyrics-open-pip", () => {
    console.log("[pip] custom event trigger received");
    pipEnabled = true;
    openPiPWindow(pipLastState);
  });

  // Register the mediaSession "enterpictureinpicture" action handler.
  // Chrome fires this automatically (no user gesture needed) when:
  //   • The page has a playing <video> with audio  AND
  //   • The user switches to another tab or app
  // This is exactly the same mechanism Google Meet uses to stay on top.
  try {
    navigator.mediaSession.setActionHandler("enterpictureinpicture", () => {
      if (!pipEnabled) return;
      console.log("[pip] mediaSession auto-PiP triggered");
      openPiPWindow(pipLastState);
    });
    console.log("[pip] mediaSession enterpictureinpicture handler registered");
  } catch (e) {
    console.warn("[pip] enterpictureinpicture mediaSession action not supported:", e.message);
  }

  // Fetch initial state on load so pipLastState is populated
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (response && response.state) pipLastState = response.state;
  });

  // ---------------------------------------------------------------------------
  // Inlined track extraction logic (mirrors src/track-extractor.js)
  // ---------------------------------------------------------------------------

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
      const video = document.querySelector('video');
      const songStartTime = video ? video.currentTime : 0;
      chrome.runtime.sendMessage({ type: 'NOW_PLAYING', track, songStartTime });
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

  // --- Message listener: seek + PiP ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SEEK_TO') {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = message.time;
        console.log(`[ytm-content] Seeked to ${message.time}s`);
      }
    } else if (message.type === "LYRICS_UPDATE") {
      pipLastState = message.state;
      pipSongStartTime = (message.state && message.state.songStartTime) || 0;
      if (pipWindow && !pipWindow.closed) renderPiP(message.state);
    } else if (message.type === "SYNC_UPDATE") {
      syncPiP(message.currentTime);
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
