# Digital Readiness Probe — Fix the Pi 5 False Negative

**Date:** 2026-08-18
**Status:** Approved design, not yet implemented
**Affects:** `src/features/infrastructure/readiness/digital-readiness.adapter.ts`, `src/features/infrastructure/readiness/readiness-seams.ts`, `test/features/infrastructure/feature-readiness.adapters.test.ts`

## Dependencies

- [2026-08-18-pi5-gpio-libgpiod-backend-design.md](2026-08-18-pi5-gpio-libgpiod-backend-design.md) — the libgpiod CLI migration this readiness check guards
- [03-sensor-digital.md](../../specs/03-sensor-digital.md) — digital sensor behaviour
- [architecture.md](../../architecture.md), [ports-and-adapters.md](../../ports-and-adapters.md)

## Problem

On a Raspberry Pi 5, the Telegram action **Verify Digital Inputs** always answers
`❌ Digital inputs did not pass readiness verification.` The digital feature therefore never
clears the readiness barrier introduced in `df9e2f1`, so no `gpiomon` child is ever spawned
and digital sensors stay dead. Reinstalling the application and re-running `dev-deploy.sh`
cannot help, because nothing about the installed system is wrong.

`DigitalReadinessAdapter.verify()` runs five checks. The device log names the failing one:

```
[DigitalReadinessAdapter] Feature readiness failed: digital gpio chip effective permissions
```

That is step 4, bare `/usr/bin/gpioinfo`, executed through `execFile` with
`READINESS_COMMAND_OPTIONS` from `readiness-seams.ts`:

```ts
maxBuffer: 4_096
```

