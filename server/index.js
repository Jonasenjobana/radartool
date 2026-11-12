import { buildApp } from './app.js';

const app = await buildApp({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } });
try { await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3100) }); }
catch (error) { app.log.error(error); process.exitCode = 1; await app.close(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); });
