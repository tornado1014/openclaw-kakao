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
    // openclaw-monitor는 schtasks로 독립 실행 (PM2 공동운명 방지)
  ]
};
