type SupabaseAuthErrorLike = {
  code?: string;
  message?: string;
  status?: number;
};

export function mapSupabaseAuthError(error: SupabaseAuthErrorLike): string {
  const code = error.code?.toLowerCase() ?? '';
  const message = error.message?.toLowerCase() ?? '';

  if (
    code === 'invalid_credentials' ||
    message.includes('invalid login credentials')
  ) {
    return 'Email hoặc mật khẩu không đúng.';
  }

  if (
    code === 'user_already_exists' ||
    message.includes('already registered') ||
    message.includes('already been registered')
  ) {
    return 'Email này đã được đăng ký.';
  }

  if (message.includes('password') && message.includes('at least')) {
    return 'Mật khẩu chưa đủ độ dài tối thiểu.';
  }

  if (message.includes('email')) {
    return 'Email không hợp lệ hoặc chưa được chấp nhận.';
  }

  if (error.status === 429 || message.includes('rate limit')) {
    return 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.';
  }

  return 'Không thể xác thực với Supabase. Vui lòng thử lại.';
}

export function slugifyOrganizationName(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');

  return slug || `shop-${Date.now().toString(36)}`;
}
