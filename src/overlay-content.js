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

const CONTROLS_STYLES = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  padding: "6px 10px",
  backgroundColor: "#16213e",
  borderTop: "1px solid #1e2d50",
  flexShrink: "0",
};

const CTRL_BTN_STYLES = {
  background: "none",
  border: "none",
  color: "#a0c4ff",
  fontSize: "16px",
  cursor: "pointer",
  padding: "3px 10px",
  borderRadius: "5px",
  lineHeight: "1",
  flexShrink: "0",
};

const STATUS_STYLES = {
  padding: "12px 14px",
  color: "#aaa",
  fontStyle: "italic",
  textAlign: "center",
};

// ---------------------------------------------------------------------------
// Album art color extraction (same approach as ytm-content.js — blob fetch
// bypasses CORS so getImageData works on cross-origin thumbnail URLs)
// ---------------------------------------------------------------------------

function overlayExtractDominantColor(data) {
  const FALLBACK = { r: 22, g: 33, b: 62 };
  let bestR = 0, bestG = 0, bestB = 0, bestScore = -1;
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    const score = s * (1 - Math.abs(l - 0.45));
    if (score > bestScore) { bestScore = score; bestR = r; bestG = g; bestB = b; }
  }
  return bestScore > 0 ? { r: bestR, g: bestG, b: bestB } : FALLBACK;
}

async function overlayGetDominantColor(url) {
  const FALLBACK = { r: 22, g: 33, b: 62 };
  if (!url) return FALLBACK;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return FALLBACK;
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 24; canvas.height = 24;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, 24, 24);
          resolve(overlayExtractDominantColor(ctx.getImageData(0, 0, 24, 24).data));
        } catch { resolve(FALLBACK); }
        finally { URL.revokeObjectURL(blobUrl); }
      };
      img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(FALLBACK); };
      img.src = blobUrl;
    });
  } catch { return FALLBACK; }
}

function overlayDarken({ r, g, b }, factor) {
  return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
}

