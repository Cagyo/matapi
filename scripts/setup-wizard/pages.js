/**
 * Setup Wizard HTML templates and inline JavaScript.
 * Handles edge cases: XSS via bot username (Fix 3c), double form submission (Fix 4c),
 * zero features confirmation (Fix 7a), and shutdown notice (Fix 4d).
 */

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderLayout(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Home Worker Setup</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --danger: #ef4444;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .wizard-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem;
      width: 100%;
      max-width: 540px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #fff; }
    p.subtitle { color: var(--text-muted); font-size: 0.925rem; margin-bottom: 1.75rem; }
    .form-group { margin-bottom: 1.5rem; }
    label { display: block; font-weight: 600; font-size: 0.875rem; margin-bottom: 0.5rem; }
    input[type="text"] {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #0b1120;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: #fff;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus { border-color: var(--primary); }
    .btn {
      display: inline-block;
      width: 100%;
      padding: 0.875rem;
      background: var(--primary);
      color: #fff;
      font-weight: 600;
      font-size: 0.95rem;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      text-align: center;
      transition: background 0.2s;
    }
    .btn:hover:not(:disabled) { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .alert {
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      margin-bottom: 1.5rem;
    }
    .alert-danger { background: rgba(239, 68, 68, 0.15); border: 1px solid var(--danger); color: #fca5a5; }
    .alert-success { background: rgba(16, 185, 129, 0.15); border: 1px solid var(--success); color: #6ee7b7; }
    .feature-list { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.75rem; }
    .feature-item {
      display: flex;
      align-items: flex-start;
      padding: 0.875rem 1rem;
      background: #0b1120;
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
    }
    .feature-item input { margin-top: 0.2rem; margin-right: 0.875rem; cursor: pointer; }
    .feature-info { display: flex; flex-direction: column; }
    .feature-title { font-weight: 600; font-size: 0.95rem; text-transform: capitalize; }
    .feature-desc { color: var(--text-muted); font-size: 0.825rem; }
  </style>
</head>
<body>
  <div class="wizard-card">
    ${content}
  </div>
</body>
</html>`;
}

function renderStep1(errorMessage = null) {
  const errorHtml = errorMessage ? `<div class="alert alert-danger" id="error-box">${escapeHtml(errorMessage)}</div>` : `<div class="alert alert-danger" id="error-box" style="display: none;"></div>`;

  const content = `
    <h1>Connect Telegram Bot</h1>
    <p class="subtitle">Step 1 of 2 — Enter the pairing secret shown in the Pi terminal, then your Bot Token from @BotFather</p>
    ${errorHtml}
    <div id="success-box" class="alert alert-success" style="display: none;"></div>
    <form id="token-form" action="/step-2" method="POST">
      <input type="hidden" id="hidden-token" name="token" value="">
      <input type="hidden" id="hidden-username" name="botUsername" value="">
      <div class="form-group">
        <label for="pairing-secret-input">Terminal Pairing Secret</label>
        <input type="text" id="pairing-secret-input" name="pairingSecret" autocomplete="off" required>
      </div>
      <div class="form-group">
        <label for="token-input">Bot Token</label>
        <input type="text" id="token-input" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz" autocomplete="off" required>
      </div>
      <button type="submit" id="submit-btn" class="btn">Validate & Continue</button>
    </form>
    <script>
      const form = document.getElementById('token-form');
      const input = document.getElementById('token-input');
      const pairingSecretInput = document.getElementById('pairing-secret-input');
      const btn = document.getElementById('submit-btn');
      const errBox = document.getElementById('error-box');
      const succBox = document.getElementById('success-box');
      const hiddenToken = document.getElementById('hidden-token');
      const hiddenUser = document.getElementById('hidden-username');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.style.display = 'none';
        succBox.style.display = 'none';
        btn.disabled = true;
        btn.textContent = 'Validating...';

        const token = input.value.trim();
        const pairingSecret = pairingSecretInput.value;
        try {
          const res = await fetch('/api/validate-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'token=' + encodeURIComponent(token) + '&pairingSecret=' + encodeURIComponent(pairingSecret)
          });
          const data = await res.json();
          if (!data.ok) {
            errBox.textContent = data.error || 'Invalid token';
            errBox.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Validate & Continue';
          } else {
            succBox.textContent = 'Found bot @' + data.username + ' (' + (data.firstName || '') + '). Proceeding...';
            succBox.style.display = 'block';
            hiddenToken.value = data.cleanedToken;
            hiddenUser.value = data.username;
            form.submit();
          }
        } catch (err) {
          errBox.textContent = 'Could not reach wizard API. Please try again.';
          errBox.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Validate & Continue';
        }
      });
    </script>
  `;
  return renderLayout('Connect Telegram Bot', content);
}

function renderStep2(token, botUsername, catalog = [], pairingSecret = '') {
  const safeToken = escapeHtml(token);
  const safeUser = escapeHtml(botUsername);
  const safePairingSecret = escapeHtml(pairingSecret);

  const featuresHtml = catalog.map(f => `
    <label class="feature-item">
      <input type="checkbox" name="features" value="${escapeHtml(f.name)}" checked>
      <span class="feature-info">
        <span class="feature-title">${escapeHtml(f.name)}</span>
        <span class="feature-desc">${escapeHtml(f.description)}</span>
      </span>
    </label>
  `).join('');

  const content = `
    <h1>Select Features</h1>
    <p class="subtitle">Step 2 of 2 — Configuring bot <b>@${safeUser}</b></p>
    <form id="step2-form" action="/finish" method="POST">
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="botUsername" value="${safeUser}">
      <input type="hidden" name="pairingSecret" value="${safePairingSecret}">
      <div class="feature-list">
        ${featuresHtml}
      </div>
      <button type="submit" id="finish-btn" class="btn">Finish Setup</button>
    </form>
    <script>
      const form = document.getElementById('step2-form');
      const btn = document.getElementById('finish-btn');
      form.addEventListener('submit', (e) => {
        const checked = form.querySelectorAll('input[name="features"]:checked').length;
        if (checked === 0) {
          const proceed = confirm("No features selected — the worker will start with no sensors enabled. Continue?");
          if (!proceed) {
            e.preventDefault();
            return;
          }
        }
        btn.disabled = true;
        btn.textContent = 'Saving configuration...';
      });
    </script>
  `;
  return renderLayout('Select Features', content);
}

function renderDone(botUsername, claimAdminToken) {
  const safeUser = escapeHtml(botUsername || 'your_bot');
  const safeClaimToken = escapeHtml(claimAdminToken);
  const content = `
    <h1>Setup Complete!</h1>
    <p class="subtitle">Configuration saved successfully.</p>
    <div class="alert alert-success">
      <b>Next Steps:</b>
      <p style="margin-top: 0.5rem; font-size: 0.875rem;">
        1. Terminal is installing feature dependencies... this may take a few minutes.<br>
        2. Once the terminal shows "Installation complete", send <code>/claim_admin ${safeClaimToken}</code> to <b>@${safeUser}</b> in Telegram.
      </p>
    </div>
    <p style="color: var(--text-muted); font-size: 0.825rem; text-align: center;">
      You can close this browser window.<br>
      <i>Note: This setup wizard server will stop responding in 5 seconds.</i>
    </p>
  `;
  return renderLayout('Setup Complete', content);
}

function renderErrorPage(title, message) {
  const content = `
    <h1>${escapeHtml(title)}</h1>
    <div class="alert alert-danger" style="margin-top: 1rem;">
      ${escapeHtml(message)}
    </div>
    <p style="color: var(--text-muted); font-size: 0.875rem;">
      Resolve the issue on the Raspberry Pi terminal and re-run the setup script.
    </p>
  `;
  return renderLayout(title, content);
}

module.exports = {
  escapeHtml,
  renderLayout,
  renderStep1,
  renderStep2,
  renderDone,
  renderErrorPage,
};
