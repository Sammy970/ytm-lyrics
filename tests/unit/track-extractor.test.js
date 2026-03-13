/**
 * Unit tests for src/track-extractor.js
 * Requirements: 1.1
 */

const { extractNowPlaying } = require('../../src/track-extractor');

/**
 * Helper: build a minimal YTM player bar DOM string and parse it.
 */
function buildDocument(title, artist) {
  const titleHtml = title != null
    ? `<yt-formatted-string class="title">${title}</yt-formatted-string>`
    : '';
  const artistHtml = artist != null
    ? `<yt-formatted-string class="byline">${artist}</yt-formatted-string>`
    : '';

  document.body.innerHTML = `
    <ytmusic-player-bar>
      ${titleHtml}
      ${artistHtml}
    </ytmusic-player-bar>
  `;
  return document;
}

describe('extractNowPlaying', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('returns title and artist from valid DOM', () => {
    const doc = buildDocument('Blinding Lights', 'The Weeknd');
    expect(extractNowPlaying(doc)).toEqual({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
    });
  });

  test('returns null when title element is missing', () => {
    const doc = buildDocument(null, 'The Weeknd');
    expect(extractNowPlaying(doc)).toBeNull();
  });

  test('returns null when artist element is missing', () => {
    const doc = buildDocument('Blinding Lights', null);
    expect(extractNowPlaying(doc)).toBeNull();
  });

  test('returns null when DOM is empty (no player bar)', () => {
    document.body.innerHTML = '';
    expect(extractNowPlaying(document)).toBeNull();
  });

  test('returns null when title text is empty', () => {
    const doc = buildDocument('', 'The Weeknd');
    expect(extractNowPlaying(doc)).toBeNull();
  });

  test('returns null when artist text is empty', () => {
    const doc = buildDocument('Blinding Lights', '');
    expect(extractNowPlaying(doc)).toBeNull();
  });

  test('trims whitespace from title and artist', () => {
    const doc = buildDocument('  Shape of You  ', '  Ed Sheeran  ');
    expect(extractNowPlaying(doc)).toEqual({
      title: 'Shape of You',
      artist: 'Ed Sheeran',
    });
  });
});
