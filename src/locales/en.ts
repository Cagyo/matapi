export const en = {
  common: {
    adminRequired: '❌ Admin access required',
    error: (action: string, reason: string) => `❌ Failed to ${action}: ${reason}`,
    interrupted: 'Previous operation was interrupted. Please start again.',
  },
  claim: {
    success: '✅ You are now the admin.',
    alreadyClaimed: '❌ Admin already claimed.',
  },
  status: {
    header: '📡 Sensor status',
    none: 'No sensors configured.',
    line: (name: string, value: string, when: string) => `• ${name}: ${value} (${when})`,
  },
  ping: {
    pong: '🏓 pong',
  },
  help: {
    body: [
      '/status — sensor overview',
      '/ping — health check',
      '/help — this message',
      '/claim_admin — claim admin (first run only)',
    ].join('\n'),
  },
};
