import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';

import {
  PublicApiService,
  type PublicApiAuthContext,
} from './public-api.service';

export type PublicApiRequest = {
  headers: IncomingHttpHeaders;
  publicApi?: PublicApiAuthContext;
};

@Injectable()
export class PublicApiKeyGuard implements CanActivate {
  constructor(private readonly publicApi: PublicApiService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<PublicApiRequest>();
    request.publicApi = await this.publicApi.authenticateKey(
      getBearerToken(request.headers),
      'orders.read',
    );
    return true;
  }
}

function getBearerToken(headers: IncomingHttpHeaders) {
  const authorization = getHeader(headers, 'authorization')?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const direct = headers[name.toLowerCase()];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct[0] : direct;
  }

  const header = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(header) ? header[0] : header;
}
