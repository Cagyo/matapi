import { Injectable } from '@nestjs/common';
import { ClockPort } from '../domain/ports/clock.port';

@Injectable()
export class SystemClockAdapter implements ClockPort {
  now(): Date {
    return new Date();
  }
}