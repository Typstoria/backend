import { AppConfigService } from '../../src/config/app-config.service';
import { DockerTypstSandbox } from '../../src/modules/compilation/infrastructure/docker-typst-sandbox';
import { LinuxTypstSandbox } from '../../src/modules/compilation/infrastructure/linux-typst-sandbox';
import { SandboxTypstRunner } from '../../src/modules/compilation/infrastructure/sandbox-typst-runner';

export const hasRealTypstRunner = Boolean(
  process.env.TEST_TYPST_DOCKER_IMAGE || process.env.TEST_TYPST_BINARY_PATH,
);

/** Explicit opt-in: integration tests never silently substitute a fake or unisolated compiler. */
export function realTypstRunner(compileWorkPath: string): SandboxTypstRunner {
  if (!hasRealTypstRunner) throw new Error('A real test compiler must be configured');
  const config = {
    typstBinaryPath: process.env.TEST_TYPST_BINARY_PATH,
    typstDockerImage: process.env.TEST_TYPST_DOCKER_IMAGE,
    typstDockerBinaryPath: process.env.TYPST_DOCKER_BINARY_PATH ?? 'docker',
    compileWorkPath,
  } as AppConfigService;
  return new SandboxTypstRunner(
    config,
    process.env.TEST_TYPST_DOCKER_IMAGE
      ? new DockerTypstSandbox(config)
      : new LinuxTypstSandbox(config),
  );
}
