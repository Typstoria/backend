module.exports = {
  ...require('../jest.config.cjs'),
  rootDir: '..',
  roots: ['<rootDir>/test/compiler'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 15000,
};
