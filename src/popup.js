/**
 * Returns a human-readable status message for the given AppState.
 * @param {object|null} state - The AppState from the background service worker
 * @returns {string}
 */
function getStatusMessage(state) {
  if (!state || !state.nowPlaying) {
    return "No song currently playing";
  }
  switch (state.lyricsStatus) {
    case "found":    return "";
    case "loading":  return "Loading lyrics...";
    case "not_found": return "Lyrics not found";
    case "error":    return "Error fetching lyrics";
    case "idle":     return "No song playing";
    default:         return "";
  }
}

// Only run DOM logic in a browser context (not during unit tests)
if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const trackTitle = document.getElementById("track-title");
    const trackArtist = document.getElementById("track-artist");
    const statusMsg = document.getElementById("status-msg");

    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
      const state = response && response.state ? response.state : null;
      if (state && state.nowPlaying) {
        trackTitle.textContent = state.nowPlaying.title || "Unknown title";
        trackArtist.textContent = state.nowPlaying.artist || "";
      } else {
        trackTitle.textContent = "No song playing";
        trackArtist.textContent = "";
      }
      statusMsg.textContent = getStatusMessage(state);
    });

    // --- Show keyboard shortcut hint ---
    chrome.commands.getAll((commands) => {
      const cmd = commands.find(c => c.name === "open-pip");
      const hintEl = document.getElementById("shortcut-hint");
      if (hintEl && cmd && cmd.shortcut) {
        hintEl.innerHTML = `Hotkey: <kbd>${cmd.shortcut}</kbd>`;
      }
    });

    // --- Karaoke setting ---
    const karaokeToggle = document.getElementById("karaoke-toggle");
    chrome.storage.local.get("karaokeMode", (result) => {
      karaokeToggle.checked = result.karaokeMode !== false;
    });
    karaokeToggle.addEventListener("change", () => {
      chrome.storage.local.set({ karaokeMode: karaokeToggle.checked });
    });

    // --- Font size setting ---
    const FONT_STEPS = ["S", "M", "L", "XL"];
    const fontLabel = document.getElementById("font-size-label");
    const fontDec   = document.getElementById("font-dec");
    const fontInc   = document.getElementById("font-inc");

    function applyFontStep(step) {
      fontLabel.textContent = FONT_STEPS[step];
      fontDec.disabled = step === 0;
      fontInc.disabled = step === FONT_STEPS.length - 1;
    }

    let currentFontStep = 1; // default Medium
    chrome.storage.local.get("lyricsFontStep", (r) => {
      currentFontStep = (r.lyricsFontStep != null) ? r.lyricsFontStep : 1;
      applyFontStep(currentFontStep);
    });

    fontDec.addEventListener("click", () => {
      if (currentFontStep > 0) {
        currentFontStep--;
        chrome.storage.local.set({ lyricsFontStep: currentFontStep });
        applyFontStep(currentFontStep);
      }
    });
    fontInc.addEventListener("click", () => {
      if (currentFontStep < FONT_STEPS.length - 1) {
        currentFontStep++;
        chrome.storage.local.set({ lyricsFontStep: currentFontStep });
        applyFontStep(currentFontStep);
      }
    });

    // --- Blur setting ---
    const blurToggle = document.getElementById("blur-toggle");
    chrome.storage.local.get("blurMode", (result) => {
      blurToggle.checked = result.blurMode !== false;
    });
    blurToggle.addEventListener("change", () => {
      chrome.storage.local.set({ blurMode: blurToggle.checked });
    });

    document.getElementById("window-btn").addEventListener("click", () => {
      // PiP must open in the YTM tab (video + mediaSession live there).
      // chrome.scripting.executeScript carries the popup's user-gesture into the
      // tab's context, which satisfies requestWindow()'s activation requirement.
      chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
        if (!tabs || !tabs[0]) return;
        const ytmTabId = tabs[0].id;
        chrome.scripting.executeScript({
          target: { tabId: ytmTabId },
          world: "ISOLATED",
          func: () => {
            // Runs in the content script's isolated world, carrying the popup's user gesture.
            // The ytm-content.js listener picks this up and calls requestWindow().
            window.dispatchEvent(new CustomEvent("ytm-lyrics-open-pip"));
          },
        });
        window.close();
      });
    });
  });
}

// Export for testability
if (typeof module !== "undefined") {
  module.exports = { getStatusMessage };
}
