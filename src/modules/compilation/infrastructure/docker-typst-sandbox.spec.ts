import { AppConfigService } from '../../../config/app-config.service';
import { DockerTypstSandbox } from './docker-typst-sandbox';

describe('Docker runtime supervision', () => {
  it('fails closed when systemd can terminate the worker and its watchdog together', async () => {
    const previous = process.env.INVOCATION_ID;
    process.env.INVOCATION_ID = 'test-service-invocation';
    try {
      const sandbox = new DockerTypstSandbox({} as AppConfigService);
      await expect(sandbox.fingerprint()).rejects.toThrow('supervision outside the worker service');
    } finally {
      if (previous === undefined) delete process.env.INVOCATION_ID;
      else process.env.INVOCATION_ID = previous;
    }
  });
});
