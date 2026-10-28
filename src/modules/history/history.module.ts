import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ProjectsModule } from '../projects/projects.module';
import { GitRepository } from './domain/git-history';
import { LocalGitRepository } from './infrastructure/local-git-repository';
import { GitHistoryWriter } from './application/git-history-writer.service';
import { HistoryService } from './application/history.service';
import { RevisionDiffService } from './application/revision-diff.service';
import { HistoryController } from './http/history.controller';

@Module({
  imports: [FilesModule, ProjectsModule],
  providers: [
    GitHistoryWriter,
    HistoryService,
    RevisionDiffService,
    { provide: GitRepository, useClass: LocalGitRepository },
  ],
  controllers: [HistoryController],
})
export class HistoryModule {}
