import { describe, expect, it, vi } from "vitest";
import {
  createOtaOperationRequest,
  type OperationJournal,
} from "../../../src/system/domain/ota-contracts";
import { OtaLocalRollbackService } from "../../../src/system/infrastructure/ota-local-rollback.service";
import type { OperationJournalTransitionUpdate } from "../../../src/system/infrastructure/dual-slot-operation-journal";

const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const CURRENT = `1.4.2-${"a".repeat(64)}`;
const PREVIOUS = `1.4.1-${"b".repeat(64)}`;
const TREE_SHA = "c".repeat(64);

function rollbackRequest() {
  return createOtaOperationRequest({
    operationId: OPERATION_ID,
    kind: "rollback",
    expected: null,
    acceptedAt: "2030-01-15T00:00:00.000Z",
  }).request;
}

describe("OtaLocalRollbackService", () => {
  it("initializes rollback independently from the update expected-identity flow", async () => {
    let started: OperationJournal | undefined;
    const activationStart = vi.fn(async () => undefined);
    const service = new OtaLocalRollbackService({
      requests: {
        load: vi.fn(async () => rollbackRequest()),
      },
      journal: {
        load: vi.fn(async () => null),
        start: vi.fn(async (input) => {
          started = { ...input, generation: 1, checksum: "e".repeat(64) };
          return started;
        }),
        transition: vi.fn(
          async (
            current: OperationJournal,
            phase: OperationJournal["phase"],
            update?: OperationJournalTransitionUpdate,
          ): Promise<OperationJournal> => ({
            ...current,
            generation: current.generation + 1,
            phase,
            preparedTreeSha256:
              update?.preparedTreeSha256 ?? current.preparedTreeSha256,
          }),
        ),
      },
      local: {
        capturePointers: vi.fn(async () => ({
          current: CURRENT,
          previous: PREVIOUS,
        })),
        validateKnownGood: vi.fn(async () => ({
          candidate: PREVIOUS,
          preparedTreeSha256: TREE_SHA,
        })),
      },
      handshake: { write: vi.fn(async () => undefined) },
      activation: { start: activationStart },
    });

    await service.run(OPERATION_ID, 3);

    expect(started).toMatchObject({
      kind: "rollback",
      expected: null,
      priorCurrent: CURRENT,
      priorPrevious: PREVIOUS,
      candidate: PREVIOUS,
    });
    expect(activationStart).toHaveBeenCalledWith(OPERATION_ID);
  });

  it("refuses rollback without a distinct previous known-good release", async () => {
    const journalStart = vi.fn();
    const service = new OtaLocalRollbackService({
      requests: {
        load: vi.fn(async () => rollbackRequest()),
      },
      journal: {
        load: vi.fn(async () => null),
        start: journalStart,
        transition: vi.fn(),
      },
      local: {
        capturePointers: vi.fn(async () => ({
          current: CURRENT,
          previous: null,
        })),
        validateKnownGood: vi.fn(),
      },
      handshake: { write: vi.fn() },
      activation: { start: vi.fn() },
    });

    await expect(service.run(OPERATION_ID, 3)).rejects.toMatchObject({
      code: "rollback",
    });
    expect(journalStart).not.toHaveBeenCalled();
  });
});
