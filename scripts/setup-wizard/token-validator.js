/**
 * Validates a Telegram Bot Token via the Telegram API (getMe).
 * Handles edge cases: whitespace/invisible chars (Fix 2a), rate limiting (Fix 2b),
 * and network/API availability errors (Fix 1b).
 */

function cleanToken(token) {
  if (typeof token !== 'string') return '';
  return token
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Strip BOM and zero-width characters
    .trim();
}

async function validateToken(rawToken, fetchImpl = globalThis.fetch) {
  const cleanedToken = cleanToken(rawToken);
  if (!cleanedToken) {
    return { ok: false, error: 'Bot token cannot be empty.' };
  }

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cleanedToken}/getMe`);
    
    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        error: 'Too many attempts — please wait a moment before trying again.',
      };
    }

    if (res.status >= 500) {
      return {
        ok: false,
        status: res.status,
        error: 'Could not reach Telegram servers — check internet connection or try again.',
      };
    }

    const data = await res.json();
    if (!data.ok) {
      return {
        ok: false,
        status: res.status,
        error: data.description || 'Invalid Telegram bot token.',
      };
    }

    return {
      ok: true,
      cleanedToken,
      username: data.result.username,
      firstName: data.result.first_name,
    };
  } catch (err) {
    // Network error (fetch exception, offline, DNS failure)
    return {
      ok: false,
      networkError: true,
      error: 'Could not reach Telegram servers — check internet connection or try again.',
    };
  }
}

module.exports = {
  cleanToken,
  validateToken,
};
