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