// Injects/updates a <style> tag with the header gradient keyframe animation.
const OVERLAY_GRADIENT_STYLE_ID = "ytm-overlay-gradient-style";
function applyOverlayHeaderGradient(color) {
  const { r, g, b } = color;
  const c1 = `rgb(${Math.round(r*0.25)},${Math.round(g*0.18)},${Math.round(b*0.35)})`;
  const c2 = `rgb(${Math.round(r*0.15)},${Math.round(g*0.22)},${Math.round(b*0.28)})`;
  const c3 = `rgb(${Math.round(Math.min(r*0.4,180))},${Math.round(Math.min(g*0.3,120))},${Math.round(Math.min(b*0.5,200))})`;

  let style = document.getElementById(OVERLAY_GRADIENT_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = OVERLAY_GRADIENT_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `
    @keyframes overlay-header-shift {
      0%   { background-position: 0% 50%; }
      50%  { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    #${OVERLAY_ID} [data-role="overlay-header"] {
      background: linear-gradient(135deg, ${c1}, ${c2}, ${c3}, ${c1}) !important;
      background-size: 300% 300% !important;
      animation: overlay-header-shift 6s ease infinite !important;
    }
    #${OVERLAY_ID} #overlay-thumb {
      transition: transform 0.05s linear, box-shadow 0.05s linear;
    }
  `;
}

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
// video.currentTime at the moment the current song's lyrics were loaded.
// All incoming currentTime values are offset by this to get song-relative time.
let parsedLRCSongStartTime = 0;
// Last highlighted line index — used to skip scrollIntoView when line hasn't changed
let overlayLastActiveIdx = -1;
// Timestamp of the last user scroll in the overlay — auto-scroll pauses for 5s after
let overlayUserScrolledAt = 0;
// Incremented on each renderOverlay call to cancel stale async renders
let overlayRenderGeneration = 0;
// Cached accent colors from last color extraction, used by SYNC_UPDATE
let overlayColHighlight = "rgba(160,196,255,0.18)";
// Live playback state for 60fps karaoke interpolation
let overlayCurrentTime = 0;
let overlayCurrentTimeAt = 0;
let overlayIsPlaying = false;
let overlayKaraokeRafId = null;
let overlayKaraokeEnabled = true; // synced from chrome.storage

let currentMode = "expanded";

/**
 * Applies the current mode's height/overflow constraints to the overlay.
 *
 * @param {HTMLElement} overlay
 */
function applyMode(overlay) {
  if (currentMode === "compact") {
    // No fixed maxHeight — let content dictate height (header + active line + controls)
    overlay.style.maxHeight = "";
    const body = overlay.querySelector("[data-role='lyrics-body']");
    if (body) {
      body.style.overflowY = "hidden";
      body.style.padding = "6px 14px";
      body.dataset.compact = "true";
      // Hide all lines; SYNC_UPDATE will show only the active one
      body.querySelectorAll("[data-line-index]").forEach((el) => {
        el.style.display = "none";
        el.style.whiteSpace = "";
        el.style.overflow = "";
        el.style.textOverflow = "";
      });
    }
  } else {
    overlay.style.maxHeight = "480px";
    const body = overlay.querySelector("[data-role='lyrics-body']");
    if (body) {
      body.style.overflowY = "auto";
      body.style.padding = "10px";
      delete body.dataset.compact;
      // Restore all lines visible
      body.querySelectorAll("[data-line-index]").forEach((el) => {
        el.style.display = "";
      });
    }
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
async function renderOverlay(state) {
  const { nowPlaying, lyrics, lyricsStatus } = state;

  // Stamp generation — bail if a newer render starts while we await color
  const generation = ++overlayRenderGeneration;
  const color = await overlayGetDominantColor(state.thumbnailUrl || null);
  if (generation !== overlayRenderGeneration) return;

  const { r, g, b } = color;
  const colPanel     = overlayDarken(color, 0.20);
  const colBorder    = `rgba(${r},${g},${b},0.3)`;
  const colAccent    = `rgb(${Math.min(r+120,255)},${Math.min(g+120,255)},${Math.min(b+120,255)})`;
  overlayColHighlight = `rgba(${r},${g},${b},0.28)`;

  const overlay = getOrCreateOverlay();

  // Apply gradient background to the overlay container
  overlay.style.background = `linear-gradient(180deg, ${overlayDarken(color, 0.22)} 0%, ${overlayDarken(color, 0.12)} 100%)`;
  overlay.style.backgroundColor = "";

  // Inject animated header gradient keyframe
  applyOverlayHeaderGradient(color);

  // Clear previous content
  overlay.innerHTML = "";

  // --- Header ---
  const header = document.createElement("div");
  applyStyles(header, HEADER_STYLES);
  header.dataset.role = "overlay-header";
  header.style.borderBottom = `1px solid ${colBorder}`;
  header.dataset.dragHandle = "true";

  // Album art thumbnail
  if (state.thumbnailUrl) {
    const thumb = document.createElement("img");
    thumb.src = state.thumbnailUrl;
    thumb.id = "overlay-thumb";
    thumb.style.cssText = "width:36px;height:36px;border-radius:5px;object-fit:cover;flex-shrink:0;margin-right:8px;";
    header.appendChild(thumb);
  }

  // Title + artist stacked, fills remaining space
  const trackInfo = document.createElement("div");
  trackInfo.style.cssText = "flex:1;min-width:0;overflow:hidden;";

  const titleEl = document.createElement("p");
  applyStyles(titleEl, TITLE_STYLES);
  titleEl.style.color = colAccent;
  titleEl.style.margin = "0";
  if (nowPlaying) {
    titleEl.textContent = nowPlaying.title;
    titleEl.title = `${nowPlaying.title} — ${nowPlaying.artist}`;
  } else {
    titleEl.textContent = "YT Music Lyrics";
  }

  const artistEl = document.createElement("p");
  Object.assign(artistEl.style, {
    margin: "0",
    fontSize: "11px",
    color: "rgba(255,255,255,0.5)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  artistEl.textContent = nowPlaying ? nowPlaying.artist : "";

  trackInfo.appendChild(titleEl);
  if (nowPlaying) trackInfo.appendChild(artistEl);
  header.appendChild(trackInfo);

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
  } else if (lyricsStatus === "found" && lyrics) {
    const body = document.createElement("div");
    applyStyles(body, BODY_STYLES);
    body.dataset.role = "lyrics-body";

    parsedLRC = parseLRC(lyrics);

    if (parsedLRC) {
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
          chrome.runtime.sendMessage({ type: "SEEK_TO", time: line.time + parsedLRCSongStartTime });
        });
        body.appendChild(p);
      });
    } else {
      body.textContent = lyrics;
    }

    body.addEventListener("scroll", () => {
      overlayUserScrolledAt = Date.now();
    }, { passive: true });

    overlay.appendChild(body);
    applyMode(overlay);
    overlayLastActiveIdx = -1;
    overlayUserScrolledAt = 0;
    // Start 60fps karaoke loop
    overlayKaraokeRafId = null;
    overlayKaraokeRafId = requestAnimationFrame(overlayKaraokeFrame);
  } else if (lyricsStatus === "not_found") {
    const msg = document.createElement("div");
    applyStyles(msg, STATUS_STYLES);
    msg.textContent = "Lyrics not found";
    overlay.appendChild(msg);
  } else if (lyricsStatus === "error") {
    const msg = document.createElement("div");
    applyStyles(msg, STATUS_STYLES);
    msg.textContent = "Error fetching lyrics";
    overlay.appendChild(msg);
  } else {
    const msg = document.createElement("div");
    applyStyles(msg, STATUS_STYLES);
    msg.textContent = "Waiting for a song to play…";
    overlay.appendChild(msg);
  }

  // --- Controls footer (shown whenever a song is playing) ---
  const controls = document.createElement("div");
  applyStyles(controls, CONTROLS_STYLES);
  controls.style.backgroundColor = colPanel;
  controls.style.borderTop = `1px solid ${colBorder}`;

  const btnHoverBg = `rgba(${r},${g},${b},0.25)`;

  function makeOverlayCtrlBtn(icon, action, label, extraStyles) {
    const btn = document.createElement("button");
    applyStyles(btn, CTRL_BTN_STYLES);
    btn.style.color = colAccent;
    if (extraStyles) applyStyles(btn, extraStyles);
    btn.textContent = icon;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("mouseover", () => { btn.style.background = btnHoverBg; });
    btn.addEventListener("mouseout",  () => { btn.style.background = "none"; });
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "MEDIA_CONTROL", action });
    });
    return btn;
  }

  controls.appendChild(makeOverlayCtrlBtn("⏮", "prev", "Previous"));

  const playPauseBtn = document.createElement("button");
  applyStyles(playPauseBtn, CTRL_BTN_STYLES);
  applyStyles(playPauseBtn, { fontSize: "18px", padding: "3px 12px" });
  playPauseBtn.style.color = colAccent;
  playPauseBtn.id = "overlay-play-btn";
  playPauseBtn.setAttribute("aria-label", "Play / Pause");
  playPauseBtn.textContent = (state && state.isPlaying) ? "⏸" : "▶";
  playPauseBtn.addEventListener("mouseover", () => { playPauseBtn.style.background = btnHoverBg; });
  playPauseBtn.addEventListener("mouseout",  () => { playPauseBtn.style.background = "none"; });
  playPauseBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "MEDIA_CONTROL", action: "play-pause" });
  });
  controls.appendChild(playPauseBtn);

  controls.appendChild(makeOverlayCtrlBtn("⏭", "next", "Next"));

  overlay.appendChild(controls);
}

