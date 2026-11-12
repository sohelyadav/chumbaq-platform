import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AdminAppModule } from './admin-app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe.options';
import { TRUST_PROXY } from './common/client-ip';
import { requestId } from './common/request-id';
import { applySecurityHeaders } from './common/security-headers';
import { assertStaffProductionConfig, type StaffConfig } from './config/staff.config';

/**
 * The admin API: a second process on the same code and database as the customer API,
 * serving only staff routes. Bound to 127.0.0.1 by default, behind nginx on the admin
 * host, which serves the admin app on the same origin: so no CORS, and the staff
 * cookie stays host-only.
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AdminAppModule);
  const config = app.get(ConfigService);
  const staff = config.getOrThrow<StaffConfig>('staff');

  // Fail closed: staff passkeys are bound to the relying party, and a production boot on
  // the localhost default, or with an RP ID or origins that do not match the admin host,
  // would make every staff key silently unusable. Read after the config module has
  // loaded the .env.
  try {
    assertStaffProductionConfig(config.get<string>('app.nodeEnv'), staff);
  } catch (error) {
    console.error((error as Error).message);
    await app.close();
    process.exit(1);
  }

  // getClientIp, and so the sign-in limit and audit addresses, read the client through
  // nginx exactly as the customer API does. See TRUST_PROXY.
  app.set('trust proxy', TRUST_PROXY);
  // X-Request-Id: nginx's id (or a new one) on the request, the response and error logs.
  app.use(requestId);
  applySecurityHeaders(app);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  await app.listen(staff.adminApiPort, staff.adminApiHost);
  console.log(`Chumbaq admin API on http://${staff.adminApiHost}:${staff.adminApiPort}`);
}

bootstrap();
