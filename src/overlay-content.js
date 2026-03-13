/**
 * Overlay Content Script — rendering logic only.
 * Message listener is added in task 6.2.
 *
 * AppState shape:
 *   {
 *     nowPlaying: { title: string, artist: string } | null,
 *     lyrics: string | null,
 *     lyricsStatus: "idle" | "loading" | "found" | "not_found" | "error"
 *   }
 */

const OVERLAY_ID = "ytm-lyrics-overlay";
const Z_INDEX = 2147483647;

/** Base styles applied to the overlay container (fixed, high z-index, no external CSS). */
const CONTAINER_STYLES = {
  position: "fixed",
  top: "20px",
  right: "20px",
  width: "320px",
  maxHeight: "480px",
  zIndex: String(Z_INDEX),
  backgroundColor: "#1a1a2e",
  color: "#e0e0e0",
  fontFamily: "Arial, sans-serif",
  fontSize: "14px",
  borderRadius: "8px",
  boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  userSelect: "none",
};

const HEADER_STYLES = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px",
  backgroundColor: "#16213e",
  cursor: "grab",
  flexShrink: "0",
};

const TITLE_STYLES = {
  margin: "0",
  fontSize: "13px",
  fontWeight: "bold",
  color: "#a0c4ff",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "240px",
};

const CLOSE_BTN_STYLES = {
  background: "none",
  border: "none",
  color: "#e0e0e0",
  fontSize: "18px",
  cursor: "pointer",
  lineHeight: "1",
  padding: "0 2px",
  flexShrink: "0",
};

const TOGGLE_BTN_STYLES = {
  background: "none",
  border: "none",
  color: "#e0e0e0",
  fontSize: "16px",
  cursor: "pointer",
  lineHeight: "1",
  padding: "0 4px",
  flexShrink: "0",
};

const BODY_STYLES = {
  padding: "12px 14px",
  overflowY: "auto",
  flex: "1",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const STATUS_STYLES = {
  padding: "12px 14px",
  color: "#aaa",
  fontStyle: "italic",
  textAlign: "center",
};

/** Apply a plain object of style key/values to an element. */
function applyStyles(el, styles) {
  Object.assign(el.style, styles);
}

/**
 * Returns the existing overlay element, or creates and appends a new one to
 * document.body. The returned element is always present in the DOM.
 *
 * @returns {HTMLElement}
 */
function getOrCreateOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  applyStyles(overlay, CONTAINER_STYLES);
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Makes the overlay draggable by attaching mouse event listeners.
 * `mousedown` is listened on `header` but since the header is recreated on
 * each render, we use event delegation: the listener is attached to `overlay`
 * and only activates when the event target is the header or a child of it.
 * On first drag, switches from `right`-based to `left`-based positioning.
 * Dispatches a custom `overlayDragEnd` event on the overlay when drag ends.
 *
 * @param {HTMLElement} overlay - The overlay container element (persists across renders)
 * @param {HTMLElement} header  - The initial header element (used to identify the drag zone via CSS class)
 */
function makeDraggable(overlay, header) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  // Mark the header role with a data attribute so delegation works after re-renders
  header.dataset.dragHandle = "true";

  overlay.addEventListener("mousedown", (e) => {
    // Only respond to primary mouse button on the drag handle
    if (e.button !== 0) return;
    const handle = overlay.querySelector("[data-drag-handle]");
    if (!handle || !handle.contains(e.target)) return;

    dragging = true;

    const rect = overlay.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    // Switch to left/top positioning on first drag
    overlay.style.right = "";
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";

    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    overlay.style.left = e.clientX - offsetX + "px";
    overlay.style.top = e.clientY - offsetY + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    overlay.dispatchEvent(new CustomEvent("overlayDragEnd", { bubbles: false }));
  });

  // Persist position whenever a drag ends
  overlay.addEventListener("overlayDragEnd", () => {
    saveOverlayPrefs({
      position: {
        x: parseFloat(overlay.style.left) || 0,
        y: parseFloat(overlay.style.top) || 0,
      },
    });
  });
}

/**
 * Writes OverlayPrefs to chrome.storage.local.
 * Guarded so the file still works in Jest/Node.
 *
 * @param {object} prefs - Partial or full OverlayPrefs to merge/save
 */
function saveOverlayPrefs(prefs) {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  chrome.storage.local.get("overlayPrefs", (result) => {
    const existing = result.overlayPrefs || {};
    const merged = Object.assign({}, existing, prefs);
    chrome.storage.local.set({ overlayPrefs: merged });
  });
}

/**
 * Reads OverlayPrefs from chrome.storage.local.
 * Resolves to the stored OverlayPrefs object, or null if none saved.
 * Resolves to null in Jest/Node where chrome is unavailable.
 *
 * @returns {Promise<object|null>}
 */
function loadOverlayPrefs() {
  if (typeof chrome === "undefined" || !chrome.storage) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    chrome.storage.local.get("overlayPrefs", (result) => {
      resolve(result.overlayPrefs || null);
    });
  });
}

/**
 * Parses an LRC string into an array of { time, text } objects.
 * LRC format: [mm:ss.xx] lyric line
 * Returns null if the string has no timestamps (plain lyrics).
 * @param {string} lrc
 * @returns {Array<{time: number, text: string}>|null}
 */
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

/**
 * Given parsed LRC lines and a currentTime, returns the index of the active line.
 * @param {Array<{time: number}>} lines
 * @param {number} currentTime
 * @returns {number}
 */
function getActiveLine(lines, currentTime) {
  let active = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= currentTime) active = i;
    else break;
  }
  return active;
}

// Parsed LRC lines for the current track (null = plain lyrics, no sync)
let parsedLRC = null;

let currentMode = "expanded";

/**
 * Applies the current mode's height/overflow constraints to the overlay.
 *
 * @param {HTMLElement} overlay
 */
function applyMode(overlay) {
  if (currentMode === "compact") {
    overlay.style.maxHeight = "80px";
    const body = overlay.querySelector("[data-role='lyrics-body']");
    if (body) body.style.overflowY = "hidden";
  } else {
    overlay.style.maxHeight = "480px";
    const body = overlay.querySelector("[data-role='lyrics-body']");
    if (body) body.style.overflowY = "auto";
  }
}

/**
 * Removes the overlay from the DOM if it exists.
 * Persists visible:false to storage so it stays dismissed on next page load.
 */
function closeOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  saveOverlayPrefs({ visible: false });
}

/**
 * Renders the overlay according to the current AppState.
 * Creates the overlay if it doesn't exist yet.
 *
 * @param {object} state - AppState
 * @param {object|null} state.nowPlaying
 * @param {string|null} state.lyrics
 * @param {string} state.lyricsStatus
 */
function renderOverlay(state) {
  const { nowPlaying, lyrics, lyricsStatus } = state;
  const overlay = getOrCreateOverlay();

  // Clear previous content
  overlay.innerHTML = "";

  // --- Header ---
  const header = document.createElement("div");
  applyStyles(header, HEADER_STYLES);
  header.dataset.dragHandle = "true";

  const titleEl = document.createElement("p");
  applyStyles(titleEl, TITLE_STYLES);
  if (nowPlaying) {
    titleEl.textContent = `${nowPlaying.title} — ${nowPlaying.artist}`;
    titleEl.title = titleEl.textContent;
  } else {
    titleEl.textContent = "YT Music Lyrics";
  }

  const closeBtn = document.createElement("button");
  applyStyles(closeBtn, CLOSE_BTN_STYLES);
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close lyrics overlay");
  closeBtn.addEventListener("click", closeOverlay);

  const toggleBtn = document.createElement("button");
  applyStyles(toggleBtn, TOGGLE_BTN_STYLES);
  toggleBtn.textContent = currentMode === "compact" ? "⤢" : "↕";
  toggleBtn.setAttribute("aria-label", currentMode === "compact" ? "Expand overlay" : "Compact overlay");
  toggleBtn.addEventListener("click", () => {
    currentMode = currentMode === "compact" ? "expanded" : "compact";
    saveOverlayPrefs({ mode: currentMode });
    applyMode(overlay);
    toggleBtn.textContent = currentMode === "compact" ? "⤢" : "↕";
    toggleBtn.setAttribute("aria-label", currentMode === "compact" ? "Expand overlay" : "Compact overlay");
  });

  header.appendChild(titleEl);
  header.appendChild(toggleBtn);
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  // Attach drag listeners once per overlay lifetime (header is recreated each
  // render, so we use a flag on the overlay element to avoid duplicate listeners).
  if (!overlay.dataset.draggable) {
    overlay.dataset.draggable = "true";
    makeDraggable(overlay, header);
  }

  // --- Body ---
  if (nowPlaying === null) {
    // No song playing
    const msg = document.createElement("div");
    applyStyles(msg, STATUS_STYLES);
    msg.textContent = "No song currently playing";
    overlay.appendChild(msg);
    return;
  }

  if (lyricsStatus === "loading") {
    const spinner = document.createElement("div");
    applyStyles(spinner, STATUS_STYLES);
    spinner.setAttribute("data-testid", "loading-spinner");
    spinner.textContent = "⏳ Loading lyrics…";
    overlay.appendChild(spinner);
    return;
  }

  if (lyricsStatus === "found" && lyrics) {
    const body = document.createElement("div");
    applyStyles(body, BODY_STYLES);
    body.dataset.role = "lyrics-body";

    // Try to parse as LRC (synced lyrics)
    parsedLRC = parseLRC(lyrics);

    if (parsedLRC) {
      // Render each line as a separate <p> for highlighting
      parsedLRC.forEach((line, i) => {
        const p = document.createElement("p");
        p.dataset.lineIndex = String(i);
        p.textContent = line.text || "♪";
        p.title = "Click to jump here";
        Object.assign(p.style, {
          margin: "4px 0",
          padding: "3px 6px",
          borderRadius: "4px",
          transition: "color 0.2s, background 0.2s, font-size 0.2s",
          color: "#888",
          cursor: "pointer",
          lineHeight: "1.5",
        });
        p.addEventListener("click", () => {
          chrome.runtime.sendMessage({ type: "SEEK_TO", time: line.time });
        });
        body.appendChild(p);
      });
    } else {
      // Plain lyrics — just show as text
      body.textContent = lyrics;
    }

    overlay.appendChild(body);
    applyMode(overlay);
    return;
  }

  if (lyricsStatus === "not_found") {
    const msg = document.createElement("div");
    applyStyles(msg, STATUS_STYLES);
    msg.textContent = "Lyrics not found";
    overlay.appendChild(msg);
    return;
  }

  if (lyricsStatus === "error") {
    const msg = document.createElement("div");
    applyStyles(msg, STATUS_STYLES);
    msg.textContent = "Error fetching lyrics";
    overlay.appendChild(msg);
    return;
  }

  // idle / fallback
  const msg = document.createElement("div");
  applyStyles(msg, STATUS_STYLES);
  msg.textContent = "Waiting for a song to play…";
  overlay.appendChild(msg);
}

