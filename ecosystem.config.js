module.exports = {
  apps: [
    {
      name: 'cpg-api',
      script: 'dist/index.js',
      instances: 'max',           // one per CPU core
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env_file: '.env',
      error_file: 'logs/api-error.log',
      out_file: 'logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: 'cpg-worker',
      script: 'dist/worker.js',
      instances: 1,               // single worker — avoids duplicate block scans
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env_file: '.env',
      error_file: 'logs/worker-error.log',
      out_file: 'logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 20,
    },
  ],
};
