import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ProjectsController } from './http/projects.controller';
import { ProjectsService } from './application/projects.service';
import { ProjectChangesService } from './application/project-changes.service';
import { ProjectUploadsService } from './application/project-uploads.service';
import { ProjectResourcesController } from './http/project-resources.controller';

@Module({
  imports: [FilesModule],
  controllers: [ProjectsController, ProjectResourcesController],
  providers: [ProjectsService, ProjectChangesService, ProjectUploadsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
