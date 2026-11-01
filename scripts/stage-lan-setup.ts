import { copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pkg from '../package.json';

const directory = path.resolve('release/LAN-Host-Setup');
await mkdir(directory, { recursive: true });
for (const [source, destination] of [
  ['native/bin/remoter-update-server.exe', 'remoter-update-server.exe'],
  ['updates/config.json', 'update-config.json'],
  ['scripts/Install-LanUpdateServer.ps1', 'Install-LanUpdateServer.ps1'],
  ['scripts/Enable-LAN-Updates.cmd', 'Enable-LAN-Updates.cmd']
]) await copyFile(source, path.join(directory, destination));
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${directory.replaceAll("'", "''")}' -DestinationPath '${path.resolve(`release/Remoter-LAN-Host-Setup-${pkg.version}.zip`).replaceAll("'", "''")}' -Force`], { stdio: 'inherit' });
console.log('Staged LAN host setup for Jack PC and GPD PC. No private keys are included.');
