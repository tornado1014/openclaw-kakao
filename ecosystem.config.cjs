const path = require('path');

module.exports = {
  apps: [
    {
      name: 'memento-bridge',
      script: 'memento-bridge.mjs',
      cwd: path.join(__dirname, 'bridge'),
      autorestart: true,
      max_memory_restart: '200M',
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '30s',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'openclaw-monitor',
      script: 'openclaw-monitor.mjs',
      args: 'daemon',
      cwd: path.join(__dirname, 'monitor'),
      autorestart: true,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' }
    }
  ]
};
