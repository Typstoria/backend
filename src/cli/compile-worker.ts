import { PreviewProcessor } from '../modules/compilation/application/preview-processor.service';
import { processQueuedPreviews } from '../modules/compilation/infrastructure/process-queued-previews';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { runWorker } from '../infrastructure/jobs/run-worker';
import { CompileWorkerModule } from '../modules/compilation/compile-worker.module';
import { CompileProcessor } from '../modules/compilation/application/compile-processor.service';
import { processQueuedCompilations } from '../modules/compilation/infrastructure/process-queued-compilations';

void runWorker(CompileWorkerModule, async (app) => {
  await processQueuedCompilations(app.get(DataSource), app.get(CompileProcessor));
  await processQueuedPreviews(app.get(DataSource), app.get(PreviewProcessor));
}).catch(() => {
  process.stderr.write('Compile worker startup failed. Check PostgreSQL and configuration.\n');
  process.exitCode = 1;
});
