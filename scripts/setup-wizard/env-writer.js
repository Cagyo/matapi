const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { cleanToken } = require('./token-validator');

function replaceOrAppendEnvLine(envContent, key, value) {
  const linePattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;

  if (linePattern.test(envContent)) {
    return envContent.replace(linePattern, line);
  }

  return `${envContent.trimEnd()}\n${line}\n`;
}

/**
 * Writes .env and features.json atomically.
 * Handles edge cases: missing .env.example (Fix 3a), disk full ENOSPC (Fix 3b),
 * and CRLF line normalization (Fix 3d).
 */
function writeConfig(
  installDir,
  token,
  enabledFeatures,
  claimAdminToken = randomBytes(24).toString('base64url')
) {
  const examplePath = path.join(installDir, '.env.example');

  // Fix 3a: Check for .env.example existence
  if (!fs.existsSync(examplePath)) {
    throw new Error('.env.example not found — is the repository intact?');
  }

  let rawExample;
  try {
    rawExample = fs.readFileSync(examplePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read .env.example: ${err.message}`);
  }

  // Fix 3d: Normalize line endings (CRLF -> LF)
  const normalizedExample = rawExample.replace(/\r\n/g, '\n');

  const cleanedToken = cleanToken(token);
  const envWithBotToken = replaceOrAppendEnvLine(
    normalizedExample,
    'TELEGRAM_BOT_TOKEN',
    cleanedToken
  );
  const envContent = replaceOrAppendEnvLine(
    envWithBotToken,
    'CLAIM_ADMIN_TOKEN',
    claimAdminToken
  );

  const featuresData = JSON.stringify(
    {
      enabled: Array.isArray(enabledFeatures) ? enabledFeatures : [],
      timestamp: new Date().toISOString(),
    },
    null,
    2
  ) + '\n';

  const envPath = path.join(installDir, '.env');
  const envTmpPath = path.join(installDir, '.env.tmp');
  const featuresPath = path.join(installDir, 'features.json');
  const featuresTmpPath = path.join(installDir, 'features.json.tmp');

  // Fix 3b: Try/catch with disk full (ENOSPC) handling around writes and renames
  try {
    fs.writeFileSync(envTmpPath, envContent, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(featuresTmpPath, featuresData, { encoding: 'utf-8', mode: 0o644 });

    fs.renameSync(envTmpPath, envPath);
    fs.renameSync(featuresTmpPath, featuresPath);

    // Ensure permissions on final .env
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // Ignore chmod failures on non-POSIX filesystems during dev
    }
  } catch (err) {
    // Clean up tmp files if they exist
    try { if (fs.existsSync(envTmpPath)) fs.unlinkSync(envTmpPath); } catch {}
    try { if (fs.existsSync(featuresTmpPath)) fs.unlinkSync(featuresTmpPath); } catch {}

    if (err.code === 'ENOSPC') {
      throw new Error('Disk full — free space on the SD card and re-run.');
    }
    throw new Error(`Failed to write configuration files: ${err.message}`);
  }

  return { claimAdminToken };
}

module.exports = {
  writeConfig,
};
