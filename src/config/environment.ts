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

const environmentSchema = z
  .object({
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
    const requireField = (field: string) =>
      context.addIssue({ code: 'custom', path: [field], message: 'Required for this environment' });
    if (config.NODE_ENV === 'production') {
      if (!config.PUBLIC_WEB_URL.startsWith('https://')) requireField('PUBLIC_WEB_URL');
    }
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
