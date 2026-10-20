import { Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { createToken } from '../domain/tokens';

@Injectable()
export class PasswordHasher {
  private readonly options = {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  } as const;
  private readonly dummyHash = this.hash(createToken());

  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  async verify(password: string, passwordHash?: string | null): Promise<boolean> {
    const target = passwordHash ?? (await this.dummyHash);
    try {
      return (await verify(target, password)) && Boolean(passwordHash);
    } catch {
      return false;
    }
  }
}
