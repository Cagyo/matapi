import { describe, expect, it } from 'vitest';
import { catalogs } from '../../../src/locales';
import { ApplicationLogDocumentPresenter } from '../../../src/telegram/interfaces/application-log-document.presenter';

describe('ApplicationLogDocumentPresenter', () => {
  const presenter = new ApplicationLogDocumentPresenter(
    { now: () => new Date('2026-08-12T14:05:06.000Z') },
    { timezone: 'Europe/Kyiv' },
  );

  it.each([
    ['output', 'application_logs_2026-08-12_17-05-06.txt'],
    ['error', 'application_errors_2026-08-12_17-05-06.txt'],
  ] as const)('renders the distinct %s document', (stream, filename) => {
    const document = presenter.render(catalogs.en, {
      stream, lines: ['oldest', 'newest'], truncatedByByteLimit: false,
    });
    expect(document.filename).toBe(filename);
    expect(document.caption).toContain('200');
    expect(document.content.toString('utf8')).toBe('oldest\nnewest\n');
  });

  it('renders localized empty and truncation lines inside the document', () => {
    const document = presenter.render(catalogs.uk, {
      stream: 'error', lines: [], truncatedByByteLimit: true,
    });
    const text = document.content.toString('utf8');
    expect(text).toContain(catalogs.uk.logs.application.truncated);
    expect(text).toContain(catalogs.uk.logs.application.errorEmpty);
    expect(text.endsWith('\n')).toBe(true);
  });
});
