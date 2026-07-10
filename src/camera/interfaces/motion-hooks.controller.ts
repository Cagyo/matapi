import { All, Controller, Logger, Query } from '@nestjs/common';
import { RecordMotionEndUseCase } from '../application/record-motion-end.use-case';
import { RecordMotionStartUseCase } from '../application/record-motion-start.use-case';
import { RecordSnapshotUseCase } from '../application/record-snapshot.use-case';

interface HookAck {
  ok: true;
}

/**
 * HTTP listener for Motion daemon hooks (spec 20). Motion's `on_event_start`,
 * `on_movie_end` and `on_picture_save` are configured to curl these routes on
 * the loopback interface. `@All` accepts both the GET curls in `motion.conf`
 * and the POSTs described in the spec. Every handler is best-effort: it
 * swallows errors and always returns `{ ok: true }` so Motion never blocks or
 * retries on a worker-side failure.
 */
@Controller('motion')
export class MotionHooksController {
  private readonly logger = new Logger(MotionHooksController.name);

  constructor(
    private readonly recordStart: RecordMotionStartUseCase,
    private readonly recordEnd: RecordMotionEndUseCase,
    private readonly recordSnapshot: RecordSnapshotUseCase,
  ) {}

  @All('event-start')
  async eventStart(@Query('camera') camera?: string): Promise<HookAck> {
    try {
      await this.recordStart.execute(camera);
    } catch (error) {
      this.logger.warn(`event-start hook failed: ${(error as Error).message}`);
    }
    return { ok: true };
  }

  @All('event-end')
  async eventEnd(
    @Query('camera') camera?: string,
    @Query('file') file?: string,
  ): Promise<HookAck> {
    return this.recordVideoEnd('event-end', camera, file);
  }

  @All('movie-end')
  async movieEnd(
    @Query('camera') camera?: string,
    @Query('file') file?: string,
  ): Promise<HookAck> {
    return this.recordVideoEnd('movie-end', camera, file);
  }

  private async recordVideoEnd(
    hook: 'event-end' | 'movie-end',
    camera?: string,
    file?: string,
  ): Promise<HookAck> {
    try {
      if (!file) {
        this.logger.warn(`${hook} hook missing file param — skipped`);
      } else {
        await this.recordEnd.execute(camera, file);
      }
    } catch (error) {
      this.logger.warn(`${hook} hook failed: ${(error as Error).message}`);
    }
    return { ok: true };
  }

  @All('snapshot')
  async snapshot(@Query('file') file?: string): Promise<HookAck> {
    try {
      if (!file) {
        this.logger.warn('snapshot hook missing file param — skipped');
      } else {
        await this.recordSnapshot.execute(file);
      }
    } catch (error) {
      this.logger.warn(`snapshot hook failed: ${(error as Error).message}`);
    }
    return { ok: true };
  }
}
