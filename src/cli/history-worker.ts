import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { runWorker } from '../infrastructure/jobs/run-worker';
import { HistoryWorkerModule } from '../modules/history/history-worker.module';
import { GitHistoryWriter } from '../modules/history/application/git-history-writer.service';
import { processPendingHistory } from '../modules/history/infrastructure/process-pending-history';

void runWorker(HistoryWorkerModule, (app) =>
  processPendingHistory(app.get(DataSource), app.get(GitHistoryWriter)),
).catch(() => {
  process.stderr.write('History worker startup failed. Check PostgreSQL and configuration.\n');
  process.exitCode = 1;
});
