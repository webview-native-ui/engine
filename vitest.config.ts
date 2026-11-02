import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'jsdom', include: ['tests/controls/**/*.spec.ts'], isolate: true, setupFiles: ['tests/controls/test-setup.ts'] },
});
