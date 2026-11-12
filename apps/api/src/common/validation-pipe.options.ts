import { ValidationPipeOptions } from '@nestjs/common';

/**
 * The one definition of how request bodies are validated and transformed.
 *
 * Exported rather than written inline in `main.ts` so a test can exercise the
 * pipe the application actually runs. A spec that builds its own
 * `ValidationPipe` is testing a pipe nothing serves traffic through, and this
 * has already cost us: a suite asserting DTOs "through the real
 * ValidationPipe" passed for months while four fields were being destroyed on
 * every request, because the spec omitted `enableImplicitConversion`.
 *
 * `enableImplicitConversion` is the sharp edge. It coerces every property to
 * its reflected `design:type`, and TypeScript erases `Foo[]` to `Array` — so an
 * array of objects has each element coerced into an array, arriving as `[[]]`.
 * It silently emptied journey steps, push action buttons, push carousel slides
 * and in-app message buttons. The defence is `@Type(() => Dto)` on any array of
 * objects, which tells class-transformer what the elements are instead of
 * letting it guess, and `dto-object-arrays.spec.ts` fails the build on the next
 * one that forgets.
 *
 * ## Why the flag stays on
 *
 * Nothing in this codebase needs it. Only `PaginationDto` is bound to a query
 * string, and it carries its own `@Type(() => Number)`; every SDK — JS, iOS,
 * Android, Flutter — sends real JSON numbers and booleans in bodies. So it
 * could be turned off, and that was considered.
 *
 * It stays because this is a self-hosted product with a public REST API, and
 * the flag is what makes that API forgiving of a third-party client that posts
 * `"screenWidth": "1080"`. Removing it would start rejecting requests that work
 * today, for a safety property the guard test already provides. Keep the
 * leniency at the edge; keep the element types explicit.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: {
    enableImplicitConversion: true,
  },
};
