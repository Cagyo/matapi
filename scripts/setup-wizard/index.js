#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { querystring } = require('node:querystring');
const { validateToken } = require('./token-validator');
const { writeConfig } = require('./env-writer');
const { renderStep1, renderStep2, renderDone, renderErrorPage } = require('./pages');

const INSTALL_DIR = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.PORT || '3000', 10);
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity timeout

// One-shot guard: refuse to start if .env exists
const envPath = path.join(INSTALL_DIR, '.env');
if (fs.existsSync(envPath)) {
  console.log('.env already exists — setup wizard is one-shot only.');
  process.exit(0);
}

// Fix 3a: Check for .env.example
const examplePath = path.join(INSTALL_DIR, '.env.example');
if (!fs.existsSync(examplePath)) {
  console.error('ERROR: .env.example not found. Repository appears corrupted.');
  process.exit(1);
}

// Load catalog
let catalog = [];
try {
  catalog = require('../../config/feature-catalog.json');
} catch {
  console.warn('WARNING: Could not load config/feature-catalog.json. Proceeding with empty catalog.');
}

async function checkInternet() {
  try {
    const res = await fetch('https://api.telegram.org', { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      body += chunk.toString();
      if (body.length > 1e6) {
        done = true;
        req.destroy();
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
    req.on('error', err => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

let timer;
const server = http.createServer(async (req, res) => {
  if (timer) timer.refresh(); // reset inactivity timeout

  // Fix 4a: Handle favicon.ico cleanly
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    // Fix 1a: Check internet connectivity before showing Step 1
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

  // Fix 7b: Direct GET navigation to /step-2 or /finish redirects to Step 1
  if (req.method === 'GET' && (req.url === '/step-2' || req.url === '/finish')) {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/validate-token') {
    try {
      const body = await parseBody(req);
      const result = await validateToken(body.token || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Server error during validation' }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/step-2') {
    try {
      const body = await parseBody(req);
      // Fix 7b: Redirect if token missing
      if (!body.token || !body.token.trim()) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStep2(body.token, body.botUsername || '', catalog));
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderErrorPage('Server Error', 'Failed to load Step 2.'));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/finish') {
    try {
      const body = await parseBody(req);
      // Fix 7b: Redirect if token missing
      if (!body.token || !body.token.trim()) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

      const features = Array.isArray(body.features) ? body.features : (body.features ? [body.features] : []);
      const { claimAdminToken } = writeConfig(INSTALL_DIR, body.token, features);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDone(body.botUsername || '', claimAdminToken));

      console.log('Setup configuration written successfully. Shutting down wizard...');
      server.close();
      setTimeout(() => {
        process.exit(0);
      }, 5000);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderErrorPage('Configuration Error', err.message || 'Failed to save configuration.'));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Handle port conflicts cleanly (Fix 6b)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use. Is another instance running?`);
    process.exit(1);
  }
  console.error('Setup wizard server error:', err);
  process.exit(1);
});

timer = setTimeout(() => {
  console.log('Setup wizard timed out due to inactivity.');
  process.exit(1);
}, TIMEOUT_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Setup wizard running on http://0.0.0.0:${PORT}`);
});
