module.exports = {
  ...require('./jest-compiler.config.cjs'),
  testMatch: ['**/docker-typst.spec.ts'],
  testTimeout: 45000,
};
