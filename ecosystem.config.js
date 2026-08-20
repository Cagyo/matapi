/**
 * Reads a PM2 tuning override, rejecting anything that is not a positive
 * integer. `parseInt` would turn `PM2_MIN_UPTIME=60s` into NaN, and PM2
 * evaluates `Date.now() - created_at < NaN` as false forever — no restart would
 * ever count as unstable and the crash-loop cap would silently stop existing,
 * reinstating the incident docs/specs/23-reliability.md records. `0` is rejected
 * for the same reason.
 */
function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
  apps: [
    {
      name: 'worker',
      script: 'dist/main.js',
      cwd: process.env.HOME_WORKER_INSTALL_DIR || __dirname,
      instances: 1,
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '512M',
      kill_timeout: 10000,
      // Crash-loop containment. Full rationale, the 615-restart incident and the
      // PM2_* override mechanism: docs/specs/23-reliability.md (Crash-Loop
      // Protection). Mind the direction when retuning — *lowering* min_uptime
      // makes PM2 more tolerant of a fast loop, not less. Retry budget is
      // max_restarts x (time-to-crash + restart_delay) ~ 2-3 min, after which the
      // worker deliberately stays down in `errored` instead of looping unseen.
      max_restarts: positiveInt('PM2_MAX_RESTARTS', 10),
      min_uptime: positiveInt('PM2_MIN_UPTIME', 60000),
      restart_delay: positiveInt('PM2_RESTART_DELAY', 10000),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
