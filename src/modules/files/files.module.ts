import { Module } from '@nestjs/common';
import { BlobStorage } from './infrastructure/blob-storage';
import { LocalBlobStorage } from './infrastructure/local-blob-storage';

@Module({
  providers: [{ provide: BlobStorage, useClass: LocalBlobStorage }],
  exports: [BlobStorage],
})
export class FilesModule {}
