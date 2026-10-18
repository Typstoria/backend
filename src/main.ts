import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApplication } from './bootstrap/create-application';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  const config = app.get(AppConfigService);
  await app.listen(config.port, config.host);
  new Logger('Bootstrap').log({
    message: 'Typstoria API started',
    address: await app.getUrl(),
    swagger: config.swaggerEnabled ? '/docs' : 'disabled',
  });
}

void bootstrap().catch(() => {
  new Logger('Bootstrap').error('Application startup failed');
  process.exitCode = 1;
});
