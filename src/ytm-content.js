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
  let pipLastActiveIdx = -1;
  let pipUserScrolledAt = 0;
  let pipRenderGeneration = 0;
  // Live playback tracking for 60fps karaoke fill interpolation
  let pipCurrentTime = 0;
  let pipCurrentTimeAt = 0;
  let pipIsPlaying = false;
  let pipKaraokeRafId = null;
  let pipKaraokeEnabled = true; // synced from chrome.storage

  let pipBlurEnabled = true;

  // Load and keep karaoke + blur preferences in sync
  chrome.storage.local.get(["karaokeMode", "blurMode"], (r) => {
    pipKaraokeEnabled = r.karaokeMode !== false;
    pipBlurEnabled    = r.blurMode    !== false;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.karaokeMode) pipKaraokeEnabled = changes.karaokeMode.newValue !== false;
    if (changes.blurMode)    pipBlurEnabled    = changes.blurMode.newValue    !== false;
  });

  // ---------------------------------------------------------------------------
  // Audio analyser — taps the YTM <video> element for real bass energy
  // ---------------------------------------------------------------------------
  let audioCtx = null;
  let analyserNode = null;
  let freqData = null;
  let smoothedEnergy = 0; // 0–1, smoothed bass energy used to drive thumbnail scale

  function setupAudioAnalyser(video) {
    if (analyserNode) return; // already set up
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaElementSource(video);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.75;
      source.connect(analyserNode);
      source.connect(audioCtx.destination); // keep audio playing
      freqData = new Uint8Array(analyserNode.frequencyBinCount);
      startVisualiserLoop();
    } catch (e) {
      console.warn("[visualiser] AudioContext failed:", e.message);
      analyserNode = null;
    }
  }

  function getBassEnergy() {
    if (!analyserNode || !freqData) return 0;
    analyserNode.getByteFrequencyData(freqData);
    // Bass = roughly first 8 bins (0–200Hz at 256 fftSize / 44100Hz sample rate)
    const bassBins = 8;
    let sum = 0;
    for (let i = 0; i < bassBins; i++) sum += freqData[i];
    return sum / (bassBins * 255); // 0–1
  }

  function startVisualiserLoop() {
    function loop() {
      const raw = getBassEnergy();
      // Smooth: fast attack (0.4), slow decay (0.08)
      smoothedEnergy += raw > smoothedEnergy
        ? (raw - smoothedEnergy) * 0.4
        : (raw - smoothedEnergy) * 0.08;

      const scale = 1 + smoothedEnergy * 0.18; // max ~1.18× at full bass
      const glow = Math.round(smoothedEnergy * 255);

      // Update PiP thumbnail
      if (pipWindow && !pipWindow.closed) {
        const thumb = pipWindow.document.getElementById("pip-thumb");
        if (thumb) {
          thumb.style.transform = `scale(${scale.toFixed(3)})`;
          thumb.style.boxShadow = `0 2px ${8 + Math.round(smoothedEnergy * 20)}px rgba(${glow},${Math.round(glow*0.6)},${Math.round(glow*0.9)},${(0.3 + smoothedEnergy * 0.6).toFixed(2)})`;
        }
      }

      // Update overlay thumbnail (same page context)
      const overlayThumb = document.getElementById("overlay-thumb");
      if (overlayThumb) {
        overlayThumb.style.transform = `scale(${scale.toFixed(3)})`;
        overlayThumb.style.boxShadow = `0 2px ${6 + Math.round(smoothedEnergy * 16)}px rgba(${glow},${Math.round(glow*0.6)},${Math.round(glow*0.9)},${(0.3 + smoothedEnergy * 0.6).toFixed(2)})`;
      }

      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------------
  // Album art color extraction
  // ---------------------------------------------------------------------------

  function getThumbnailUrl() {
    const img = document.querySelector("ytmusic-player-bar img#thumbnail") ||
                document.querySelector("ytmusic-player-bar .thumbnail img") ||
                document.querySelector("ytmusic-player-bar img");
    return img ? img.src : null;
  }

  // Extracts dominant vivid color from raw pixel data (Uint8ClampedArray).
  function extractDominantColor(data) {
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
      if (score > bestScore) {
        bestScore = score;
        bestR = r; bestG = g; bestB = b;
      }
    }
    return bestScore > 0 ? { r: bestR, g: bestG, b: bestB } : FALLBACK;
  }

  // Fetches the thumbnail as a blob (bypasses CORS) then draws it onto a canvas
  // to extract the dominant color. Returns a Promise<{r,g,b}>.
  async function getDominantColorFromUrl(url) {
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
            canvas.width = 24;
            canvas.height = 24;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, 24, 24);
            const data = ctx.getImageData(0, 0, 24, 24).data;
            resolve(extractDominantColor(data));
          } catch {
            resolve(FALLBACK);
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        };
        img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(FALLBACK); };
        img.src = blobUrl;
      });
    } catch {
      return FALLBACK;
    }
  }

  // Darkens an { r, g, b } color by a factor (0–1) for use as background
  function darken({ r, g, b }, factor) {
    return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
  }

  // Builds the animated gradient CSS for a header element and injects the keyframe
  // into the given document. Returns the CSS string to set as background.
  function applyHeaderGradientAnimation(doc, color) {
    const { r, g, b } = color;
    // Three stops: shifted hue, base darkened, accent-ish lifted
    const c1 = `rgb(${Math.round(r*0.25)},${Math.round(g*0.18)},${Math.round(b*0.35)})`; // deep shifted
    const c2 = `rgb(${Math.round(r*0.15)},${Math.round(g*0.22)},${Math.round(b*0.28)})`; // dark base
    const c3 = `rgb(${Math.round(Math.min(r*0.4,180))},${Math.round(Math.min(g*0.3,120))},${Math.round(Math.min(b*0.5,200))})`; // lifted

    // Remove any existing keyframe style
    const existing = doc.getElementById("pip-gradient-style");
    if (existing) existing.remove();

    const style = doc.createElement("style");
    style.id = "pip-gradient-style";
    style.textContent = `
      @keyframes pip-header-shift {
        0%   { background-position: 0% 50%; }
        50%  { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      #pip-header {
        background: linear-gradient(135deg, ${c1}, ${c2}, ${c3}, ${c1}) !important;
        background-size: 300% 300% !important;
        animation: pip-header-shift 6s ease infinite !important;
      }
      #pip-thumb {
        transition: transform 0.05s linear, box-shadow 0.05s linear;
      }
      @keyframes pip-line-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .pip-line-fade {
        opacity: 0;
        animation: pip-line-in 0.35s ease forwards;
      }
    `;
    doc.head.appendChild(style);
  }

  async function renderPiP(state) {
    if (!pipWindow || pipWindow.closed) return;

    // Stamp this render; if a newer renderPiP call starts while we await,
    // the stale one bails out before touching the DOM.
    const generation = ++pipRenderGeneration;

    // --- Extract album art color via blob fetch (bypasses CORS) ---
    const thumbUrl = getThumbnailUrl();
    const color = await getDominantColorFromUrl(thumbUrl);

    // Bail if a newer render started or the window closed during the fetch
    if (generation !== pipRenderGeneration || !pipWindow || pipWindow.closed) return;

    const doc = pipWindow.document;
    doc.body.innerHTML = "";

    const { r, g, b } = color;
    const colDark   = darken(color, 0.18);  // very dark for body bg top
    const colMid    = darken(color, 0.13);  // slightly lighter for body bg bottom
    const colPanel  = darken(color, 0.22);  // header/footer panels
    const colBorder = `rgba(${r},${g},${b},0.25)`;
    const colAccent = `rgb(${Math.min(r + 120, 255)},${Math.min(g + 120, 255)},${Math.min(b + 120, 255)})`;
    const colHighlight = `rgba(${r},${g},${b},0.28)`;

    // Body gradient from dark-color top to near-black bottom
    pipWindow.document.body.style.background =
      `linear-gradient(180deg, ${colDark} 0%, rgb(8,8,14) 100%)`;

    // --- Header: album art + track info ---
    applyHeaderGradientAnimation(doc, color);
    const header = doc.createElement("div");
    header.id = "pip-header";
    header.style.cssText = `padding:8px 12px;flex-shrink:0;border-bottom:1px solid ${colBorder};display:flex;align-items:center;gap:10px;`;

    // Album art thumbnail
    if (thumbUrl) {
      const thumb = doc.createElement("img");
      thumb.src = thumbUrl;
      thumb.id = "pip-thumb";
      thumb.style.cssText = "width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;";
      header.appendChild(thumb);
    }

    // Track title + artist stacked
    const trackInfo = doc.createElement("div");
    trackInfo.style.cssText = "flex:1;min-width:0;";

    const trackTitle = doc.createElement("div");
    trackTitle.style.cssText = `font-size:12px;font-weight:bold;color:${colAccent};word-break:break-word;`;
    trackTitle.textContent = state && state.nowPlaying ? state.nowPlaying.title : "YT Music Lyrics";

    const trackArtist = doc.createElement("div");
    trackArtist.style.cssText = "font-size:11px;color:rgba(255,255,255,0.5);margin-top:2px;word-break:break-word;";
    trackArtist.textContent = state && state.nowPlaying ? state.nowPlaying.artist : "";

    trackInfo.appendChild(trackTitle);
    if (state && state.nowPlaying) trackInfo.appendChild(trackArtist);
    header.appendChild(trackInfo);
    doc.body.appendChild(header);

    const body = doc.createElement("div");
    body.id = "pip-body";
    body.style.cssText = "flex:1;overflow-y:auto;padding:12px 14px;scroll-behavior:smooth;background:transparent;";
    body.addEventListener("scroll", () => {
      pipUserScrolledAt = Date.now();
    }, { passive: true });
    doc.body.appendChild(body);

    pipParsedLRC = null;
    pipLastActiveIdx = -1;
    pipUserScrolledAt = 0;

    const noLyrics = (text) => {
      body.style.cssText += "display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.35);font-style:italic;font-size:13px;";
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
          p.style.cssText = "margin:4px 0;padding:3px 8px;border-radius:4px;font-size:14px;line-height:1.6;color:rgba(255,255,255,0.25);cursor:pointer;transition:color 0.3s,background 0.3s,filter 0.4s;word-break:break-word;white-space:normal;";
          // Staggered fade-in: cap delay so it doesn't take forever on long lyrics
          p.classList.add("pip-line-fade");
          p.style.animationDelay = `${Math.min(i * 30, 600)}ms`;
          p.textContent = line.text || "♪";
          p.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "SEEK_TO", time: line.time + pipSongStartTime });
          });
          body.appendChild(p);
        });
      } else {
        body.style.cssText += "white-space:pre-wrap;font-size:13px;color:rgba(255,255,255,0.7);";
        body.textContent = state.lyrics;
      }
    }

    // Store accent colors on body so syncPiP can use them
    body.dataset.colAccent = colAccent;
    body.dataset.colHighlight = colHighlight;

    // --- Controls footer: ⏮  ⏯  ⏭ ---
    const footer = doc.createElement("div");
    footer.id = "pip-controls";
    footer.style.cssText = `background:${colPanel};border-top:1px solid ${colBorder};flex-shrink:0;display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 12px;`;

    const btnStyle = `background:none;border:none;color:${colAccent};font-size:20px;cursor:pointer;padding:4px 10px;border-radius:6px;transition:background 0.15s;line-height:1;`;
    const btnHoverBg = `rgba(${r},${g},${b},0.25)`;

    function makeCtrlBtn(icon, action, title) {
      const btn = doc.createElement("button");
      btn.textContent = icon;
      btn.title = title;
      btn.style.cssText = btnStyle;
      btn.addEventListener("mouseover", () => { btn.style.background = btnHoverBg; });
      btn.addEventListener("mouseout",  () => { btn.style.background = "none"; });
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "MEDIA_CONTROL", action });
      });
      return btn;
    }

    footer.appendChild(makeCtrlBtn("⏮", "prev", "Previous"));

    const playBtn = doc.createElement("button");
    playBtn.id = "pip-play-btn";
    playBtn.title = "Play / Pause";
    playBtn.style.cssText = btnStyle + "font-size:24px;";
    playBtn.textContent = (state && state.isPlaying) ? "⏸" : "▶";
    playBtn.addEventListener("mouseover", () => { playBtn.style.background = btnHoverBg; });
    playBtn.addEventListener("mouseout",  () => { playBtn.style.background = "none"; });
    playBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "MEDIA_CONTROL", action: "play-pause" });
    });
    footer.appendChild(playBtn);

    footer.appendChild(makeCtrlBtn("⏭", "next", "Next"));

    doc.body.appendChild(footer);
  }

  function pipKaraokeFrame() {
    if (!pipWindow || pipWindow.closed) { pipKaraokeRafId = null; return; }
    if (!pipParsedLRC) { pipKaraokeRafId = pipWindow.requestAnimationFrame(pipKaraokeFrame); return; }

    const body = pipWindow.document.getElementById("pip-body");
    if (!body) { pipKaraokeRafId = pipWindow.requestAnimationFrame(pipKaraokeFrame); return; }

    // Interpolate current song time at 60fps using drift from last known value
    const elapsed = pipIsPlaying ? (Date.now() - pipCurrentTimeAt) / 1000 : 0;
    const songTime = (pipCurrentTime + elapsed) - pipSongStartTime;
    const activeIdx = getActiveLine(pipParsedLRC, songTime);

    const colHighlight = body.dataset.colHighlight || "rgba(160,196,255,0.18)";
    const colAccent = body.dataset.colAccent || "#a0c4ff";

    const lineStart = pipParsedLRC[activeIdx].time;
    const lineEnd = pipParsedLRC[activeIdx + 1] ? pipParsedLRC[activeIdx + 1].time : lineStart + 5;
    const fillPct = Math.min(Math.max((songTime - lineStart) / Math.max(lineEnd - lineStart, 0.1), 0), 1) * 100;

    body.querySelectorAll("[data-line-index]").forEach((el, i) => {
      const dist = Math.abs(i - activeIdx);
      if (i === activeIdx) {
        el.style.background = colHighlight;
        el.style.fontWeight = "bold";
        el.style.fontSize = "15px";
        el.style.filter = "none";
        if (pipKaraokeEnabled) {
          el.style.backgroundImage = `linear-gradient(to right, #ffffff ${fillPct}%, rgba(255,255,255,0.2) ${fillPct}%)`;
          el.style.webkitBackgroundClip = "text";
          el.style.backgroundClip = "text";
          el.style.webkitTextFillColor = "transparent";
          el.style.color = "";
        } else {
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
        const blurPx = pipBlurEnabled ? Math.min(1 + (dist - 1) * 0.6, 2.5).toFixed(1) : 0;
        el.style.filter = blurPx > 0 ? `blur(${blurPx}px)` : "none";
        Object.assign(el.style, {
          color: i < activeIdx ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.35)",
          fontWeight: "normal",
          fontSize: "14px",
          background: "",
        });
      }
    });

    // Scroll: only when active line changes
    if (activeIdx !== pipLastActiveIdx) {
      const userJustScrolled = (Date.now() - pipUserScrolledAt) < 5000;
      const activeEl = body.querySelector(`[data-line-index="${activeIdx}"]`);
      if (activeEl && !userJustScrolled) {
        const targetTop = activeEl.offsetTop - (body.clientHeight / 2) + (activeEl.offsetHeight / 2);
        body.scrollTo({ top: targetTop, behavior: "smooth" });
      }
      pipLastActiveIdx = activeIdx;
    }

    pipKaraokeRafId = pipWindow.requestAnimationFrame(pipKaraokeFrame);
  }

  function syncPiP(currentTime, isPlaying) {
    if (!pipWindow || pipWindow.closed) return;

    // Update play/pause button icon
    const playBtn = pipWindow.document.getElementById("pip-play-btn");
    if (playBtn && typeof isPlaying === "boolean") {
      playBtn.textContent = isPlaying ? "⏸" : "▶";
    }

    // Record latest known time for rAF interpolation
    pipCurrentTime = currentTime;
    pipCurrentTimeAt = Date.now();
    pipIsPlaying = isPlaying;

    // Start the rAF loop if not already running
    if (!pipKaraokeRafId && pipWindow && !pipWindow.closed) {
      pipKaraokeRafId = pipWindow.requestAnimationFrame(pipKaraokeFrame);
    }
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
        width: 320,
        height: 420,
      });
      pipWindow.document.body.style.cssText = "margin:0;padding:0;background:#0d0d1a;color:#e0e0e0;font-family:Arial,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden;user-select:none;box-sizing:border-box;";
      // Make all elements use border-box so layout reflows correctly on resize
      const styleEl = pipWindow.document.createElement("style");
      styleEl.textContent = "*{box-sizing:border-box;}";
      pipWindow.document.head.appendChild(styleEl);
      await renderPiP(state);
      // Kick off 60fps karaoke loop immediately
      pipKaraokeRafId = null;
      if (pipWindow && !pipWindow.closed) {
        pipKaraokeRafId = pipWindow.requestAnimationFrame(pipKaraokeFrame);
      }
      pipWindow.addEventListener("pagehide", () => {
        pipKaraokeRafId = null; // rAF loop dies with the window, just clear the id
        pipWindow = null;
        pipParsedLRC = null;
        if (document.visibilityState === "visible") {
          pipEnabled = false;
        }
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
  // "enterpictureinpicture" is only supported in Chrome 116+ with the
  // Document PiP origin trial flag. Silently skip if unavailable.
  try {
    navigator.mediaSession.setActionHandler("enterpictureinpicture", () => {
      if (!pipEnabled) return;
      openPiPWindow(pipLastState);
    });
  } catch {
    // Not supported in this Chrome version — manual open via popup still works.
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
      const thumbnailUrl = getThumbnailUrl();
      safeSend({ type: 'NOW_PLAYING', track, songStartTime, thumbnailUrl });
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

  // --- Media control helpers ---
  // Clicks the matching button in YTM's player bar by its aria-label.
  function clickPlayerButton(ariaLabel) {
    const btn = document.querySelector(`ytmusic-player-bar [aria-label="${ariaLabel}"]`);
    if (btn) btn.click();
  }

  // --- Message listener: seek + PiP + media controls ---
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
      syncPiP(message.currentTime, message.isPlaying);
    } else if (message.type === "MEDIA_CONTROL") {
      const video = document.querySelector('video');
      if (message.action === "play-pause") {
        if (video) video.paused ? video.play() : video.pause();
      } else if (message.action === "next") {
        clickPlayerButton("Next");
      } else if (message.action === "prev") {
        clickPlayerButton("Previous");
      }
    }
  });

  // --- Playback state broadcast ---
  // Send play/pause state changes immediately so the PiP button stays in sync.
  function broadcastPlayState() {
    const video = document.querySelector('video');
    if (!video) return;
    safeSend({ type: 'PLAY_STATE', isPlaying: !video.paused });
  }

  // Attach play/pause listeners once the video element is ready
  function attachVideoListeners() {
    const video = document.querySelector('video');
    if (!video || video.dataset.ytmLyricsListening) return;
    video.dataset.ytmLyricsListening = "1";
    video.addEventListener("play",  broadcastPlayState);
    video.addEventListener("pause", broadcastPlayState);
    // AudioContext requires a user gesture before it can start — the video
    // playing means one has happened, so this is safe to call here.
    video.addEventListener("play", () => setupAudioAnalyser(video), { once: true });
    // If already playing when we attach, set up immediately
    if (!video.paused) setupAudioAnalyser(video);
  }

  // Safely send a chrome runtime message — returns false if context is gone.
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
      return true;
    } catch {
      return false;
    }
  }

  // --- Playback time sync ---
  // Send current video time every 500ms so the overlay can highlight the active lyric line.
  const timeInterval = setInterval(() => {
    attachVideoListeners();
    const video = document.querySelector('video');
    if (!video) return;
    const ok = safeSend({
      type: 'TIME_UPDATE',
      currentTime: video.currentTime,
      isPlaying: !video.paused,
    });
    if (!ok) clearInterval(timeInterval);
  }, 500);

  // --- Polling fallback ---

  // Poll every 2 seconds. If the observer is already covering changes this
  // is a no-op (tracksEqual guard prevents duplicate messages).
  const POLL_INTERVAL_MS = 2000;
  const pollInterval = setInterval(() => {
    if (!safeSend({ type: '_ping' })) { clearInterval(pollInterval); return; }
    checkAndNotify();
  }, POLL_INTERVAL_MS);

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
