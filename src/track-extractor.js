/**
 * Extracts the currently playing track from the YouTube Music player bar DOM.
 *
 * @param {Document} document - The page document to query
 * @returns {{ title: string, artist: string } | null}
 */
function extractNowPlaying(document) {
  const playerBar = document.querySelector('ytmusic-player-bar');
  if (!playerBar) return null;

  const titleEl = playerBar.querySelector('yt-formatted-string.title');
  const artistEl = playerBar.querySelector('yt-formatted-string.byline');

  if (!titleEl || !artistEl) return null;

  const title = titleEl.textContent.trim();
  const artist = artistEl.textContent.trim();

  if (!title || !artist) return null;

  return { title, artist };
}

module.exports = { extractNowPlaying };
