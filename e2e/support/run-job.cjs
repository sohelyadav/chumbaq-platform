'use strict';
/**
 * Runs one worker scheduler method once, then exits: `node run-job.cjs <dist file> <class>
 * <method>`, from apps/api with the stack's environment (`jobs.ts` starts it).
 *
 * It builds the worker's own module (apps/api/dist/worker.module) through Nest's testing
 * module with two providers replaced: the schedule explorer, so no cron is mounted here
 * (the stack's worker keeps its own), and the BullMQ registrar, so this process consumes
 * no queue (jobs it enqueues are run by the stack's worker). Everything else starts as in
 * the worker. The method's return value is printed on the last line as
 * `RUN_JOB_RESULT <json>`.
 */
const path = require('path');

const [distFile, className, methodName] = process.argv.slice(2);
if (!distFile || !className || !methodName) {
  console.error('usage: node run-job.cjs <dist file> <class> <method>');
  process.exit(2);
}

const API_DIR = process.cwd();
const fromApi = (id) => require(require.resolve(id, { paths: [API_DIR] }));

async function main() {
  const { Test } = fromApi('@nestjs/testing');
  const { ConsoleLogger } = fromApi('@nestjs/common');
  const { ScheduleExplorer } = fromApi('@nestjs/schedule/dist/schedule.explorer');
  const { BullRegistrar } = fromApi('@nestjs/bullmq/dist/bull.registrar');
  const { WorkerModule } = require(path.join(API_DIR, 'dist/worker.module'));
  const target = require(path.join(API_DIR, 'dist', distFile))[className];
  if (typeof target !== 'function') throw new Error(`${className} is not exported by dist/${distFile}`);

  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(ScheduleExplorer)
    .useValue({})
    .overrideProvider(BullRegistrar)
    .useValue({ register() {} })
    // The testing module's own logger prints errors only; the worker's prints every line.
    .setLogger(new ConsoleLogger())
    .compile();
  await moduleRef.init();

  let result;
  try {
    // A cron mounted here would run beside the stack's worker until this process exits.
    const crons = moduleRef.get(fromApi('@nestjs/schedule').SchedulerRegistry, { strict: false }).getCronJobs();
    if (crons.size > 0) throw new Error(`${crons.size} cron job(s) were mounted; the schedule explorer was not replaced`);
    const instance = moduleRef.get(target, { strict: false });
    if (typeof instance[methodName] !== 'function') throw new Error(`${className} has no method ${methodName}`);
    result = await instance[methodName]();
  } finally {
    await moduleRef.close();
  }
  console.log(`RUN_JOB_RESULT ${JSON.stringify(result === undefined ? null : result)}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`RUN_JOB_FAILED ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  },
);
