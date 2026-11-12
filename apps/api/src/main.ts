import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Request, Response, NextFunction, text } from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe.options';
import { TRUST_PROXY } from './common/client-ip';
import { requestId } from './common/request-id';
import { applySecurityHeaders } from './common/security-headers';

async function bootstrap() {
  // rawBody keeps the request bytes beside the parsed JSON. Webhook
  // signatures (Resend's Svix HMAC) are computed over those exact bytes, and
  // re-serialising the parsed body does not reproduce them.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const configService = app.get(ConfigService);

  // Click attribution keys on the client's IP address, so `req.ip` has to be
  // the client and not the Nginx in front of it. See TRUST_PROXY for why this
  // is a trusted-address class rather than a hop count.
  app.set('trust proxy', TRUST_PROXY);
  // X-Request-Id: nginx's id (or a new one) on the request, the response and error logs.
  app.use(requestId);

  applySecurityHeaders(app);

  const corsOrigins = configService.getOrThrow<string[]>('app.corsOrigins');
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  // Rewrite root-level redirect paths (short links, .well-known) so they reach
  // controllers behind the /api global prefix. This replaces the old
  // setGlobalPrefix exclude list which used a :shortCode wildcard that also
  // matched controller prefixes like "projects" and "teams", stripping their
  // /api prefix and causing 404s.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'GET') {
      const path = req.path;
      if (
        path !== '/' &&
        path !== '/api' &&
        !path.startsWith('/api/') &&
        (path.startsWith('/.well-known/') ||
          /^\/[A-Za-z0-9_-]+(\/preview)?$/.test(path))
      ) {
        req.url = '/api' + req.url;
      }
    }
    next();
  });

  // SNS posts SES events as `text/plain`, which the JSON parser skips. Scoped
  // to that one route so no other endpoint starts accepting text bodies.
  app.use('/api/email/webhooks/ses', text({ type: '*/*', limit: '256kb' }));

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe(VALIDATION_PIPE_OPTIONS),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  const port = configService.getOrThrow<number>('app.port');
  await app.listen(port);
  console.log(`Chumbaq API running on http://localhost:${port}`);
}

bootstrap();
