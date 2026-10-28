import { z } from 'zod';

const originSchema = z.url().refine((value) => {
  const url = URL.parse(value);
  if (!url) return false;
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    url.origin === value &&
    !url.username &&
    !url.password
  );
}, 'Use an HTTP(S) origin without a path, credentials or trailing slash');

export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine((value) => ['postgres:', 'postgresql:'].includes(URL.parse(value)?.protocol ?? '')),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
});

const workerEnvironmentSchema = databaseEnvironmentSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GIT_STORAGE_PATH: z.string().trim().min(1).default('.local/history'),
  GIT_BINARY_PATH: z.string().trim().min(1).default('/usr/bin/git'),
  TYPST_BINARY_PATH: z.string().trim().min(1).default('/usr/local/bin/typst'),
  COMPILE_WORK_PATH: z.string().trim().min(1).default('.local/compile'),
  BLOB_STORAGE_PATH: z.string().trim().min(1).default('.local/blobs'),
});

const environmentSchema = workerEnvironmentSchema
  .extend({
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(z.array(originSchema).min(1)),
    SWAGGER_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    PUBLIC_WEB_URL: originSchema.default('http://localhost:5173'),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(2592000).default(604800),
    AUTH_VERIFY_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(86400),
    AUTH_RESET_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    GOOGLE_CLIENT_ID: z.preprocess(
      (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
      z
        .string()
        .trim()
        .max(255)
        .regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/)
        .optional(),
    ),
    MAIL_FROM: z.email(),
    MAILJET_API_KEY: z.string().trim().min(1),
    MAILJET_SECRET_KEY: z.string().trim().min(1),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === 'production' && !config.PUBLIC_WEB_URL.startsWith('https://'))
      context.addIssue({
        code: 'custom',
        path: ['PUBLIC_WEB_URL'],
        message: 'HTTPS required in production',
      });
  });

export type DatabaseEnvironment = z.infer<typeof databaseEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
export type Environment = Omit<z.infer<typeof environmentSchema>, 'SWAGGER_ENABLED'> & {
  SWAGGER_ENABLED: boolean;
};

function parse<S extends z.ZodType>(schema: S, input: Record<string, unknown>): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${fields.join(', ')}`);
  }
  return result.data;
}

export function validateDatabaseEnvironment(input: Record<string, unknown>): DatabaseEnvironment {
  return parse(databaseEnvironmentSchema, input);
}
export function validateWorkerEnvironment(input: Record<string, unknown>): WorkerEnvironment {
  return parse(workerEnvironmentSchema, input);
}
export function validateEnvironment(input: Record<string, unknown>): Environment {
  const config = parse(environmentSchema, input);
  return { ...config, SWAGGER_ENABLED: config.SWAGGER_ENABLED ?? config.NODE_ENV !== 'production' };
}
