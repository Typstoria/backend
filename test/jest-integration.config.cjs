module.exports = {
  ...require('../jest.config.cjs'),
  rootDir: '..',
  roots: ['<rootDir>/test/integration'],
  setupFiles: ['<rootDir>/test/setup-mailjet.cjs'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 15000,
};
