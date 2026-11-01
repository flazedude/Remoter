export function connectionError(error: unknown, platform: string): unknown {
  if (platform !== 'darwin' || !(error instanceof Error)) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const match = code || error.message.match(/\b(EHOSTUNREACH|ENETUNREACH|EACCES|EPERM)\b/)?.[1];
  if (!['EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM'].includes(match ?? '')) return error;
  return new Error(`This Mac could not reach the computer (${match}). For LAN connections, enable Remoter in System Settings → Privacy & Security → Local Network, then quit and reopen Remoter. Also check that the other computer is sharing, its address is current, and its firewall allows Remoter.`, { cause: error });
}
