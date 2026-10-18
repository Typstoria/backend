const { createHash } = require('node:crypto');
const { before } = require('@nestjs/swagger/plugin');
const { compilerOptions } = require('../nest-cli.json');
const { options } = compilerOptions.plugins.find((plugin) => plugin.name === '@nestjs/swagger');

module.exports.name = 'typstoria-swagger-transformer';
// Invalidate ts-jest's transform cache whenever the shared plugin settings change.
module.exports.version = Number.parseInt(
  createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 8),
  16,
);
module.exports.factory = (config) => before(options, config.program);
