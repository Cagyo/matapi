module.exports = {
  apps: [
    {
      name: 'worker',
      script: 'dist/main.js',
      cwd: process.env.HOME_WORKER_INSTALL_DIR || __dirname,
      instances: 1,
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '512M',
      kill_timeout: 10000,
      max_restarts: parseInt(process.env.PM2_MAX_RESTARTS || '10', 10),
      // Crash-loop containment — full rationale in docs/specs/23-reliability.md
      // (Crash-Loop Protection). PM2 increments `unstable_restarts` only when the
      // process exits *before* `min_uptime`, and resets it to 0 after any start
      // that outlives the window, so `max_restarts` only ever counts short-lived
      // starts. Without an explicit `min_uptime` PM2 applies a 1000 ms default: a
      // boot-time fault that crashed just past a second counted as *stable*, the
      // cap never engaged, and the worker restarted 615 times while still
      // reporting `status: online` / `unstable restarts: 0`.
      //
      // 60 s is wide enough that every boot-phase failure lands inside the window
      // even on a Pi 3 cold boot (SQLite open + migrations, sensor registry
      // reload, feature verification, archive boot recovery) — that is what makes
      // the cap engage. A start that reaches steady state is never counted, at any
      // value, so mind the direction when retuning: *lowering* min_uptime makes
      // PM2 more tolerant of a fast loop, not less. With restart_delay the retry
      // budget is max_restarts x (time-to-crash + restart_delay) ~ 2-3 minutes,
      // and 10 s between attempts cuts the CPU burn of a loop by ~10x.
      //
      // Accepted consequence: a genuinely broken deploy now exhausts the cap in
      // ~2-3 minutes and the worker stays DOWN in `errored` instead of looping —
      // no alerts until someone intervenes. Deliberate: `errored` is visible and
      // recoverable (`pm2 restart`, OTA rollback, `pm2 resurrect` on next boot),
      // an invisible loop is neither.
      //
      // The PM2_* vars are read when PM2 evaluates this file, so they must be
      // exported in the shell that runs `pm2 start|restart ecosystem.config.js`
      // (with --update-env on a restart). Nothing sources .env into the pm2 CLI —
      // see setup_pm2 in scripts/install.sh — so setting them only in .env is inert.
      min_uptime: parseInt(process.env.PM2_MIN_UPTIME || '60000', 10),
      restart_delay: parseInt(process.env.PM2_RESTART_DELAY || '10000', 10),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
