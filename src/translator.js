/**
 * Translates text to English using the MyMemory API (free, no API key).
 * Splits long lyrics into chunks to stay within the 500-char limit per request.
 *
 * @param {string[]} lines - Array of lyric line strings
 * @returns {Promise<string[]>} - Translated lines in the same order
 */
async function translateLines(lines) {
  // Filter out empty/instrumental lines but keep their positions
  const CHUNK_SIZE = 10; // lines per request
  const results = new Array(lines.length).fill('');

  // Build chunks of non-empty lines
  const chunks = [];
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    chunks.push({ start: i, lines: lines.slice(i, i + CHUNK_SIZE) });
  }

  for (const chunk of chunks) {
    const text = chunk.lines.join('\n');
    if (!text.trim()) {
      chunk.lines.forEach((_, j) => { results[chunk.start + j] = chunk.lines[j]; });
      continue;
    }

    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|en`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const translated = data.responseData?.translatedText || text;
      const translatedLines = translated.split('\n');
      chunk.lines.forEach((orig, j) => {
        results[chunk.start + j] = translatedLines[j] || orig;
      });
    } catch (e) {
      // On error, keep original lines
      chunk.lines.forEach((orig, j) => { results[chunk.start + j] = orig; });
    }
  }

  return results;
}

if (typeof module !== 'undefined') module.exports = { translateLines };
