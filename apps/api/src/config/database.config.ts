import { registerAs } from '@nestjs/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export default registerAs('database', () => ({
  host: requireEnv('DATABASE_HOST'),
  port: parseInt(requireEnv('DATABASE_PORT'), 10),
  username: requireEnv('DATABASE_USER'),
  password: requireEnv('DATABASE_PASSWORD'),
  name: requireEnv('DATABASE_NAME'),
}));
