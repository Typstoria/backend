module.exports = {
  ...require('../jest.config.cjs'),
  rootDir: '..',
  roots: ['<rootDir>/test/integration'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 15000,
};
