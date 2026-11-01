export type ClipboardDirection = 'send' | 'receive' | 'both' | 'paste' | 'copy';
export interface ClipboardSnapshot { local: string; remote: string }

export function clipboardTransfer(direction: ClipboardDirection, local: string, remote: string, previous?: ClipboardSnapshot): 'send' | 'receive' | undefined {
  if (local === remote) return;
  if (direction === 'copy') return 'receive';
  if (direction === 'send' || direction === 'receive') return direction;
  // Polling establishes a baseline without replacing either existing clipboard.
  // The first paste still sends text copied locally before sync was enabled.
  if (!previous) return direction === 'paste' ? 'send' : undefined;
  if (local !== previous.local && (local.length > 0 || direction === 'paste')) return 'send';
  if (remote !== previous.remote && (remote.length > 0 || direction === 'paste')) return 'receive';
  if (direction === 'paste') return 'send';
}
