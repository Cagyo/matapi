export type SystemMode = 'real' | 'stub';

/** Resolves the fixed safe system-adapter selection without importing a module. */
export function resolveSystemMode(): SystemMode {
  if (process.env.SYSTEM_MODE === 'stub') return 'stub';
  if (process.env.SYSTEM_MODE === 'real') return 'real';
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') return 'stub';
  return process.platform === 'linux' ? 'real' : 'stub';
}
