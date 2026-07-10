import { describe, expect, it } from 'vitest';
import {
  ProcessShutdownGateway,
  type ProcessShutdownActions,
} from '../../../src/system/infrastructure/process-shutdown.gateway';

interface ActionFakes {
  actions: ProcessShutdownActions;
  order: string[];
  exitCodes: number[];
}

function createActionFakes(options: {
  prepareError?: Error;
  closeError?: Error;
  releaseLockError?: Error;
} = {}): ActionFakes {
  const order: string[] = [];
  const exitCodes: number[] = [];

  return {
    actions: {
      prepare: async () => {
        order.push('prepare');
        if (options.prepareError) throw options.prepareError;
      },
      closeApplication: async () => {
        order.push('close');
        if (options.closeError) throw options.closeError;
      },
      releaseLock: () => {
        order.push('release');
        if (options.releaseLockError) throw options.releaseLockError;
      },
      setExitCode: (code) => {
        order.push('exitCode');
        exitCodes.push(code);
      },
    },
    order,
    exitCodes,
  };
}

describe('ProcessShutdownGateway', () => {
  it('shares one shutdown promise across different signals and invokes each action once', async () => {
    const fakes = createActionFakes();
    const gateway = new ProcessShutdownGateway(fakes.actions);

    const termShutdown = gateway.run('SIGTERM');
    const interruptShutdown = gateway.run('SIGINT');

    expect(interruptShutdown).toBe(termShutdown);
    await termShutdown;

    expect(fakes.order).toEqual(['prepare', 'close', 'release', 'exitCode']);
  });

  it('orders preparation, application close, lock release, and exit-code assignment', async () => {
    const fakes = createActionFakes();
    const gateway = new ProcessShutdownGateway(fakes.actions);

    await gateway.run('SIGTERM');

    expect(fakes.order).toEqual(['prepare', 'close', 'release', 'exitCode']);
  });

  it('closes the application and releases the lock after preparation fails', async () => {
    const fakes = createActionFakes({ prepareError: new Error('preparation failed') });
    const gateway = new ProcessShutdownGateway(fakes.actions);

    await expect(gateway.run('SIGTERM')).resolves.toBeUndefined();

    expect(fakes.order).toEqual(['prepare', 'close', 'release', 'exitCode']);
  });

  it('releases the lock and sets exit code 1 after application close fails', async () => {
    const fakes = createActionFakes({ closeError: new Error('close failed') });
    const gateway = new ProcessShutdownGateway(fakes.actions);

    await expect(gateway.run('SIGTERM')).resolves.toBeUndefined();

    expect(fakes.order).toEqual(['prepare', 'close', 'release', 'exitCode']);
    expect(fakes.exitCodes).toEqual([1]);
  });

  it('contains a lock-release error and sets exit code 1', async () => {
    const fakes = createActionFakes({ releaseLockError: new Error('release failed') });
    const gateway = new ProcessShutdownGateway(fakes.actions);

    await expect(gateway.run('SIGTERM')).resolves.toBeUndefined();

    expect(fakes.order).toEqual(['prepare', 'close', 'release', 'exitCode']);
    expect(fakes.exitCodes).toEqual([1]);
  });

  it('sets exit code 0 when application close succeeds', async () => {
    const fakes = createActionFakes();
    const gateway = new ProcessShutdownGateway(fakes.actions);

    await gateway.run('SIGTERM');

    expect(fakes.exitCodes).toEqual([0]);
  });
});
