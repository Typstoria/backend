import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import {
  validateEnvironment,
  validateWorkerEnvironment,
  type Environment,
  type WorkerEnvironment,
} from './environment';

@Global()
@Module({})
export class ConfigurationModule {
  static forRoot(profile: 'api' | 'worker' = 'api'): DynamicModule {
    return {
      module: ConfigurationModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          validate: (input) => ({
            settings:
              profile === 'api' ? validateEnvironment(input) : validateWorkerEnvironment(input),
          }),
        }),
      ],
      providers: [
        {
          provide: AppConfigService,
          inject: [ConfigService],
          useFactory: (config: ConfigService) =>
            new AppConfigService(config.getOrThrow<Environment | WorkerEnvironment>('settings')),
        },
      ],
      exports: [AppConfigService],
    };
  }
}
