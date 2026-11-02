import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testIgnore: '**/controls/**',
  workers: 2,
  reporter: 'line',
  use: { headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
