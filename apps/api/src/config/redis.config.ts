import { registerAs } from '@nestjs/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export default registerAs('redis', () => ({
  host: requireEnv('REDIS_HOST'),
  port: parseInt(requireEnv('REDIS_PORT'), 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
}));
