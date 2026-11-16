import { spawn } from 'node:child_process';
const processes = [spawn('node_modules/.bin/tsx', ['watch', 'apps/api/src/start.ts'], { stdio: 'inherit' }), spawn('node_modules/.bin/vite', ['--config', 'apps/web/vite.config.ts'], { stdio: 'inherit' })];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of processes) child.kill('SIGTERM'); process.exitCode = code; }
for (const child of processes) { child.on('error', error => { console.error(error); stop(1); }); child.on('exit', code => stop(code ?? 0)); }
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
