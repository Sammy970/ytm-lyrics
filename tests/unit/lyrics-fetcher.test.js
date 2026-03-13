/**
 * Unit tests for src/lyrics-fetcher.js
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

const { fetchLyrics } = require('../../src/lyrics-fetcher');

// Speed up retry delays in tests
jest.useFakeTimers();

const TRACK = { title: 'Blinding Lights', artist: 'The Weeknd' };

/** Build a mock fetch that returns a successful JSON response */
function mockSuccess(results) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => results,
  });
}

/** Build a mock fetch that returns an HTTP error response */
function mockHttpError(status) {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  });
}

/** Build a mock fetch that always throws a network error */
function mockNetworkError() {
  return jest.fn().mockRejectedValue(new Error('Network failure'));
}

describe('fetchLyrics', () => {
  test('returns found status and lyrics on successful fetch', async () => {
    const fetchFn = mockSuccess([
      { plainLyrics: 'I been on my own...', syncedLyrics: null },
    ]);

    const promise = fetchLyrics(TRACK, fetchFn);
    // No retries needed — resolve immediately
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('found');
    expect(result.lyrics).toBe('I been on my own...');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('prefers syncedLyrics over plainLyrics when both present', async () => {
    const fetchFn = mockSuccess([
      {
        plainLyrics: 'plain text',
        syncedLyrics: '[00:01.00] synced text',
      },
    ]);

    const promise = fetchLyrics(TRACK, fetchFn);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('found');
    expect(result.lyrics).toBe('[00:01.00] synced text');
  });

  test('returns not_found when API returns empty array', async () => {
    const fetchFn = mockSuccess([]);

    const promise = fetchLyrics(TRACK, fetchFn);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('not_found');
    expect(result.lyrics).toBeNull();
  });

  test('returns not_found on 404 response without retrying', async () => {
    const fetchFn = mockHttpError(404);

    const promise = fetchLyrics(TRACK, fetchFn);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('not_found');
    expect(result.lyrics).toBeNull();
    // 4xx → no retry, exactly 1 call
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('retries exactly 3 times on network error then returns error status', async () => {
    const fetchFn = mockNetworkError();

    const promise = fetchLyrics(TRACK, fetchFn);
    // Advance through all three retry delays (500 + 1000 + 2000 ms)
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('error');
    expect(result.lyrics).toBeNull();
    // 1 initial attempt + 3 retries = 4 total calls
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  test('succeeds on second attempt after one network error', async () => {
    const fetchFn = jest.fn()
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [{ plainLyrics: 'Some lyrics', syncedLyrics: null }],
      });

    const promise = fetchLyrics(TRACK, fetchFn);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe('found');
    expect(result.lyrics).toBe('Some lyrics');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