function overlayKaraokeFrame() {
  if (!parsedLRC) { overlayKaraokeRafId = requestAnimationFrame(overlayKaraokeFrame); return; }
  const body = document.querySelector(`#${OVERLAY_ID} [data-role="lyrics-body"]`);
  if (!body) { overlayKaraokeRafId = requestAnimationFrame(overlayKaraokeFrame); return; }

  const isCompact = body.dataset.compact === "true";
  const elapsed = overlayIsPlaying ? (Date.now() - overlayCurrentTimeAt) / 1000 : 0;
  const songTime = (overlayCurrentTime + elapsed) - parsedLRCSongStartTime;
  const activeIdx = getActiveLine(parsedLRC, songTime);

  const lineStart = parsedLRC[activeIdx].time;
  const lineEnd = parsedLRC[activeIdx + 1] ? parsedLRC[activeIdx + 1].time : lineStart + 5;
  const fillPct = Math.min(Math.max((songTime - lineStart) / Math.max(lineEnd - lineStart, 0.1), 0), 1) * 100;

  body.querySelectorAll("[data-line-index]").forEach((el, i) => {
    if (i === activeIdx) {
      el.style.display = "";
      el.style.fontWeight = "bold";
      el.style.fontSize = "15px";
      el.style.background = isCompact ? "" : overlayColHighlight;
      if (!isCompact && overlayKaraokeEnabled) {
        // Karaoke fill mode
        el.style.backgroundImage = `linear-gradient(to right, #ffffff ${fillPct}%, rgba(255,255,255,0.2) ${fillPct}%)`;
        el.style.webkitBackgroundClip = "text";
        el.style.backgroundClip = "text";
        el.style.webkitTextFillColor = "transparent";
        el.style.color = "";
      } else {
        // Plain highlight mode
        el.style.backgroundImage = "";
        el.style.webkitBackgroundClip = "";
        el.style.backgroundClip = "";
        el.style.webkitTextFillColor = "";
        el.style.color = "#fff";
      }
    } else {
      el.style.backgroundImage = "";
      el.style.webkitBackgroundClip = "";
      el.style.backgroundClip = "";
      el.style.webkitTextFillColor = "";
      if (isCompact) {
        el.style.display = "none";
      } else {
        Object.assign(el.style, {
          display: "",
          color: i < activeIdx ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.5)",
          fontWeight: "normal",
          fontSize: "14px",
          background: "",
        });
      }
    }
  });

  // Scroll only when active line changes
  if (activeIdx !== overlayLastActiveIdx) {
    const userJustScrolled = (Date.now() - overlayUserScrolledAt) < 5000;
    if (!isCompact && !userJustScrolled) {
      const activeEl = body.querySelector(`[data-line-index="${activeIdx}"]`);
      if (activeEl) {
        const targetTop = activeEl.offsetTop - (body.clientHeight / 2) + (activeEl.offsetHeight / 2);
        body.scrollTo({ top: targetTop, behavior: "smooth" });
      }
    }
    overlayLastActiveIdx = activeIdx;
  }

  overlayKaraokeRafId = requestAnimationFrame(overlayKaraokeFrame);
}

