import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_SCOPES = ['jobs:read', 'jobs:write', 'jobs:fund'] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

export type AuthPrincipal = {
  id: string;
  kind: 'operator' | 'agent' | 'service';
  scopes: ReadonlySet<AuthScope>;
};

export interface Authenticator {
  authenticate(apiKey: string): Promise<AuthPrincipal | null>;
}

export class BootstrapApiKeyAuthenticator implements Authenticator {
  readonly #expectedDigest: Buffer;

  public constructor(
    apiKey: string,
    pepper: string,
    private readonly principalId: string,
  ) {
    this.#expectedDigest = this.#digest(apiKey, pepper);
    this.pepper = pepper;
  }

  private readonly pepper: string;

  public async authenticate(apiKey: string): Promise<AuthPrincipal | null> {
    const candidateDigest = this.#digest(apiKey, this.pepper);
    if (!timingSafeEqual(candidateDigest, this.#expectedDigest)) {
      return null;
    }

    return {
      id: this.principalId,
      kind: 'operator',
      scopes: new Set(AUTH_SCOPES),
    };
  }

  #digest(apiKey: string, pepper: string): Buffer {
    return createHmac('sha256', pepper).update(apiKey, 'utf8').digest();
  }
}
