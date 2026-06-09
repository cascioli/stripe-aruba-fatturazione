import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  ARUBA_ENV: z.enum(['DEMO', 'PROD']).default('DEMO'),
  ARUBA_SEND_MODE: z.enum(['DRAFT', 'DIRECT']).default('DRAFT'),
  ARUBA_USERNAME: z.string().min(1),
  ARUBA_PASSWORD: z.string().min(1),

  ALERT_WEBHOOK_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional()
  ),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${formatted}`);
  }

  const env = result.data;

  // Security: DEMO env must use test Stripe keys
  if (env.ARUBA_ENV === 'DEMO' && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error(
      'SECURITY: ARUBA_ENV=DEMO requires STRIPE_SECRET_KEY starting with "sk_test_". ' +
        'Using a live Stripe key against the Aruba demo environment is forbidden.'
    );
  }

  return env;
}

export const env = parseEnv();

export type Env = typeof env;

export function getArubaBaseUrl(): string {
  if (env.ARUBA_ENV === 'DEMO') {
    return 'https://demows.fatturazioneelettronica.aruba.it';
  }
  return 'https://ws.fatturazioneelettronica.aruba.it';
}
