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
      // (Crash-Loop Protection). `max_restarts` only counts restarts where the
      // process died before `min_uptime`, so without an explicit `min_uptime`
      // PM2's 1000 ms default let a boot-time fault restart the worker 615 times
      // while still reporting `status: online` / `unstable restarts: 0`.
      //
      // 60 s clears the worst-case cold boot on a Raspberry Pi 3 (SQLite open +
      // migrations, sensor registry reload, feature verification, archive boot
      // recovery), so a slow-but-legitimate start is never read as a crash loop.
      // 10 s between attempts cuts the CPU burn of a loop by ~10x.
      //
      // Accepted consequence: a genuinely broken deploy now exhausts the cap in
      // ~2-3 minutes and the worker stays DOWN in `errored` instead of looping —
      // no alerts until someone intervenes. Deliberate: `errored` is visible and
      // recoverable (`pm2 restart`, OTA rollback, `pm2 resurrect` on next boot),
      // an invisible loop is neither. Retune via the env vars below.
      min_uptime: parseInt(process.env.PM2_MIN_UPTIME || '60000', 10),
      restart_delay: parseInt(process.env.PM2_RESTART_DELAY || '10000', 10),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
