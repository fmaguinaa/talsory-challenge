import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The coverage thresholds below are a quality gate, not decoration: the
    // domain and application layers hold all the business logic and must stay
    // covered, while adapters are covered by the integration tests.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Type-only modules and re-export barrels contain no runtime logic, so
      // counting them would only dilute the numbers that matter.
      exclude: ['src/main.ts', 'src/config/**', 'src/**/index.ts', 'src/**/types.ts'],
      thresholds: {
        'src/domain/**/*.ts': {
          statements: 95,
          branches: 95,
          functions: 100,
          lines: 95,
        },
        'src/application/**/*.ts': {
          statements: 90,
          branches: 90,
          functions: 100,
          lines: 90,
        },
      },
    },
  },
});
