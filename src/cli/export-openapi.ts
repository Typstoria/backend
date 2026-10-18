import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { createApplication } from '../bootstrap/create-application';
import { createOpenApiDocument } from '../bootstrap/swagger';

async function exportDocument(): Promise<void> {
  const app = await createApplication();
  try {
    await app.init();
    await writeFile('openapi.json', JSON.stringify(createOpenApiDocument(app), null, 2) + '\n');
  } finally {
    await app.close();
  }
}

void exportDocument().catch(() => {
  process.stderr.write('OpenAPI export failed. Check configuration and database availability.\n');
  process.exitCode = 1;
});
