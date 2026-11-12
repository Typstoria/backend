import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CompilationModule } from '../compilation/compilation.module';
import { HistoryModule } from '../history/history.module';
import { ProjectsModule } from '../projects/projects.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { McpController } from './mcp.controller';
import { McpToolsService } from './mcp-tools.service';

@Module({
  imports: [AccessModule, ProjectsModule, HistoryModule, ProposalsModule, CompilationModule],
  controllers: [McpController],
  providers: [McpToolsService],
})
export class McpModule {}
