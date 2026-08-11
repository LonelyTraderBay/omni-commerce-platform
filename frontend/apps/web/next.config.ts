import path from 'node:path';

import type { NextConfig } from 'next';

const securityHeaders = [
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
];

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  // Pin the Turbopack workspace root to this monorepo (three levels up from frontend/apps/web).
  // Without it, Turbopack's root-inference walks up parent directories and can pick up an
  // unrelated pnpm-workspace.yaml (e.g. when this repo is checked out as a nested git worktree
  // under another repo's directory tree), which then fails to resolve the `next` package and
  // crashes the dev server.
  turbopack: {
    root: path.join(__dirname, '..', '..', '..'),
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
  // Dev-only same-origin proxy to the local API. Browser-based tooling that
  // sandboxes cross-origin fetches (e.g. an automated preview pane) can't
  // reach NEXT_PUBLIC_API_BASE_URL's separate port directly; routing /v1/*
  // through the Next.js dev server itself keeps every request same-origin.
  // Not used in production (API_BASE_URL there is a real absolute origin).
  async rewrites() {
    if (process.env.NODE_ENV === 'production') {
      return [];
    }
    return [
      {
        source: '/v1/:path*',
        destination: 'http://localhost:4701/v1/:path*',
      },
    ];
  },
};

export default nextConfig;
