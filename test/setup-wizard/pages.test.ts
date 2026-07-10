import { describe, expect, it } from 'vitest';

const { renderDone } = require('../../scripts/setup-wizard/pages');

describe('renderDone', () => {
  it('escapes the claim token in the complete claim command', () => {
    const html = renderDone('home_bot', '<claim&token>');

    expect(html).toContain('/claim_admin &lt;claim&amp;token&gt;');
    expect(html).not.toContain('<claim&token>');
  });

  it('continues to escape a malicious bot username', () => {
    const maliciousUsername = '<img src=x onerror=alert(1)>';
    const html = renderDone(maliciousUsername, 'claim-token');

    expect(html).toContain('@&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain(maliciousUsername);
  });
});
