const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { renderStep1, renderStep2, renderDone, renderErrorPage } = require('./pages');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      body += chunk.toString();
      if (body.length > 1e6) {
        done = true;
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;

      const parsed = new URLSearchParams(body);
      const result = {};
      for (const [key, value] of parsed.entries()) {
        if (key === 'features') {
          if (!result.features) result.features = [];
          result.features.push(value);
        } else {
          result[key] = value;
        }
      }
      resolve(result);
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

function pairingMatches(value, expectedDigest) {
  if (typeof value !== 'string') return false;
  const actual = createHash('sha256').update(value).digest();
  return actual.length === expectedDigest.length && timingSafeEqual(actual, expectedDigest);
}

function requirePairing(body, expectedDigest, res) {
  if (pairingMatches(body.pairingSecret, expectedDigest)) return true;
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Forbidden');
  return false;
}

async function defaultCheckInternet() {
  try {
    await fetch('https://api.telegram.org', { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

function createSetupServer({
  installDir,
  catalog,
  pairingSecret,
  validateToken,
  writeConfig,
  onComplete,
  checkInternet = defaultCheckInternet,
}) {
  const pairingDigest = createHash('sha256').update(pairingSecret).digest();

  return http.createServer(async (req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      const online = await checkInternet();
      if (!online) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderErrorPage(
          'No Internet Connection',
          'Could not reach Telegram servers. Please connect your Raspberry Pi to WiFi or Ethernet and refresh this page.'
        ));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStep1());
      return;
    }

    if (req.method === 'GET' && (req.url === '/step-2' || req.url === '/finish')) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/api/validate-token') {
      try {
        const body = await parseBody(req);
        if (!requirePairing(body, pairingDigest, res)) return;

        const result = await validateToken(body.token || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Server error during validation' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/step-2') {
      try {
        const body = await parseBody(req);
        if (!requirePairing(body, pairingDigest, res)) return;

        if (!body.token || !body.token.trim()) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderStep2(body.token, body.botUsername || '', catalog, body.pairingSecret));
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderErrorPage('Server Error', 'Failed to load Step 2.'));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/finish') {
      try {
        const body = await parseBody(req);
        if (!requirePairing(body, pairingDigest, res)) return;

        const result = await validateToken(body.token || '');
        if (!result || result.ok !== true || typeof result.cleanedToken !== 'string') {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderErrorPage('Invalid Bot Token', result?.error || 'Invalid Telegram bot token.'));
          return;
        }

        const features = Array.isArray(body.features)
          ? body.features
          : (body.features ? [body.features] : []);
        const { claimAdminToken } = writeConfig(installDir, result.cleanedToken, features);

        res.once('finish', onComplete);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDone(body.botUsername || result.username || '', claimAdminToken));
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderErrorPage('Configuration Error', 'Failed to save configuration.'));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

module.exports = {
  createSetupServer,
  pairingMatches,
  requirePairing,
};
