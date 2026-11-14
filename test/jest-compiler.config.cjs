module.exports = {
  ...require('../jest.config.cjs'),
  rootDir: '..',
  roots: ['<rootDir>/test/compiler'],
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: ['**/sandbox-typst.spec.ts'],
  testTimeout: 15000,
};
