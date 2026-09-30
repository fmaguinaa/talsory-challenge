import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // NestJS resolves dependencies and DTO validation from the TypeScript
    // `design:paramtypes` / `design:type` metadata, which only `tsc` emits.
    // Vitest transforms with esbuild, which does not, so without this plugin
    // every constructor dependency and every @Body() DTO would silently fail
    // to resolve or fail to validate -- and the tests would pass while
    // asserting the wrong thing.
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // main.ts is the process entry point and config/ is exercised through the
      // modules that consume it. Type-only modules hold no runtime logic, so
      // counting them would only dilute the numbers that matter.
      exclude: ['src/main.ts', 'src/config/**', 'src/**/types.ts'],
      thresholds: {
        'src/matrix/application/**/*.ts': {
          statements: 90,
          branches: 90,
          functions: 100,
          lines: 90,
        },
        'src/matrix/domain/**/*.ts': {
          statements: 95,
          branches: 95,
          functions: 100,
          lines: 95,
        },
      },
    },
  },
});
