'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';

import {
  ApiClientError,
  completeMetaOAuth,
} from '../../../../../lib/api-client';

function formatMetaOAuthError(error: string, errorDescription: string | null) {
  if (error === 'access_denied') {
    return 'Bạn đã hủy cấp quyền Meta.';
  }

  return errorDescription ?? error;
}

function MetaOAuthCallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (error) {
      const message = formatMetaOAuthError(error, errorDescription);
      router.replace(
        `/settings/channels?oauth_error=${encodeURIComponent(message)}`,
      );
      return;
    }

    if (!code) {
      router.replace(
        `/settings/channels?oauth_error=${encodeURIComponent('Thiếu mã xác thực từ Meta.')}`,
      );
      return;
    }

    if (!state) {
      router.replace(
        `/settings/channels?oauth_error=${encodeURIComponent('Thiếu trạng thái xác thực từ Meta.')}`,
      );
      return;
    }

    void (async () => {
      try {
        await completeMetaOAuth(code, state);
        router.replace('/settings/channels?oauth_success=1');
      } catch (err) {
        const message =
          err instanceof ApiClientError
            ? err.message
            : 'Không thể hoàn tất kết nối Meta.';
        router.replace(
          `/settings/channels?oauth_error=${encodeURIComponent(message)}`,
        );
      }
    })();
  }, [router, searchParams]);

  return (
    <main>
      <p style={{ color: '#64748b', fontSize: 16 }}>Đang hoàn tất kết nối Meta…</p>
    </main>
  );
}

export default function MetaOAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <main>
          <p style={{ color: '#64748b', fontSize: 16 }}>Đang tải…</p>
        </main>
      }
    >
      <MetaOAuthCallbackContent />
    </Suspense>
  );
}
