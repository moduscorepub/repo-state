import { createService } from './lib/service.mjs';
const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const server = createService({ webhookSecret: process.env.REPO_STATE_WEBHOOK_SECRET ?? '' });
server.listen(port, host, () => console.log(`Repo State listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(); server.closeIdleConnections();
});
