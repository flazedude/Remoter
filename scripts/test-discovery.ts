import dgram from 'node:dgram';

// Synthetic hosts use an isolated UDP port while a user's real sharing stays up.
export async function testDiscoveryPort(): Promise<number> {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, resolve); });
    return socket.address().port;
  } finally { socket.close(); }
}
