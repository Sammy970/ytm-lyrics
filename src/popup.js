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
    const toggleBtn = document.getElementById("toggle-btn");

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

    toggleBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id != null) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_OVERLAY" });
        }
      });
    });

    document.getElementById("window-btn").addEventListener("click", () => {
      chrome.windows.create({
        url: chrome.runtime.getURL("src/lyrics-window.html"),
        type: "popup",
        width: 380,
        height: 600,
      });
    });
  });
}

// Export for testability
if (typeof module !== "undefined") {
  module.exports = { getStatusMessage };
}
