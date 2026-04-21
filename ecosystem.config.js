module.exports = {
  apps: [
    {
      name: 'worker',
      script: 'dist/main.js',
      cwd: '/opt/home-worker',
      instances: 1,
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '512M',
      max_restarts: parseInt(process.env.PM2_MAX_RESTARTS || '10', 10),
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
