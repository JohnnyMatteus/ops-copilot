import { defineConfig } from 'vitest/config';

// Testes de integração contra os serviços do docker-compose local (make up). Fora do `pnpm test`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
