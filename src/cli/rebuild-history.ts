import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseEntityId } from '../common/ids/numeric-id';
import { HistoryWorkerModule } from '../modules/history/history-worker.module';
import { GitHistoryWriter } from '../modules/history/application/git-history-writer.service';

async function main(): Promise<void> {
  const projectId = parseEntityId(process.argv[2] ?? '');
  if (!projectId) throw new Error('Pass a project ID');
  const app = await NestFactory.createApplicationContext(HistoryWorkerModule);
  try {
    await app.get(GitHistoryWriter).rebuild(projectId);
  } finally {
    await app.close();
  }
}
void main().catch(() => {
  process.stderr.write('History rebuild failed. Check the project ID, database and Git storage.\n');
  process.exitCode = 1;
});
