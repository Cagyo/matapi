#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { validateToken } = require('./token-validator');
const { writeConfig } = require('./env-writer');
const { createSetupServer } = require('./server');

const INSTALL_DIR = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.PORT || '3000', 10);
const TIMEOUT_MS = 30 * 60 * 1000;

const envPath = path.join(INSTALL_DIR, '.env');
if (fs.existsSync(envPath)) {
  console.log('.env already exists — setup wizard is one-shot only.');
  process.exit(0);
}

const examplePath = path.join(INSTALL_DIR, '.env.example');
if (!fs.existsSync(examplePath)) {
  console.error('ERROR: .env.example not found. Repository appears corrupted.');
  process.exit(1);
}

let catalog = [];
try {
  catalog = require('../../config/feature-catalog.json');
} catch {
  console.warn('WARNING: Could not load config/feature-catalog.json. Proceeding with empty catalog.');
}

let localeCatalog = {};
try {
  ({ en: localeCatalog } = require('../../dist/locales/en'));
} catch {
  console.warn('WARNING: Could not load the setup-wizard locale catalog.');
}

const pairingSecret = randomBytes(32).toString('base64url');
try {
  const tty = fs.openSync('/dev/tty', 'w');
  try {
    fs.writeSync(tty, 'Setup pairing secret (enter it in the setup page):\n');
    fs.writeSync(tty, `${pairingSecret}\n`);
  } finally {
    fs.closeSync(tty);
  }
} catch {
  process.stderr.write('ERROR: setup requires an interactive terminal for pairing\n');
  process.exit(1);
}

let timer;
const server = createSetupServer({
  installDir: INSTALL_DIR,
  catalog,
  localeCatalog,
  pairingSecret,
  validateToken,
  writeConfig,
  onComplete: () => {
    console.log('Setup configuration written successfully. Shutting down wizard...');
    server.close();
    setTimeout(() => process.exit(0), 5000);
  },
});

server.on('request', () => {
  if (timer) timer.refresh();
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use. Is another instance running?`);
  } else {
    console.error('ERROR: Setup wizard server failed.');
  }
  process.exit(1);
});

timer = setTimeout(() => {
  console.log('Setup wizard timed out due to inactivity.');
  process.exit(1);
}, TIMEOUT_MS);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Setup wizard listening on http://127.0.0.1:${PORT}`);
});
