import { describe, expect, it } from 'vitest';

import {
  mapSupabaseAuthError,
  slugifyOrganizationName,
} from './auth-errors';

describe('mapSupabaseAuthError', () => {
  it('maps invalid credentials without exposing provider wording', () => {
    expect(mapSupabaseAuthError({ code: 'invalid_credentials' })).toBe(
      'Email hoặc mật khẩu không đúng.',
    );
  });

  it('maps duplicate signup and rate limit errors', () => {
    expect(mapSupabaseAuthError({ message: 'User already registered' })).toBe(
      'Email này đã được đăng ký.',
    );
    expect(mapSupabaseAuthError({ status: 429 })).toBe(
      'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.',
    );
  });
});

describe('slugifyOrganizationName', () => {
  it('creates an API-compatible Vietnamese slug', () => {
    expect(slugifyOrganizationName('Cửa hàng Ánh Dương')).toBe(
      'cua-hang-anh-duong',
    );
  });

  it('provides a non-empty fallback for punctuation-only names', () => {
    expect(slugifyOrganizationName('---')).toMatch(/^shop-[a-z0-9]+$/);
  });
});
