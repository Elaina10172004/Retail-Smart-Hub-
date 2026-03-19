import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { env } from './config/env';

const app = createApp();
const server = app.listen(env.port, env.host);

server.on('listening', () => {
  const address = server.address() as AddressInfo | null;
  const host = address?.address || env.host;
  const port = address?.port || env.port;
  console.log(`retail-smart-hub api listening on http://${host}:${port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`retail-smart-hub api failed to bind ${env.host}:${env.port} (port already in use)`);
  } else if (error.code === 'EACCES') {
    console.error(`retail-smart-hub api failed to bind ${env.host}:${env.port} (permission denied)`);
  } else {
    console.error(`retail-smart-hub api startup error: ${error.message}`);
  }

  process.exit(1);
});
