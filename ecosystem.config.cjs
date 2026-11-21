// PM2 配置：必须在项目根目录启动，.env 由服务端启动时读取。
module.exports = {
  apps: [
    {
      name: 'chat-demo',
      cwd: __dirname,
      script: 'server/dist/server/src/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
