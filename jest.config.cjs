module.exports = {
  preset: 'ts-jest',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { astTransformers: { before: ['<rootDir>/test/swagger-transformer.cjs'] } },
    ],
  },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.cjs'],
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/test/integration/'],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/cli/**', '!**/*.spec.ts'],
  coverageDirectory: 'coverage',
};
