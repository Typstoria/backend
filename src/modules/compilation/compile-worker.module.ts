import { PreviewProcessor } from './application/preview-processor.service';
import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { ConfigurationModule } from '../../config/configuration.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { FilesModule } from '../files/files.module';
import { CompileProcessor } from './application/compile-processor.service';
import { TypstRunner } from './domain/compilation';
import { DockerTypstSandbox } from './infrastructure/docker-typst-sandbox';
import { LinuxTypstSandbox } from './infrastructure/linux-typst-sandbox';
import { SandboxTypstRunner } from './infrastructure/sandbox-typst-runner';

@Module({
  imports: [ConfigurationModule.forRoot('worker'), DatabaseModule, FilesModule],
  providers: [
    CompileProcessor,
    PreviewProcessor,
    {
      provide: TypstRunner,
      useFactory: (config: AppConfigService) =>
        new SandboxTypstRunner(
          config,
          config.typstRunner === 'docker'
            ? new DockerTypstSandbox(config)
            : new LinuxTypstSandbox(config),
        ),
      inject: [AppConfigService],
    },
  ],
})
export class CompileWorkerModule {}
