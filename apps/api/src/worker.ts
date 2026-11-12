import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';
import { WORKER_QUEUES } from './queue/queue.constants';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Lets BullMQ finish the in-flight batch and release the job lock on SIGTERM
  // instead of leaving it to a stalled-job reclaim.
  app.enableShutdownHooks();

  const logger = new Logger('Worker');
  logger.log(
    `Chumbaq worker started — consuming ${WORKER_QUEUES.join(', ')}`,
  );
}

bootstrap();
