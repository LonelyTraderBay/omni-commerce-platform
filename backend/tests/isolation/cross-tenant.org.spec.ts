import '../../apps/api/node_modules/reflect-metadata/Reflect.js';

import type { IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AuthenticatedUser } from '../../apps/api/src/common/decorators/current-user.decorator';
import {
  MEMBERSHIPS_REPOSITORY,
  OrgGuard,
  type Membership,
  type MembershipLookup,
  type MembershipsRepository,
} from '../../apps/api/src/common/guards/org.guard';
import { PermissionsGuard } from '../../apps/api/src/modules/authz/permissions.guard';
import { IdentityController } from '../../apps/api/src/modules/identity/identity.controller';
import { IdentityService } from '../../apps/api/src/modules/identity/identity.service';

const requireFromApi = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);

const { Controller, Get, Injectable, UnauthorizedException } =
  requireFromApi('@nestjs/common');
const { APP_GUARD } = requireFromApi('@nestjs/core');
const { Test } = requireFromApi('@nestjs/testing');

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A_TOKEN = 'user-a-token';
const USER_B_TOKEN = 'user-b-token';

const tokenUsers = new Map<string, AuthenticatedUser>([
  [USER_A_TOKEN, { id: USER_A, email: 'user-a@example.com' }],
  [USER_B_TOKEN, { id: USER_B, email: 'user-b@example.com' }],
]);

const memberships = new Map<string, Membership>([
  [membershipKey(USER_A, ORG_A), membership('membership-a', USER_A, ORG_A)],
  [membershipKey(USER_B, ORG_B), membership('membership-b', USER_B, ORG_B)],
]);

const membershipLookups: MembershipLookup[] = [];
const membershipsRepository: MembershipsRepository = {
  async findMembership(input) {
    membershipLookups.push(input);
    return memberships.get(membershipKey(input.userId, input.orgId)) ?? null;
  },
};

const identityService = {
  createInvite: vi.fn(
    async (orgId: string, body: { email: string; role: string }) => ({
      invite: {
        id: '33333333-3333-3333-3333-333333333333',
        orgId,
        email: body.email,
        role: body.role,
        expiresAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    }),
  ),
};

@Injectable()
class TestAuthGuard {
  canActivate(context: {
    switchToHttp: () => {
      getRequest: () => {
        headers: IncomingHttpHeaders;
        user?: AuthenticatedUser;
      };
    };
  }) {
    const request = context.switchToHttp().getRequest();
    const token = bearerToken(request.headers);
    const user = token ? tokenUsers.get(token) : undefined;
    if (!user) {
      throw new UnauthorizedException({
        code: 'invalid_bearer',
        message: 'Bearer token is invalid',
      });
    }

    request.user = user;
    return true;
  }
}

@Controller('v1/isolation')
class IsolationProbeController {
  @Get('org-context')
  readOrgContext() {
    return { ok: true };
  }
}

describe('cross-tenant organization isolation', () => {
  let app: {
    close: () => Promise<void>;
    getHttpServer: () => ServerWithAddress;
    init: () => Promise<void>;
    listen: (port: number) => Promise<void>;
  };
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IsolationProbeController, IdentityController],
      providers: [
        PermissionsGuard,
        { provide: IdentityService, useValue: identityService },
        { provide: MEMBERSHIPS_REPOSITORY, useValue: membershipsRepository },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: OrgGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    membershipLookups.length = 0;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('denies user A reading an org-scoped route with org B context', async () => {
    const response = await request('/v1/isolation/org-context', {
      orgId: ORG_B,
      token: USER_A_TOKEN,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'org_membership_required',
    });
    expect(membershipLookups).toEqual([{ orgId: ORG_B, userId: USER_A }]);
  });

  it('allows user A reading the same route with org A context', async () => {
    const response = await request('/v1/isolation/org-context', {
      orgId: ORG_A,
      token: USER_A_TOKEN,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(membershipLookups).toEqual([{ orgId: ORG_A, userId: USER_A }]);
  });

  it('denies user A on the identity invite path for org B before writes', async () => {
    const response = await request(`/v1/orgs/${ORG_B}/invites`, {
      body: { email: 'invitee@example.com', role: 'cskh' },
      method: 'POST',
      orgId: ORG_B,
      token: USER_A_TOKEN,
    });

    expect(response.status).toBe(403);
    expect(identityService.createInvite).not.toHaveBeenCalled();
    expect(membershipLookups).toEqual([{ orgId: ORG_B, userId: USER_A }]);
  });

  async function request(
    path: string,
    options: {
      body?: unknown;
      method?: string;
      orgId: string;
      token: string;
    },
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      'x-org-id': options.orgId,
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    return fetch(`${baseUrl}${path}`, {
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? 'GET',
    });
  }
});

type ServerWithAddress = {
  address: () => AddressInfo | string | null;
};

function membership(
  id: string,
  userId: string,
  orgId: string,
  role: Membership['role'] = 'owner',
): Membership {
  return { id, orgId, role, userId };
}

function membershipKey(userId: string, orgId: string) {
  return `${userId}:${orgId}`;
}

function bearerToken(headers: IncomingHttpHeaders) {
  const authorization = headers.authorization;
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  return header
    ?.trim()
    .match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
}
