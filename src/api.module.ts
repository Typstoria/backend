import { McpModule } from './modules/mcp/mcp.module';
import { AccessModule } from './modules/access/access.module';
import { ProposalsModule } from './modules/proposals/proposals.module';
import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { HistoryModule } from './modules/history/history.module';
import { CompilationModule } from './modules/compilation/compilation.module';

/** The same HTTP graph is scanned by the offline exporter without runtime configuration. */
@Module({
  imports: [
    AccessModule,
    McpModule,
    HealthModule,
    IdentityModule,
    ProjectsModule,
    HistoryModule,
    CompilationModule,
    ProposalsModule,
  ],
})
export class ApiModule {}