Bare `gpioinfo` on a Pi 5 dumps every detected chip — `gpiochip0 [pinctrl-rp1]` with 54 lines
plus four `gpio-brcmstb` chips of 32, 17, 6 and 4 lines — **4261 bytes**. Node's `execFile`
kills the child and rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` once stdout passes the
cap. The adapter's bare `catch` maps that rejection to
`{ ready: false, failureCode: 'application-verification-failed' }`, indistinguishable from a
genuine permission fault. The probe overflows by 165 bytes.

### Evidence from the device (192.168.88.17, libgpiod v2.2.1, worker user `homeworker`)

| Check | Result |
|---|---|
| `which gpiodetect` | `/usr/bin/gpiodetect` |
| `gpiodetect` | `gpiochip0 [pinctrl-rp1] (54 lines)` — matches `KNOWN_CHIP_LABELS` |
| `id -nG` | `homeworker gpio` |
| `gpioinfo` run by hand as `homeworker` | exit 0, 4261 bytes |
| `systemctl is-active pigpiod.service` | `inactive` |
| `/dev/gpiochip0` | `crw-rw---- root:gpio`; opens `O_RDWR` as `homeworker` |

Reproduced with the adapter's exact options object:

```
FAIL ERR_CHILD_PROCESS_STDIO_MAXBUFFER :: stdout maxBuffer length exceeded
```

The hardware, the udev rules and the group membership are all correct. The check is wrong.

### Why the tests did not catch it

`test/features/infrastructure/feature-readiness.adapters.test.ts` fakes `execFile` and returns
a one-line stdout. A fake cannot enforce `maxBuffer`, so the suite is structurally blind to
this entire class of failure.

## Decisions

**1. Replace the step-4 probe with a direct `O_RDWR` open of the resolved chip device.**

Step 2 already resolves the chip name from `gpiodetect` output. Step 4 opens `/dev/<chip>`
through the existing `nodeReadinessFiles.openReadWrite` seam instead of spawning `gpioinfo`.

Both libgpiod majors open the chip `O_RDWR | O_CLOEXEC`, and the discretionary access check —
group ownership, missing udev rule, ACLs — happens at `open()`, not at ioctl time. For every
failure mode this adapter exists to catch (wrong group, missing udev rule, chip absent) the
open is equivalent to what `gpioinfo`, `gpioget` and `gpiomon` each pass through. It is
bounded by construction: no subprocess, no buffer, no output.

The change also removes a false negative that bare `gpioinfo` carried. `gpioinfo` walks *all*
chips, so an unopenable `gpio-brcmstb` chip the worker never touches would fail readiness even
though the `pinctrl-rp1` chip the feature actually drives is healthy.

The lineinfo ioctl assertion is not lost. Step 2 runs the real `gpiodetect` subprocess, which
performs `open()` plus `GPIO_GET_CHIPINFO_IOCTL` on every chip; and `LibgpiodCliBackend.probe()`
re-runs a version-aware, correctly scoped `gpioinfo` when the feature is enabled.

`DigitalReadinessDependencies` gains an optional `files?: DigitalFiles`, where `DigitalFiles`
declares just the `openReadWrite(path: string): Promise<void>` member the probe needs, defaulting
to `nodeReadinessFiles`. This mirrors the `files?: UartFiles` /
`dependencies.files ?? nodeReadinessFiles` shape `UartReadinessAdapter` already uses.

**2. Rewrite the step-4 comment.** Its stated rationale — that bare `gpioinfo` is "valid on both
libgpiod majors and proves the running supervisor's EFFECTIVE permissions" — describes the call
being removed. The replacement invariant: step 2's `gpiodetect` proves a gpiod subprocess under
the sanitized `PATH` can open and ioctl the chips; the `O_RDWR` open proves *this process's*
effective credentials against the specific chardev its `gpiomon` children will inherit by
fork/exec.

**3. Raise `READINESS_COMMAND_OPTIONS.maxBuffer` from `4_096` to `64 * 1024`.**

This is insurance against the same class of bug in the other readiness adapters, not a fix for a
live fault: every command run by the motion, rtsp, uart and zigbee adapters emits well under
4 KB today. The value matches `EXEC_OPTIONS` in `src/sensors/infrastructure/libgpiod-cli.backend.ts`,
where the sensors module already learned this lesson — the readiness module is the outlier.

**4. Make the readiness adapter honour the `GPIO_CHIP` override first.**

`knownChipName()` currently tests `KNOWN_CHIP_LABELS` before the `GPIO_CHIP` override;
`resolveChip()` in `src/sensors/infrastructure/libgpiod-cli.syntax.ts` lets the override win.
The divergence is harmless while the resolved name is unused, but decision 1 dereferences that
name into a device path — so on a Pi 5 with `GPIO_CHIP` set, readiness would open `gpiochip0`
while the backend drives the overridden chip. Readiness could then pass on a chip the sensors
subsequently fail on. The readiness adapter adopts override-first precedence to match.

### Rejected alternatives

**Keep bare `gpioinfo`, raise only the cap.** Smallest diff, but retains the all-chips false
negative from decision 1 and leaves the check sensitive to output size in principle — the same
tripwire, moved further out.

**Scope the call to `gpioinfo <chip>`.** Does not work. libgpiod v2 treats positional arguments
as *line names*; on the target device `gpioinfo gpiochip0` returns
`cannot find line 'gpiochip0'`. Correct scoping needs `--chip <name>` on v2 and a bare positional
on v1, which is exactly the `gpioinfoArgs` version branch owned by
`src/sensors/infrastructure/libgpiod-cli.syntax.ts`. Importing that into the features context, or
duplicating version detection inside a readiness probe, buys nothing the backend probe does not
already do at enable time.

## Testing

**Real-`execFile` overflow test.** Drive the genuine promisified `execFile` with
`READINESS_COMMAND_OPTIONS` against a command whose stdout exceeds 4 KB, and assert it resolves.
Use a portable generator — `node -e` printing a known payload — so the test runs on a macOS
development machine as well as on the Pi. This closes the blind spot that let the bug ship; every
other test here uses the fake seam and cannot.

**Updated digital adapter cases.** The three existing digital cases in
`feature-readiness.adapters.test.ts` drop the `/usr/bin/gpioinfo` fake and assert `openReadWrite`
was called with `/dev/gpiochip0`.

**New unit cases.**

- The probe reports `application-verification-failed` when `openReadWrite` rejects with `EACCES`.
- With `GPIO_CHIP` set to a chip whose label is not in `KNOWN_CHIP_LABELS`, the probe opens the
  overridden chip's device path.

## On-device verification

Deploy to the Pi and confirm, in order:

1. **Verify Digital Inputs** answers with success rather than the verification-failed message.
2. A `gpiomon` child process is running under the `homeworker` user — none runs today, because the
   readiness barrier gates the feature off.
3. A digital sensor registers a state change end to end.

## Out of scope

- `scripts/install.sh`, `scripts/dev-deploy.sh` and the feature installer. They were never
  implicated; the reinstall attempts failed because the defect is in application code.
- Any change to `src/sensors/`. The backend probe is already correct.
