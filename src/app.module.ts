import { Module } from '@nestjs/common';
import { ConfigurationModule } from './config/configuration.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { AccessModule } from './modules/access/access.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { FilesModule } from './modules/files/files.module';
import { RevisionsModule } from './modules/revisions/revisions.module';
import { HistoryModule } from './modules/history/history.module';
import { CompilationModule } from './modules/compilation/compilation.module';
import { ProposalsModule } from './modules/proposals/proposals.module';
import { ContextModule } from './modules/context/context.module';
import { AnnotationsModule } from './modules/annotations/annotations.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { EditorModule } from './modules/editor/editor.module';
import { TransferModule } from './modules/transfer/transfer.module';
import { BackupModule } from './modules/backup/backup.module';
import { McpModule } from './modules/mcp/mcp.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    HealthModule,
    IdentityModule,
    AccessModule,
    ProjectsModule,
    FilesModule,
    RevisionsModule,
    HistoryModule,
    CompilationModule,
    ProposalsModule,
    ContextModule,
    AnnotationsModule,
    TemplatesModule,
    EditorModule,
    TransferModule,
    BackupModule,
    McpModule,
    JobsModule,
    AuditModule,
  ],
})
export class AppModule {}
