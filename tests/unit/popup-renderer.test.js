/**
 * Unit tests for src/popup.js — getStatusMessage
 * Requirements: 6.1, 6.3
 */

const { getStatusMessage } = require('../../src/popup');

describe('getStatusMessage', () => {
  test('returns non-empty string for lyricsStatus "not_found"', () => {
    const msg = getStatusMessage({ nowPlaying: { title: 'Song', artist: 'Artist' }, lyricsStatus: 'not_found' });
    expect(msg).toBeTruthy();
    expect(msg).toContain('not found');
  });

  test('returns non-empty string for lyricsStatus "error"', () => {
    const msg = getStatusMessage({ nowPlaying: { title: 'Song', artist: 'Artist' }, lyricsStatus: 'error' });
    expect(msg).toBeTruthy();
    expect(msg.toLowerCase()).toContain('error');
  });

  test('returns non-empty string for lyricsStatus "loading"', () => {
    const msg = getStatusMessage({ nowPlaying: { title: 'Song', artist: 'Artist' }, lyricsStatus: 'loading' });
    expect(msg).toBeTruthy();
    expect(msg.toLowerCase()).toContain('loading');
  });

  test('returns empty string for lyricsStatus "found" (lyrics shown directly)', () => {
    const msg = getStatusMessage({ nowPlaying: { title: 'Song', artist: 'Artist' }, lyricsStatus: 'found' });
    expect(msg).toBe('');
  });

  test('returns "No song currently playing" when state is null', () => {
    expect(getStatusMessage(null)).toBe('No song currently playing');
  });

  test('returns "No song currently playing" when nowPlaying is null', () => {
    expect(getStatusMessage({ nowPlaying: null, lyricsStatus: 'idle' })).toBe('No song currently playing');
  });

  test('returns non-empty string for lyricsStatus "idle"', () => {
    const msg = getStatusMessage({ nowPlaying: { title: 'Song', artist: 'Artist' }, lyricsStatus: 'idle' });
    expect(msg).toBeTruthy();
  });
});
