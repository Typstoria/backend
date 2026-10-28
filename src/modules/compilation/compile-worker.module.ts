import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../../config/configuration.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { FilesModule } from '../files/files.module';
import { CompileProcessor } from './application/compile-processor.service';
import { TypstRunner } from './domain/compilation';
import { SandboxTypstRunner } from './infrastructure/sandbox-typst-runner';

@Module({
  imports: [ConfigurationModule.forRoot('worker'), DatabaseModule, FilesModule],
  providers: [CompileProcessor, { provide: TypstRunner, useClass: SandboxTypstRunner }],
})
export class CompileWorkerModule {}
