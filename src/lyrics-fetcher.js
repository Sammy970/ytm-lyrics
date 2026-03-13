/**
 * Fetches lyrics for a given track from the LRCLib API.
 *
 * @param {{ title: string, artist: string }} track
 * @param {typeof fetch} fetchFn - injectable fetch for testing (defaults to global fetch)
 * @returns {Promise<{ status: "found"|"not_found"|"error", lyrics: string|null }>}
 */
async function fetchLyrics(track, fetchFn = fetch) {
  const RETRY_DELAYS = [500, 1000, 2000];
  const url =
    `https://lrclib.net/api/search` +
    `?track_name=${encodeURIComponent(track.title)}` +
    `&artist_name=${encodeURIComponent(track.artist)}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    let response;
    try {
      response = await fetchFn(url);
    } catch (networkError) {
      // Network-level failure (no response at all) — retry with backoff
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      // All retries exhausted
      return { status: "error", lyrics: null };
    }

    // 4xx responses → not found, no retry
    if (response.status >= 400 && response.status < 500) {
      return { status: "not_found", lyrics: null };
    }

    // Non-4xx HTTP errors (5xx, etc.) → treat as network error and retry
    if (!response.ok) {
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      return { status: "error", lyrics: null };
    }

    // Successful response
    const results = await response.json();

    if (!Array.isArray(results) || results.length === 0) {
      return { status: "not_found", lyrics: null };
    }

    const first = results[0];
    const lyrics = first.syncedLyrics || first.plainLyrics || null;

    if (!lyrics) {
      return { status: "not_found", lyrics: null };
    }

    return { status: "found", lyrics };
  }

  // Should never reach here, but satisfy linter
  return { status: "error", lyrics: null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchLyrics };
