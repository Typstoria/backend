module.exports = {
  ...require('../jest.config.cjs'),
  rootDir: '..',
  roots: ['<rootDir>/test/integration'],
  setupFiles: [],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 15000,
};
