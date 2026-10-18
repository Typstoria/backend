import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './infrastructure/persistence/entities/user.entity';

@Module({ imports: [TypeOrmModule.forFeature([User])] })
export class IdentityModule {}
