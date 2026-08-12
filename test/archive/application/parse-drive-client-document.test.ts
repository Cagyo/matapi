import { describe, expect, it } from 'vitest';
import { parseInstalledClient } from '../../../src/archive/application/use-cases/submit-drive-client.use-case';
import { DriveClientDocumentError } from '../../../src/archive/domain/errors/drive-client-document.error';

const installed = {
  installed: {
    client_id: '123456-device.apps.googleusercontent.com',
    client_secret: 'secret_12345678',
    project_id: 'home-worker',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: ['http://localhost'],
    future_metadata: { ignored: true },
  },
};

describe('parseInstalledClient', () => {
  it('accepts one BOM, whitespace, and inert installed metadata', () => {
    expect(parseInstalledClient(`\uFEFF  ${JSON.stringify(installed)}\n`)).toEqual({
      clientId: '123456-device.apps.googleusercontent.com',
      clientSecret: 'secret_12345678',
    });
  });

  it.each([
    ['not-json', 'malformed-json'],
    [JSON.stringify({ web: installed.installed }), 'unsupported-client-type'],
    [JSON.stringify({ installed: { client_id: 1, client_secret: 'secret_12345678' } }), 'invalid-credentials'],
    [JSON.stringify({ installed: { client_id: '123.apps.googleusercontent.com' } }), 'invalid-credentials'],
    [JSON.stringify({ desktop: installed.installed }), 'invalid-credentials'],
    [`\uFEFF\uFEFF${JSON.stringify(installed)}`, 'invalid-utf8'],
  ] as const)('classifies %s as %s', (document, reason) => {
    expect(() => parseInstalledClient(document)).toThrowError(
      expect.objectContaining<Partial<DriveClientDocumentError>>({ reason }),
    );
  });

  it('never lets uploaded endpoint metadata enter the returned credentials', () => {
    expect(parseInstalledClient(JSON.stringify(installed))).toStrictEqual({
      clientId: '123456-device.apps.googleusercontent.com',
      clientSecret: 'secret_12345678',
    });
  });
});
