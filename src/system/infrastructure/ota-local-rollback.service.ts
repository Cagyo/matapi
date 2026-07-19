import {
  parseOtaOperationId,
  parseOtaOperationRequest,
  type OperationJournal,
  type OtaOperationReceipt,
  type OtaOperationRequest,
} from "../domain/ota-contracts";
import type {
  OperationJournalInput,
  OperationJournalTransitionUpdate,
} from "./dual-slot-operation-journal";

export class OtaLocalRollbackError extends Error {
  constructor(readonly code: "rollback" | "maintenance-required") {
    super(code);
    this.name = "OtaLocalRollbackError";
  }
}

export interface OtaLocalRollbackDependencies {
  requests: {
    load(operationId: string): Promise<OtaOperationRequest>;
  };
  journal: {
    load(): Promise<OperationJournal | null>;
    start(input: OperationJournalInput): Promise<OperationJournal>;
    transition(
      current: OperationJournal,
      phase: OperationJournal["phase"],
      update?: OperationJournalTransitionUpdate,
    ): Promise<OperationJournal>;
  };
  local: {
    capturePointers(): Promise<{
      current: string | null;
      previous: string | null;
    }>;
    validateKnownGood(candidate: string): Promise<{
      candidate: string;
      preparedTreeSha256: string;
    }>;
  };
  handshake: {
    write(fd: number, receipt: OtaOperationReceipt): Promise<void>;
  };
  activation: {
    start(operationId: string): Promise<void>;
  };
}

function fail(code: OtaLocalRollbackError["code"]): never {
  throw new OtaLocalRollbackError(code);
}

export class OtaLocalRollbackService {
  constructor(private readonly dependencies: OtaLocalRollbackDependencies) {}

  async run(operationIdInput: string, handshakeFd: number): Promise<void> {
    const operationId = parseOtaOperationId(operationIdInput);
    const request = parseOtaOperationRequest(
      await this.dependencies.requests.load(operationId),
    );
    if (
      request.operationId !== operationId ||
      request.kind !== "rollback" ||
      request.expected !== null ||
      (await this.dependencies.journal.load()) !== null
    ) {
      fail("maintenance-required");
    }

    const pointers = await this.dependencies.local.capturePointers();
    if (
      pointers.current === null ||
      pointers.previous === null ||
      pointers.current === pointers.previous
    ) {
      fail("rollback");
    }
    const knownGood = await this.dependencies.local.validateKnownGood(
      pointers.previous,
    );
    if (
      knownGood.candidate !== pointers.previous ||
      !/^[0-9a-f]{64}$/.test(knownGood.preparedTreeSha256)
    ) {
      fail("maintenance-required");
    }

    const preparing = await this.dependencies.journal.start({
      schemaVersion: 1,
      operationId,
      kind: "rollback",
      phase: "preparing",
      expected: null,
      acceptedAt: request.acceptedAt,
      requestSha256: request.requestSha256,
      receiptGeneration: 1,
      priorCurrent: pointers.current,
      priorPrevious: pointers.previous,
      candidate: pointers.previous,
      preparedTreeSha256: null,
      diagnostics: { code: null, notes: [] },
      updatedAt: request.acceptedAt,
    });
    const prepared = await this.dependencies.journal.transition(
      preparing,
      "prepared",
      {
        preparedTreeSha256: knownGood.preparedTreeSha256,
        updatedAt: request.acceptedAt,
      },
    );
    await this.dependencies.handshake.write(handshakeFd, {
      schemaVersion: 1,
      operationId,
      kind: "rollback",
      acceptedAt: prepared.acceptedAt,
      requestSha256: prepared.requestSha256,
      receiptGeneration: prepared.receiptGeneration,
    });
    await this.dependencies.activation.start(operationId);
  }
}
