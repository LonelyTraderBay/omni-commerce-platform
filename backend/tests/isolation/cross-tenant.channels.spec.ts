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
import { ChannelsController } from '../../apps/api/src/modules/channels/channels.controller';
import { ChannelsService } from '../../apps/api/src/modules/channels/channels.service';
import { InboxController } from '../../apps/api/src/modules/inbox/inbox.controller';
import { InboxService } from '../../apps/api/src/modules/inbox/inbox.service';

const requireFromApi = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);

const { Injectable, UnauthorizedException } = requireFromApi('@nestjs/common');
const { APP_GUARD } = requireFromApi('@nestjs/core');
const { Test } = requireFromApi('@nestjs/testing');
const { Reflector } = requireFromApi('@nestjs/core');

Reflect.defineMetadata(
  'design:paramtypes',
  [ChannelsService],
  ChannelsController,
);
Reflect.defineMetadata('design:paramtypes', [InboxService], InboxController);

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

const channelsService = {
  listConnections: vi.fn(async () => []),
};

const inboxService = {
  listConversations: vi.fn(async () => ({ conversations: [] })),
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

describe('cross-tenant channels and inbox isolation', () => {
  let app: {
    close: () => Promise<void>;
    getHttpServer: () => ServerWithAddress;
    init: () => Promise<void>;
    listen: (port: number) => Promise<void>;
  };
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChannelsController, InboxController],
      providers: [
        PermissionsGuard,
        Reflector,
        { provide: ChannelsService, useValue: channelsService },
        { provide: InboxService, useValue: inboxService },
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
    channelsService.listConnections.mockResolvedValue([]);
    inboxService.listConversations.mockResolvedValue({ conversations: [] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('denies user A listing channels with org B context', async () => {
    const response = await request('/v1/channels', {
      orgId: ORG_B,
      token: USER_A_TOKEN,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'org_membership_required',
    });
    expect(channelsService.listConnections).not.toHaveBeenCalled();
    expect(membershipLookups).toEqual([{ orgId: ORG_B, userId: USER_A }]);
  });

  it('allows user A listing channels with org A context', async () => {
    const response = await request('/v1/channels', {
      orgId: ORG_A,
      token: USER_A_TOKEN,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(channelsService.listConnections).toHaveBeenCalledWith(ORG_A);
    expect(membershipLookups).toEqual([{ orgId: ORG_A, userId: USER_A }]);
  });

  it('denies user A listing inbox conversations with org B context', async () => {
    const response = await request('/v1/inbox/conversations', {
      orgId: ORG_B,
      token: USER_A_TOKEN,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'org_membership_required',
    });
    expect(inboxService.listConversations).not.toHaveBeenCalled();
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
