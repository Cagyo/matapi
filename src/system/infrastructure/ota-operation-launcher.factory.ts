import type { OtaOperationLauncherPort } from "../domain/ports/ota-operation-launcher.port";
import { FlockOtaOperationLauncherAdapter } from "./flock-ota-operation-launcher.adapter";
import type {
  OtaConfig,
  OtaDiscoveryMode,
} from "./ota-discovery-config.loader";
import { StubOtaOperationLauncherAdapter } from "./stub-ota-operation-launcher.adapter";

export function otaOperationLauncherForMode(
  mode: OtaDiscoveryMode,
  config: OtaConfig,
): OtaOperationLauncherPort {
  return mode === "stub"
    ? new StubOtaOperationLauncherAdapter()
    : new FlockOtaOperationLauncherAdapter(config);
}
