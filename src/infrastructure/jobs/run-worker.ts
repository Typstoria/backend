import { Logger, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

/** One bounded polling pass at a time; shutdown drains work before closing the database. */
export async function runWorker(
  module: Type<unknown>,
  poll: (app: INestApplicationContext) => Promise<void>,
): Promise<void> {
  const app = await NestFactory.createApplicationContext(module);
  const logger = new Logger('Worker');
  let stopping = false;
  let wake: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    wake?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  logger.log('Worker started');
  try {
    while (!stopping) {
      await poll(app).catch(() => logger.warn('Worker pass failed; retrying from database state'));
      if (!stopping)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 1000);
        });
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await app.close();
  }
}
