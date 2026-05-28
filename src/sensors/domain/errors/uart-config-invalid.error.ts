export class UartConfigInvalidError extends Error {
  readonly code = 'UART_CONFIG_INVALID' as const;
  constructor(readonly reason: string) {
    super(`UART sensor config invalid: ${reason}`);
    this.name = 'UartConfigInvalidError';
  }
}
