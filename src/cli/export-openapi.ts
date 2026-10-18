import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { createDocumentationApplication } from '../bootstrap/create-documentation-application';
import { createOpenApiDocument } from '../bootstrap/swagger';

async function exportDocument(): Promise<void> {
  const app = await createDocumentationApplication();
  try {
    await writeFile('openapi.json', JSON.stringify(createOpenApiDocument(app), null, 2) + '\n');
  } finally {
    await app.close();
  }
}

void exportDocument().catch(() => {
  process.stderr.write('OpenAPI export failed. Check configuration and controller/DTO metadata.\n');
  process.exitCode = 1;
});
