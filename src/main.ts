// Ponto de entrada do serviço: valida a configuração, sobe o HTTP e encerra com graça.
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './telemetry/logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const { server, shutdown } = await createApp(env, logger);

server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'ops-copilot ouvindo'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'encerrando');
    server.close(() => {
      shutdown().finally(() => process.exit(0));
    });
  });
}
