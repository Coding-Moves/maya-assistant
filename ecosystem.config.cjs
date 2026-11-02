module.exports = {
  apps: [
    {
      name: 'maya',
      cwd: __dirname,
      script: 'node',
      args: '--import tsx src/index.ts',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      kill_timeout: 65_000,
    },
  ],
};
