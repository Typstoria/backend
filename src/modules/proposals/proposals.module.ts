import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ProjectsModule } from '../projects/projects.module';
import { HistoryModule } from '../history/history.module';
import { ProposalsService } from './application/proposals.service';
import { ProposalsController } from './http/proposals.controller';

@Module({
  imports: [FilesModule, ProjectsModule, HistoryModule],
  providers: [ProposalsService],
  controllers: [ProposalsController],
  exports: [ProposalsService],
})
export class ProposalsModule {}
