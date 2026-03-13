/**
 * Standalone lyrics window script.
 */

// --- LRC parser ---
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

// --- State ---
let parsedLRC = null;
let lastActiveIdx = -1;

const titleEl = document.getElementById('track-title');
const artistEl = document.getElementById('track-artist');
const lyricsBody = document.getElementById('lyrics-body');
const statusEl = document.getElementById('status');

// --- Render ---
function renderState(state) {
  if (!state || !state.nowPlaying) {
    titleEl.textContent = 'YT Music Lyrics';
    artistEl.textContent = '';
    lyricsBody.style.display = 'none';
    statusEl.style.display = 'flex';
    statusEl.textContent = 'No song currently playing';
    parsedLRC = null;
    return;
  }

  titleEl.textContent = state.nowPlaying.title;
  artistEl.textContent = state.nowPlaying.artist;

  if (state.lyricsStatus === 'loading') {
    lyricsBody.style.display = 'none';
    statusEl.style.display = 'flex';
    statusEl.textContent = '⏳ Loading lyrics…';
    parsedLRC = null;
    return;
  }

  if (state.lyricsStatus === 'not_found') {
    lyricsBody.style.display = 'none';
    statusEl.style.display = 'flex';
    statusEl.textContent = 'Lyrics not found';
    parsedLRC = null;
    return;
  }

  if (state.lyricsStatus === 'error') {
    lyricsBody.style.display = 'none';
    statusEl.style.display = 'flex';
    statusEl.textContent = 'Error fetching lyrics';
    parsedLRC = null;
    return;
  }

  if (state.lyricsStatus === 'found' && state.lyrics) {
    statusEl.style.display = 'none';
    lyricsBody.style.display = 'block';
    lyricsBody.innerHTML = '';
    lastActiveIdx = -1;

    parsedLRC = parseLRC(state.lyrics);

    if (parsedLRC) {
      parsedLRC.forEach((line, i) => {
        const p = document.createElement('p');
        p.dataset.lineIndex = String(i);
        p.dataset.orig = line.text;
        p.title = 'Click to jump here';
        p.style.cursor = 'pointer';

        const textNode = document.createTextNode(line.text || '♪');
        p.appendChild(textNode);

        p.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'SEEK_TO', time: line.time });
        });
        lyricsBody.appendChild(p);
      });
    } else {
      parsedLRC = null;
      state.lyrics.split('\n').forEach((line, i) => {
        const p = document.createElement('p');
        p.dataset.lineIndex = String(i);
        p.dataset.orig = line;
        p.style.color = '#ccc';
        p.style.cursor = 'default';
        p.textContent = line || ' ';
        lyricsBody.appendChild(p);
      });
    }
  }
}

// --- Sync highlight ---
function applySync(currentTime) {
  if (!parsedLRC) return;
  const activeIdx = getActiveLine(parsedLRC, currentTime);
  if (activeIdx === lastActiveIdx) return;
  lastActiveIdx = activeIdx;

  const lines = lyricsBody.querySelectorAll('p[data-line-index]');
  lines.forEach((el, i) => {
    el.classList.remove('active', 'past');
    if (i === activeIdx) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (i < activeIdx) {
      el.classList.add('past');
    }
  });
}

// --- Chrome messaging ---
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (response && response.state) renderState(response.state);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'LYRICS_UPDATE') {
    renderState(message.state);
  } else if (message.type === 'SYNC_UPDATE') {
    applySync(message.currentTime);
  }
});
