# Pi 5 GPIO migration — on-device verification (per board: Pi 3, Pi 4 if available, Pi 5)

Blocking items from the design's "Verify on device before implementing" list.
Run BEFORE announcing the migration done; re-pin fixtures/parsers on any mismatch.

1. [ ] `scripts/capture-gpio-fixtures.sh test/fixtures/gpio/v1 <chip> <unwired-pin>` on the Pi 3
       and `.../v2` on the Pi 5. Diff against the provisional fixtures; fix parsers
       + tests where shapes differ (v2 `--format` semantics, v1 event lines,
       gpiodetect labels, gpioinfo consumer columns). Update PROVENANCE.md.
2. [ ] `scripts/gpio-smoke.sh <unwired-pin>` — bias + permissions PASS.
3. [ ] `scripts/gpio-smoke.sh <pin-a> <pin-b>` with a jumper — latency < 100 ms
       (validates stdbuf; also try WITHOUT stdbuf once, informatively, item 2 of the list).
4. [ ] Attach-confirm timing: watch a sensor bind on v1; confirm the gpioinfo consumer
       poll lands within the 10×50 ms window (worker log shows "ready", no ladder entry).
5. [ ] Note the registry healthCheck cadence from logs — it bounds the deaf window the
       healthCheck fix closes; record it in specs/03 if it differs from expectations.
6. [ ] `kill -9` the worker; confirm gpiomon children survive, then restart and confirm
       the orphan sweep reclaims the lines (log: "swept N orphaned gpiomon").
7. [ ] Pull-bias persistence across the blind window (design item 7): with a floating
       line, watch for spurious levels at attach; if pulls reset on release, file a
       follow-up — the reconcile push bounds the damage but the fact must be recorded.
8. [ ] Full migration rehearsal: deploy code via /update on a box with helper v1 →
       expect the Telegram helper-update-required message (exit-3 path); run
       scripts/install.sh; /update again → success; /feature digital shows ready.
9. [ ] Rollback rehearsal once: previous release + `systemctl unmask pigpiod &&
       systemctl enable --now pigpiod` → digital readiness green on old code.

---

## Notes recorded during implementation (2026-08-18)

Items worth checking on hardware because the implementation depends on them and
nothing off-device can confirm them:

- **v1 `gpioinfo` consumer column is the only positive attach signal.** The parser
  for it had a real bug (a trailing `\b` after a quoted consumer never matches,
  because `"` → space is non-word → non-word). Fixed and unit-tested against the
  fixture, but the fixture itself is still provisional — item 1 is what confirms
  the real column layout.
- **v2 `--format=%e` output shape is provisional.** The parser accepts both the
  word form (`rising`/`falling`) and the numeric gpiod event codes (`1`/`2`)
  precisely because the real shape is unconfirmed. Item 1 should collapse this to
  whichever is real.
- **Feature verification was migrated too.** `feature-installer.py`'s
  `verify_feature('digital')` previously required `systemctl is-active pigpiod.service`
  and `/usr/bin/pigs`; since `install-feature.sh` now masks pigpiod, those checks
  could never pass again and every `/feature digital install` would have reported
  failure. It now checks the gpiod tools plus a bare `gpiodetect`. Item 8 exercises
  this path end to end.

---

## Digital readiness probe fix — on-device verification (2026-08-18)

Board: Raspberry Pi 5 Model B Rev 1.0 @ 192.168.88.17, libgpiod v2.2.1, worker user
`homeworker` (uid 999, in group `gpio`). Deployed via `scripts/dev-deploy.sh`; the
installed tree at `/opt/home-worker` was confirmed to carry the fix (no `gpioinfo`
remains anywhere under `dist/features/infrastructure/readiness/`).

**Root cause reproduced and both fixes confirmed on the real board**, run as
`homeworker` against the live `/dev/gpiochip0`:

| Probe | Result |
|---|---|
| Old: bare `gpioinfo` under the 4 KiB cap | FAIL — `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` |
| Old probe under the new 64 KiB cap | PASS |
| New: `O_RDWR` open of the resolved chip | PASS |

`gpioinfo` emits exactly **4261 bytes** on this board — the figure the design doc
predicted, and 165 bytes over the old 4096-byte cap.

Verified:

- [x] Deploy — `scripts/dev-deploy.sh` exit 0; install script ran; board rebooted
      and came back in ~72 s; pm2 `worker` online.
- [x] **Digital readiness passes.** The real compiled `DigitalReadinessAdapter`
      from `/opt/home-worker`, run as `homeworker`, returns
      `{"ready":true,"restartScope":"worker"}`. The `features` row for `digital`
      is `enabled=1, installed=1, attention_reason=null` — no readiness gate — and
      the worker log carries no `DigitalReadinessAdapter` warning.
- [x] Chip resolution agrees between readiness and the backend: both resolve
      `gpiochip0 [pinctrl-rp1]`. `GPIO_CHIP` is unset on this board, so label-first
      applies; note `/dev/gpiochip4` exists here as a symlink to `gpiochip0`, and
      the four `gpio-brcmstb` chips (10–13) are exactly what bare `gpioinfo` was
      needlessly walking.
- [x] Checklist item 2 — `gpio-smoke.sh 5` → `PASS: bias plumbing`
      (chip=gpiochip0, libgpiod-major=2).
- [x] The capability readiness asserts is genuinely real: `gpiomon` binds as
      `homeworker` on `gpiochip0` (exit 124 from `timeout`, empty stderr).

Not verified — blocked, not failing:

- [ ] Items 3–4 (a `gpiomon` child per configured sensor; an end-to-end state
      change reaching Telegram). The `sensors` table has **0 rows** on this board,
      so no `gpiomon` child can exist and there is nothing to trigger. Re-run both
      after adding a digital sensor and jumpering its pin. BCM 17, 22 and 27 read
      high under both pull-up and pull-down here, i.e. they are externally wired —
      the likely physical sensor pins. BCM 5, 6, 12, 13, 16, 19, 20, 21 and 26 are
      floating and read cleanly (1 under pull-up, 0 under pull-down).
