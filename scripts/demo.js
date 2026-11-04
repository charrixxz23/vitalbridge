// `npm run demo`: servidor + simulador en un solo comando, sin hardware.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/src/server.js';

const port = Number(process.env.PORT) || 8080;
const { server } = createApp({ dbPath: ':memory:', log: (m) => console.log(`[servidor] ${m}`) });

server.listen(port, '0.0.0.0', () => {
  console.log(`\n  Abre el dashboard:  http://localhost:${port}\n`);
  console.log('  El simulador corta la red del segundo 20 al 80 de cada ciclo de 150 s.');
  console.log('  Mira cómo el equipo sigue midiendo, y qué pasa al volver la señal.\n');

  const sim = spawn(process.execPath, [
    fileURLToPath(new URL('../simulator/simulate.js', import.meta.url)),
    '--url', `http://localhost:${port}`,
    ...process.argv.slice(2),
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  sim.stdout.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) console.log(`[maletín]  ${line}`);
  });

  const stop = () => { sim.kill(); server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
