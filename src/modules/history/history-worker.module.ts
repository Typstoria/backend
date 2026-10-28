import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../../config/configuration.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { FilesModule } from '../files/files.module';
import { GitHistoryWriter } from './application/git-history-writer.service';
import { GitRepository } from './domain/git-history';
import { LocalGitRepository } from './infrastructure/local-git-repository';

@Module({
  imports: [ConfigurationModule.forRoot('worker'), DatabaseModule, FilesModule],
  providers: [GitHistoryWriter, { provide: GitRepository, useClass: LocalGitRepository }],
})
export class HistoryWorkerModule {}
