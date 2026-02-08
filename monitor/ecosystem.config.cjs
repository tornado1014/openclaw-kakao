const path = require('path');

module.exports = {
  apps: [
    {
      name: 'openclaw-monitor',
      script: 'openclaw-monitor.mjs',
      args: 'daemon',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      windowsHide: true,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      },
      exp_backoff_restart_delay: 1000,
      max_restarts: 5,
      min_uptime: '30s',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
};
