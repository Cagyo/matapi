import { parseOtaOperationId } from "../domain/ota-contracts";
import type { OtaUpdaterService } from "./ota-updater.service";

export type OtaUpdaterFactory = () => OtaUpdaterService;

function parseArguments(args: readonly string[]): {
  operationId: string;
  handshakeFd: number;
} {
  if (
    args.length !== 4 ||
    args[0] !== "--operation-id" ||
    args[2] !== "--handshake-fd" ||
    !/^[1-9]\d*$/.test(args[3] ?? "")
  ) {
    throw new Error("invalid updater arguments");
  }
  const operationId = parseOtaOperationId(args[1]);
  const handshakeFd = Number(args[3]);
  if (!Number.isSafeInteger(handshakeFd) || handshakeFd !== 3) {
    throw new Error("invalid updater handshake fd");
  }
  return { operationId, handshakeFd };
}

export async function runOtaUpdaterEntry(
  args: readonly string[],
  factory: OtaUpdaterFactory,
): Promise<number> {
  try {
    const { operationId, handshakeFd } = parseArguments(args);
    await factory().run(operationId, handshakeFd);
    return 0;
  } catch {
    return 75;
  }
}

if (require.main === module) {
  // Production composition is installer-specific and must be provided by the
  // immutable release integration before this entry can accept an operation.
  process.exitCode = 75;
}
