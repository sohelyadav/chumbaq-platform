import { NestFactory } from '@nestjs/core';
import { INT_DB_NAME } from './test-support/int-db';

/**
 * The worker's whole module graph resolves at boot. Feature modules it loads for their
 * services (push → touchpoints, …) also declare controllers, and Nest resolves those
 * controllers' guards even in an application context: a provider the API has globally but
 * the worker does not load (ProjectAccessService, once) crashes the worker on start, and
 * with it every queued send, schedule and retention job. Unit tests never build this graph.
 */
describe('WorkerModule', () => {
  it('boots and shuts down against the integration database', async () => {
    process.env.DATABASE_NAME = INT_DB_NAME;
    const { WorkerModule } = await import('./worker.module');
    const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });
    await app.close();
  });
});
