import { SetMetadata } from '@nestjs/common';

export const AUTH_POLICY = 'identity:policy';
export type AuthPolicy = 'public' | 'verified';
export const Public = () => SetMetadata(AUTH_POLICY, 'public' satisfies AuthPolicy);
export const VerifiedRequired = () => SetMetadata(AUTH_POLICY, 'verified' satisfies AuthPolicy);
