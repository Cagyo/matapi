import { Inject, Injectable } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import type { LocaleCatalog } from '../../locales';
import {
  TIMEZONE_OPTIONS,
  type TimezoneOptions,
} from '../../config/application/ports/timezone-options.port';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { ApplicationLogSnapshot } from '../../system/domain/application-log';

export interface ApplicationLogDocument {
  readonly filename: string;
  readonly caption: string;
  readonly content: Buffer;
}

@Injectable()
export class ApplicationLogDocumentPresenter {
  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(TIMEZONE_OPTIONS) private readonly timezone: TimezoneOptions,
  ) {}

  render(
    catalog: LocaleCatalog,
    snapshot: ApplicationLogSnapshot,
  ): ApplicationLogDocument {
    const copy = catalog.logs.application;
    const prefix = snapshot.stream === 'output' ? 'application_logs' : 'application_errors';
    const caption = snapshot.stream === 'output' ? copy.outputCaption : copy.errorCaption;
    const empty = snapshot.stream === 'output' ? copy.outputEmpty : copy.errorEmpty;
    const lines = snapshot.lines.length === 0 ? [empty] : [...snapshot.lines];
    if (snapshot.truncatedByByteLimit) lines.unshift(copy.truncated);
    const timestamp = formatInTimeZone(
      this.clock.now(), this.timezone.timezone, 'yyyy-MM-dd_HH-mm-ss',
    );
    return {
      filename: `${prefix}_${timestamp}.txt`,
      caption,
      content: Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
    };
  }
}
