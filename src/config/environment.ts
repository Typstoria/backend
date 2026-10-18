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

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .url()
    .refine((value) => ['postgres:', 'postgresql:'].includes(URL.parse(value)?.protocol ?? '')),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) => value.split(',').map((origin) => origin.trim()))
    .pipe(z.array(originSchema).min(1)),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type Environment = Omit<z.infer<typeof environmentSchema>, 'SWAGGER_ENABLED'> & {
  SWAGGER_ENABLED: boolean;
};

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    // Report variable names, never their values (DATABASE_URL contains credentials).
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${fields.join(', ')}`);
  }

  return {
    ...result.data,
    SWAGGER_ENABLED: result.data.SWAGGER_ENABLED ?? result.data.NODE_ENV !== 'production',
  };
}
