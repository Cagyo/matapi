# 27 — Wi-Fi Smart Plug Autodetection & Control

## Dependencies
- 01-database.md (sensors table, credential encryption pattern)
- 02-sensor-core.md (SensorRegistry, SensorDriverPort)
- 06-bot-core.md (WorkflowEntryCoordinator, TelegramHandler)
- ../architecture.md, ../dependency-injection.md

## Overview

This specification details the architecture for adding Wi-Fi-based smart plugs (e.g., Tapo, Kasa) to the system. Wi-Fi plugs require network communication rather than direct GPIO interrupt handling, introducing key requirements:
1. **Network Discovery & Fallback**: Automatic local network discovery (UDP broadcast) so users don't need to assign static IPs manually. If UDP discovery returns zero devices (due to AP isolation or router broadcast drops), manual IP address entry fallback is seamlessly provided.
2. **Modular Provider Pattern**: Multiple brands use different discovery protocols and control APIs. Discovery is decoupled via `DiscoveryProviderPort`.
3. **Dynamic IP Drift Resolution**: Wi-Fi smart plugs store factory MAC addresses in configuration. If a DHCP lease expires and assigns a new IP address, background resolution updates the active runtime target IP automatically.
4. **Actuation & Switch Control**: Smart plugs act as both sensors (reporting power/energy metrics) and actuators (relays toggling power `ON`/`OFF`).
5. **Credential Security**: Local device authentication credentials (e.g. Tapo accounts) are encrypted using AES-GCM prior to database storage, matching the `cameraLiveCredentials` pattern.
6. **Telegram Onboarding**: Discovered or manually specified devices are onboarded via an interactive `/discover` Telegram workflow using `WorkflowEntryCoordinator` and inline keyboards (not `grammY conversations`).

## 1. Discovery Provider Architecture

Discovery is abstracted into a new domain port, `DiscoveryProviderPort`.

```typescript
// src/sensors/domain/ports/sensor-discovery.port.ts

export interface DiscoveredDevice {
  id: string;          // Factory unique ID (MAC address)
  name: string;        // Factory default name (e.g., "Tapo P100")
  ip: string;          // Discovered or target local IP address
  mac?: string;        // Factory MAC address
  type: SensorType;    // The sensor type enum ('tapo-wifi' | 'kasa-wifi')
  provider: string;    // Identifier for the provider (e.g., 'tapo')
}

export interface DiscoveryProviderPort {
  readonly providerName: string;
  discover(timeoutMs: number): Promise<DiscoveredDevice[]>;
  verifyIp?(ip: string): Promise<DiscoveredDevice | null>;
}
```

The application layer hosts `SensorDiscoveryService`, which aggregates all registered `DiscoveryProviderPort` adapters.

```typescript
// src/sensors/application/sensor-discovery.service.ts
@Injectable()
export class SensorDiscoveryService {
  constructor(
    @Inject(DISCOVERY_PROVIDERS) private providers: DiscoveryProviderPort[]
  ) {}

  async discoverAll(timeoutMs = 15000): Promise<DiscoveredDevice[]> { ... }
  async verifyIp(ip: string): Promise<DiscoveredDevice | null> { ... }
}
```

## 2. Infrastructure: Tapo Provider & Adapter

- **`TapoDiscoveryProvider`**: Implements `DiscoveryProviderPort`. Binds UDP socket safely using ephemeral response ports (`SO_REUSEPORT` / dynamic port binding) to avoid `EADDRINUSE` conflicts when worker restarts or scans concurrently. Broadcasts discovery payloads and returns identified Tapo/Kasa plugs.
- **`TapoWifiAdapter`**: Implements `SensorDriverPort` (and actuation extensions).
  - `init()`: Connects to device and starts polling cycle with exponential backoff circuit breaker on failure.
  - `getState()`: Returns latest power status ('ON' / 'OFF' / wattage).
  - `toggle(state: boolean)`: Actuates plug relay state (`true` = ON, `false` = OFF).
  - `healthCheck()`: Performs direct query; on failure, triggers MAC address re-resolution (ARP/mDNS query) to resolve dynamic DHCP IP drift before returning `false`.

## 3. Telegram Onboarding Workflow (`DiscoverHandler`)

Autodetection UX is exposed via a `/discover` Telegram command implemented as an `@Injectable()` `DiscoverHandler` (`TelegramHandler`, `WorkflowDraftCanceller`) integrated into `WorkflowEntryCoordinator`.

### The Flow
1. **Trigger**: Admin sends `/discover`.
2. **Brand Selection**: Bot presents inline keyboard `[ Tapo/Kasa ] [ Scan All ] [ Manual IP ]`.
3. **Scan Phase**: If scan selected, bot updates message *"Scanning local network..."* and invokes `SensorDiscoveryService.discoverAll(15000)`.
4. **Manual IP Fallback**: If scan yields 0 devices or user picks `[ Manual IP ]`, bot prompts for IP input: *"Enter device IP address (e.g. 192.168.1.55):"*. Upon entry, `SensorDiscoveryService.verifyIp(ip)` validates connectivity.
5. **Selection Phase**: Candidate inline keyboard list presented for discovered or verified devices not yet in database.
6. **Naming Phase**: Prompt for custom display name (e.g., *"Living Room Lamp"*).
7. **Registration**: Sensor created via `AddSensorUseCase` and reloaded into active runtime via `ReloadSensorsUseCase`.

## 4. Security & Encryption

- **Local Network Bounds**: Discovery and polling communicate directly on local subnet interfaces without external cloud dependencies.
- **Encrypted Credentials**: Passwords stored in `config.password` are encrypted with AES-GCM (`encryptCredential` / `decryptCredential` in database layer).
- **Role Control**: `/discover` command restricted to admin users (`RoleMiddleware`).

