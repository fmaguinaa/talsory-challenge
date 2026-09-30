/**
 * Jest configuration.
 *
 * `jest-expo` supplies the transform, the module mapping and the preset for each
 * platform, so the tests run against the same resolution rules the app uses.
 */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    // Type-only modules hold no runtime logic and would only dilute the report.
    '!src/**/types.ts',
  ],
  coverageThreshold: {
    // The validation rules and the API error mapping are the logic most worth
    // protecting: they are what stands between a typo and a bad request.
    'src/features/matrix/services/matrixValidation.ts': {
      statements: 90,
      branches: 85,
      functions: 100,
      lines: 90,
    },
    'src/features/matrix/services/apiClient.ts': {
      statements: 70,
      branches: 60,
      functions: 80,
      lines: 70,
    },
  },
};
