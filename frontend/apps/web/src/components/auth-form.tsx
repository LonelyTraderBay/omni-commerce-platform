'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type CSSProperties, type FormEvent, useEffect, useState } from 'react';

import {
  ApiClientError,
  createOrganization,
  listOrganizations,
  mapOrganizationMemberships,
} from '../lib/api-client';
import { mapSupabaseAuthError, slugifyOrganizationName } from '../lib/auth-errors';
import { saveSession } from '../lib/auth-session';
import { getSupabaseBrowserClient } from '../lib/supabase-browser';

type AuthMode = 'login' | 'signup';

type AuthFormProps = {
  mode: AuthMode;
};

const DEMO_EMAIL = 'demo@omni.local';
const DEMO_PASSWORD = 'OmniDemo123!';

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showDemoAccount, setShowDemoAccount] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isSignup = mode === 'signup';

  useEffect(() => {
    const isLocalDevelopment =
      process.env.NODE_ENV === 'development' &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        window.location.hostname,
      );

    setShowDemoAccount(!isSignup && isLocalDevelopment);

    if (!isSignup && isLocalDevelopment) {
      setEmail(DEMO_EMAIL);
      setPassword(DEMO_PASSWORD);
    }
  }, [isSignup]);

  function fillDemoAccount() {
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const normalizedEmail = email.trim().toLowerCase();
    const trimmedOrgName = orgName.trim();

    if (!normalizedEmail || !password) {
      setError('Vui lòng nhập email và mật khẩu.');
      return;
    }
    if (password.length < 8) {
      setError('Mật khẩu cần có ít nhất 8 ký tự.');
      return;
    }
    if (isSignup && !trimmedOrgName) {
      setError('Vui lòng nhập tên tổ chức.');
      return;
    }

    setLoading(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const authResult = isSignup
        ? await supabase.auth.signUp({
            email: normalizedEmail,
            password,
          })
        : await supabase.auth.signInWithPassword({
            email: normalizedEmail,
            password,
          });

      if (authResult.error) {
        setError(mapSupabaseAuthError(authResult.error));
        return;
      }

      const session = authResult.data.session;
      if (!session?.access_token) {
        setNotice(
          'Tài khoản đã được tạo. Hãy xác nhận email rồi đăng nhập để tiếp tục.',
        );
        return;
      }

      let memberships = await listOrganizations(session.access_token);
      if (isSignup && memberships.length === 0) {
        const created = await createOrganization(
          {
            name: trimmedOrgName,
            slug: slugifyOrganizationName(trimmedOrgName),
          },
          session.access_token,
        );
        memberships = [created];
      }

      const organizations = mapOrganizationMemberships(memberships);
      if (organizations.length === 0) {
        setError(
          'Tài khoản chưa có tổ chức. Hãy nhận lời mời hoặc liên hệ quản trị viên.',
        );
        return;
      }

      saveSession({
        accessToken: session.access_token,
        organizations,
        activeOrgId: organizations[0]?.id,
      });
      router.replace('/dashboard');
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Không thể xác thực phiên đăng nhập.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        display: 'grid',
        minHeight: '100vh',
        padding: '32px 16px',
        placeItems: 'center',
      }}
    >
      <section
        style={{
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 16,
          boxShadow: '0 20px 45px rgba(15, 23, 42, 0.08)',
          maxWidth: 560,
          padding: 32,
          width: '100%',
        }}
      >
        <p
          style={{
            color: '#2563eb',
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: '0.08em',
            margin: '0 0 12px',
            textTransform: 'uppercase',
          }}
        >
          Omni Commerce
        </p>
        <h1 style={{ fontSize: 32, lineHeight: 1.15, margin: 0 }}>
          {isSignup ? 'Tạo tài khoản' : 'Đăng nhập bảng điều khiển'}
        </h1>
        <p style={{ color: '#475569', fontSize: 16, lineHeight: 1.6 }}>
          Đăng nhập an toàn bằng Supabase Auth. Sau khi xác thực, ứng dụng chỉ
          lưu access token và danh sách tổ chức cần thiết để gọi Core API.
        </p>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <label style={labelStyle}>
            Email
            <input
              autoComplete="email"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ban@congty.vn"
              style={inputStyle}
            />
          </label>

          <label style={labelStyle}>
            Mật khẩu
            <input
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              minLength={8}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Ít nhất 8 ký tự"
              style={inputStyle}
            />
          </label>

          {showDemoAccount ? (
            <aside role="note" style={demoAccountStyle}>
              <strong>Tài khoản demo local</strong>
              <span>Email: {DEMO_EMAIL}</span>
              <span>Mật khẩu: {DEMO_PASSWORD}</span>
              <button
                type="button"
                onClick={fillDemoAccount}
                style={demoButtonStyle}
              >
                Điền lại tài khoản demo
              </button>
            </aside>
          ) : null}

          {isSignup ? (
            <fieldset
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                margin: '18px 0 0',
                padding: 16,
              }}
            >
              <legend style={{ color: '#334155', fontWeight: 800 }}>
                Tổ chức đầu tiên
              </legend>
              <p style={{ color: '#64748b', fontSize: 14, marginTop: 0 }}>
                Bạn sẽ được tạo quyền chủ sở hữu cho tổ chức này.
              </p>
              <label style={labelStyle}>
                Tên tổ chức
                <input
                  required
                  type="text"
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                  placeholder="Shop của tôi"
                  style={inputStyle}
                />
              </label>
            </fieldset>
          ) : null}

          {notice ? (
            <p role="status" style={{ color: '#1d4ed8', fontSize: 14 }}>
              {notice}
            </p>
          ) : null}
          {error ? (
            <p role="alert" style={{ color: '#b91c1c', fontSize: 14 }}>
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            style={{
              background: '#2563eb',
              border: 'none',
              borderRadius: 10,
              color: '#ffffff',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 16,
              fontWeight: 800,
              marginTop: 22,
              opacity: loading ? 0.75 : 1,
              padding: '13px 18px',
              width: '100%',
            }}
          >
            {loading
              ? 'Đang xác thực...'
              : isSignup
                ? 'Tạo tài khoản'
                : 'Đăng nhập'}
          </button>
        </form>

        <p style={{ color: '#64748b', fontSize: 14, marginBottom: 0 }}>
          {isSignup ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}{' '}
          <Link
            href={isSignup ? '/login' : '/signup'}
            style={{ color: '#2563eb', fontWeight: 700 }}
          >
            {isSignup ? 'Đăng nhập' : 'Đăng ký'}
          </Link>
        </p>
        <p style={{ color: '#94a3b8', fontSize: 13, margin: '16px 0 0' }}>
          <Link href="/legal/terms" style={{ color: '#64748b' }}>
            Điều khoản
          </Link>
          {' · '}
          <Link href="/legal/privacy" style={{ color: '#64748b' }}>
            Bảo mật
          </Link>
        </p>
      </section>
    </main>
  );
}

const labelStyle: CSSProperties = {
  color: '#334155',
  display: 'flex',
  flexDirection: 'column',
  fontSize: 14,
  fontWeight: 700,
  gap: 6,
  marginTop: 16,
};

const inputStyle: CSSProperties = {
  border: '1px solid #cbd5e1',
  borderRadius: 10,
  color: '#0f172a',
  font: 'inherit',
  padding: '11px 12px',
};

const demoAccountStyle: CSSProperties = {
  background: '#eff6ff',
  border: '1px solid #bfdbfe',
  borderRadius: 10,
  color: '#1e3a8a',
  display: 'flex',
  flexDirection: 'column',
  fontSize: 14,
  gap: 5,
  marginTop: 18,
  padding: 12,
};

const demoButtonStyle: CSSProperties = {
  alignSelf: 'flex-start',
  background: 'transparent',
  border: 'none',
  color: '#1d4ed8',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 800,
  padding: '4px 0 0',
  textDecoration: 'underline',
};
