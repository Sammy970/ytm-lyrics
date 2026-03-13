/**
 * Unit tests for src/overlay-content.js — renderOverlay
 * Requirements: 3.2, 3.4, 3.5, 4.3, 4.6
 */

const {
  renderOverlay,
  getOrCreateOverlay,
  closeOverlay,
} = require('../../src/overlay-content');

const OVERLAY_ID = 'ytm-lyrics-overlay';

afterEach(() => {
  // Clean up overlay between tests
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Status: nowPlaying === null
// ---------------------------------------------------------------------------
describe('renderOverlay — nowPlaying is null', () => {
  test('shows "No song currently playing" message', () => {
    renderOverlay({ nowPlaying: null, lyrics: null, lyricsStatus: 'idle' });
    expect(document.body.textContent).toContain('No song currently playing');
  });

  test('overlay is present in the DOM', () => {
    renderOverlay({ nowPlaying: null, lyrics: null, lyricsStatus: 'idle' });
    expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status: loading
// ---------------------------------------------------------------------------
describe('renderOverlay — lyricsStatus "loading"', () => {
  const state = {
    nowPlaying: { title: 'Blinding Lights', artist: 'The Weeknd' },
    lyrics: null,
    lyricsStatus: 'loading',
  };

  test('shows loading indicator', () => {
    renderOverlay(state);
    expect(document.body.textContent).toContain('Loading');
  });

  test('loading spinner element is present', () => {
    renderOverlay(state);
    expect(document.querySelector('[data-testid="loading-spinner"]')).not.toBeNull();
  });

  test('does not show lyrics text', () => {
    renderOverlay(state);
    expect(document.querySelector('[data-role="lyrics-body"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status: found
// ---------------------------------------------------------------------------
describe('renderOverlay — lyricsStatus "found"', () => {
  const lyrics = 'I been on my own for long enough\nMaybe you can show me how to love';
  const state = {
    nowPlaying: { title: 'Blinding Lights', artist: 'The Weeknd' },
    lyrics,
    lyricsStatus: 'found',
  };

  test('shows lyrics text', () => {
    renderOverlay(state);
    expect(document.body.textContent).toContain(lyrics);
  });

  test('lyrics body element is present', () => {
    renderOverlay(state);
    expect(document.querySelector('[data-role="lyrics-body"]')).not.toBeNull();
  });

  test('header shows track title and artist', () => {
    renderOverlay(state);
    expect(document.body.textContent).toContain('Blinding Lights');
    expect(document.body.textContent).toContain('The Weeknd');
  });
});

// ---------------------------------------------------------------------------
// Status: not_found
// ---------------------------------------------------------------------------
describe('renderOverlay — lyricsStatus "not_found"', () => {
  const state = {
    nowPlaying: { title: 'Unknown Song', artist: 'Unknown Artist' },
    lyrics: null,
    lyricsStatus: 'not_found',
  };

  test('shows "Lyrics not found" message', () => {
    renderOverlay(state);
    expect(document.body.textContent).toContain('Lyrics not found');
  });
});

// ---------------------------------------------------------------------------
// Close button
// ---------------------------------------------------------------------------
describe('close button', () => {
  test('clicking close button removes overlay from DOM', () => {
    renderOverlay({
      nowPlaying: { title: 'Song', artist: 'Artist' },
      lyrics: 'some lyrics',
      lyricsStatus: 'found',
    });

    const closeBtn = document.querySelector('button[aria-label="Close lyrics overlay"]');
    expect(closeBtn).not.toBeNull();

    closeBtn.click();

    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Z-index
// ---------------------------------------------------------------------------
describe('z-index', () => {
  test('overlay has maximum z-index value (2147483647)', () => {
    renderOverlay({ nowPlaying: null, lyrics: null, lyricsStatus: 'idle' });
    const overlay = document.getElementById(OVERLAY_ID);
    expect(overlay.style.zIndex).toBe('2147483647');
  });
});
