export const en = {
  common: {
    adminRequired: '❌ Admin access required',
    error: (action: string, reason: string) => `❌ Failed to ${action}: ${reason}`,
    interrupted: 'Previous operation was interrupted. Please start again.',
  },
  claim: {
    success: '✅ You are now the admin of this Home Worker.',
    alreadyClaimed: '❌ This Home Worker already has an admin.',
  },
  status: {
    header: '📡 Sensor status',
    none: 'No sensors configured.',
    line: (name: string, value: string, when: string) => `• ${name}: ${value} (${when})`,
  },
  ping: {
    pong: (ms: number) => `🏓 Pong! (${ms}ms)`,
  },
  help: {
    user: [
      '📖 Available Commands',
      '',
      '/status — sensor status',
      '/ping — check bot response',
      '/help — this message',
    ].join('\n'),
    admin: [
      '📖 Available Commands',
      '',
      '/status — sensor status',
      '/ping — check bot response',
      '/help — this message',
      '/claim_admin — claim admin (first run only)',
    ].join('\n'),
  },
};
