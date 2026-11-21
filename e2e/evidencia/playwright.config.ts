import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // A stack sobe antes (make evidencia); o alerta leva ~1 min para disparar e o vídeo é pausado.
  timeout: 20 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    launchOptions: { slowMo: 600 },
  },
});
