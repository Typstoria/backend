import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ProjectsModule } from '../projects/projects.module';
import { CompilationsService } from './application/compilations.service';
import { CompileProcessor } from './application/compile-processor.service';
import { TypstRunner } from './domain/compilation';
import { CompilationsController } from './http/compilations.controller';
import { SandboxTypstRunner } from './infrastructure/sandbox-typst-runner';

@Module({
  imports: [FilesModule, ProjectsModule],
  providers: [
    CompilationsService,
    CompileProcessor,
    { provide: TypstRunner, useClass: SandboxTypstRunner },
  ],
  controllers: [CompilationsController],
})
export class CompilationModule {}
