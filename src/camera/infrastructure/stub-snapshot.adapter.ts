import { Injectable } from '@nestjs/common';
import { SnapshotPort } from '../domain/ports/snapshot.port';

// 1x1 transparent PNG — a valid image Telegram accepts in dev/test.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Dev/test `SnapshotPort`. Returns a tiny placeholder image. */
@Injectable()
export class StubSnapshotAdapter implements SnapshotPort {
  async grab(): Promise<Buffer> {
    return ONE_PX_PNG;
  }
}