// Export for testability (Node/Jest environment)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderOverlay, getOrCreateOverlay, closeOverlay, makeDraggable, saveOverlayPrefs, loadOverlayPrefs, applyMode };
}

// Browser-only: wire up Chrome runtime messaging
if (typeof chrome !== "undefined" && chrome.runtime) {
  // Load karaoke preference
  chrome.storage.local.get("karaokeMode", (result) => {
    overlayKaraokeEnabled = result.karaokeMode !== false;
  });
  // Keep in sync if user changes it while overlay is open
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.karaokeMode) {
      overlayKaraokeEnabled = changes.karaokeMode.newValue !== false;
    }
  });

  // Track the last known state so TOGGLE_OVERLAY can re-render it
  let lastKnownState = null;

  // Listen for state updates and toggle requests from background/popup
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "LYRICS_UPDATE") {
      lastKnownState = message.state;
      if (!message.state || message.state.lyricsStatus !== "found") {
        parsedLRC = null;
        parsedLRCSongStartTime = 0;
      }
      renderOverlay(message.state);
      // When new lyrics load, record the video time offset from the state
      // so SYNC_UPDATE currentTime can be made song-relative.
      if (message.state && message.state.lyricsStatus === "found" && parsedLRC) {
        parsedLRCSongStartTime = message.state.songStartTime || 0;
      }
    } else if (message.type === "SYNC_UPDATE") {
      // Update play/pause icon
      if (typeof message.isPlaying === "boolean") {
        const playBtn = document.getElementById("overlay-play-btn");
        if (playBtn) playBtn.textContent = message.isPlaying ? "⏸" : "▶";
      }
      // Update interpolation state for 60fps karaoke rAF loop
      if (message.currentTime !== null) {
        overlayCurrentTime = message.currentTime;
        overlayCurrentTimeAt = Date.now();
        overlayIsPlaying = message.isPlaying;
        // Start rAF loop if not already running
        if (!overlayKaraokeRafId && parsedLRC) {
          overlayKaraokeRafId = requestAnimationFrame(overlayKaraokeFrame);
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
