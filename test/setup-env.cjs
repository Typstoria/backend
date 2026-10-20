// Unit/HTTP tests must not inherit production settings or a live database connection.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/typstoria_test';
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';

require('./setup-mailjet.cjs');
