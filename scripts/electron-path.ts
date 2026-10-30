/** Electron's downloader opts into proxy environment variables separately from npm. */
export async function electronPath(): Promise<string> {
  if ((process.env.HTTPS_PROXY || process.env.HTTP_PROXY) && !process.env.ELECTRON_GET_USE_PROXY) process.env.ELECTRON_GET_USE_PROXY = '1';
  const runtime = await import('electron');
  return runtime.default as unknown as string;
}
