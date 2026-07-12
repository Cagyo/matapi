import { describe, expect, it } from 'vitest';
import * as pages from '../../scripts/setup-wizard/pages';
import { en } from '../../src/locales/en';

const { renderDone, renderStep1, renderStep2 } = pages;

describe('pairing forms', () => {
  it('collects the terminal pairing secret in Step 1 and includes it in token validation', () => {
    const html = renderStep1();

    expect(html).toContain('name="pairingSecret"');
    expect(html).toContain('required');
    expect(html).toContain("pairingSecret=' + encodeURIComponent(pairingSecret)");
    expect(html).not.toContain('action="/step-2?pairingSecret=');
  });

  it('escapes the pairing secret in the Step 2 hidden input instead of an action URL', () => {
    const pairingSecret = '<pairing&secret>';
    const html = renderStep2('bot-token', 'home_bot', [], pairingSecret);

    expect(html).toContain('name="pairingSecret" value="&lt;pairing&amp;secret&gt;"');
    expect(html).not.toContain('action="/finish?pairingSecret=');
    expect(html).not.toContain(pairingSecret);
  });

  it('leaves the experimental live-stream feature opt-in', () => {
    const html = renderStep2('bot-token', 'home_bot', [
      {
        name: 'rtsp',
        description: en.setupWizard.featureDescriptions.rtsp,
        defaultEnabled: false,
      },
    ]);

    expect(html).toContain('value="rtsp"');
    expect(html).not.toContain('value="rtsp" checked');
  });

  it('renders the live-stream description from the supplied locale catalog', () => {
    const liveStreamDescription = en.setupWizard.featureDescriptions.rtsp;
    const html = renderStep2(
      'bot-token',
      'home_bot',
      [{ name: 'rtsp', descriptionKey: 'rtsp', defaultEnabled: false }],
      '',
      { setupWizard: { featureDescriptions: { rtsp: liveStreamDescription } } },
    );

    expect(html).toContain(liveStreamDescription);
  });
});

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
