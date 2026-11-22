// Screenshots das telas-chave para o README, tiradas do painel real (make up) com Playwright.
// Uso: WEB_URL=http://localhost:8088 TOKEN=dev-only-operador-plantao node web/scripts/screenshots.mjs
// O Playwright vem de e2e/evidencia (npm ci lá).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../e2e/evidencia/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const base = process.env.WEB_URL ?? 'http://localhost:8088';
const token = process.env.TOKEN ?? 'dev-only-operador-plantao';
const out = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
await page.addInitScript(([value]) => sessionStorage.setItem('vigilia.token', value), [token]);

const shot = async (name) => page.screenshot({ path: `${out}${name}.png` });

await page.goto(`${base}/`);
await page.waitForSelector('.row-link.is-pending, .panel-body');
await shot('incidentes');

const pending = page.locator('.row-link.is-pending').first();
if (await pending.count()) {
  await pending.click();
  await page.waitForSelector('[data-step="decide"]');
  await shot('investigacao');
}

await page.goto(`${base}/approvals`);
await page.waitForSelector('article, .panel-body');
await shot('aprovacoes');

await page.goto(`${base}/audit`);
await page.getByRole('button', { name: 'Verificar cadeia' }).click();
await page.waitForSelector('[role="status"]');
await shot('auditoria');

await page.goto(`${base}/policy`);
await page.waitForSelector('.matrix');
await shot('politica');

await browser.close();
