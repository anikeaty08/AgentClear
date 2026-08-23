import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_SCOPES = [
  'jobs:read',
  'jobs:write',
  'jobs:fund',
  'jobs:assign',
  'jobs:submit',
  'jobs:verify',
  'jobs:settle',
  'jobs:reputation',
  'jobs:receipt',
] as const;
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
    private readonly kind: AuthPrincipal['kind'] = 'operator',
    private readonly scopes: ReadonlySet<AuthScope> = new Set(AUTH_SCOPES),
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
      kind: this.kind,
      scopes: this.scopes,
    };
  }

  #digest(apiKey: string, pepper: string): Buffer {
    return createHmac('sha256', pepper).update(apiKey, 'utf8').digest();
  }
}

export class CompositeAuthenticator implements Authenticator {
  public constructor(private readonly authenticators: readonly Authenticator[]) {
    if (authenticators.length === 0) throw new TypeError('At least one authenticator is required.');
  }

  public async authenticate(apiKey: string): Promise<AuthPrincipal | null> {
    let matched: AuthPrincipal | null = null;
    for (const authenticator of this.authenticators) {
      const principal = await authenticator.authenticate(apiKey);
      if (principal !== null) matched = principal;
    }
    return matched;
  }
}