// Export for testability (Node/Jest environment)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderOverlay, getOrCreateOverlay, closeOverlay, makeDraggable, saveOverlayPrefs, loadOverlayPrefs, applyMode };
}

// Browser-only: wire up Chrome runtime messaging
if (typeof chrome !== "undefined" && chrome.runtime) {
  // Track the last known state so TOGGLE_OVERLAY can re-render it
  let lastKnownState = null;

  // Listen for state updates and toggle requests from background/popup
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "LYRICS_UPDATE") {
      lastKnownState = message.state;
      if (!message.state || message.state.lyricsStatus !== "found") {
        parsedLRC = null;
      }
      renderOverlay(message.state);
    } else if (message.type === "SYNC_UPDATE") {
      if (parsedLRC) {
        const body = document.querySelector(`#${OVERLAY_ID} [data-role="lyrics-body"]`);
        if (body) {
          const activeIdx = getActiveLine(parsedLRC, message.currentTime);
          const lines = body.querySelectorAll("[data-line-index]");
          lines.forEach((el, i) => {
            if (i === activeIdx) {
              Object.assign(el.style, {
                color: "#ffffff",
                fontWeight: "bold",
                fontSize: "15px",
                background: "rgba(160,196,255,0.12)",
              });
              el.scrollIntoView({ block: "center", behavior: "smooth" });
            } else if (i < activeIdx) {
              Object.assign(el.style, { color: "#555", fontWeight: "normal", fontSize: "14px", background: "" });
            } else {
              Object.assign(el.style, { color: "#888", fontWeight: "normal", fontSize: "14px", background: "" });
            }
          });
        }
      }
    } else if (message.type === "TOGGLE_OVERLAY") {
      const existing = document.getElementById(OVERLAY_ID);
      if (existing) {
        closeOverlay();
      } else if (lastKnownState) {
        renderOverlay(lastKnownState);
      }
    }
  });

  // On init, load saved prefs then fetch current state from background and render
  loadOverlayPrefs().then((prefs) => {
    // If the user previously dismissed the overlay, don't render it
    if (prefs && prefs.visible === false) return;

    // Restore saved mode before first render
    if (prefs && prefs.mode) {
      currentMode = prefs.mode;
    }

    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
      if (response && response.state) {
        lastKnownState = response.state;
        renderOverlay(response.state);

        // Apply saved position if available
        if (prefs && prefs.position) {
          const el = document.getElementById(OVERLAY_ID);
          if (el) {
            el.style.right = "";
            el.style.left = prefs.position.x + "px";
            el.style.top = prefs.position.y + "px";
          }
        }
      }
    });
  });
}
