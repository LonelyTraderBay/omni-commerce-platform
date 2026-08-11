'use client';

import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  ApiClientError,
  listOrganizations,
  updateOrgSettings,
  type OrganizationMembership,
} from '../../../lib/api-client';
import {
  getStoredOrganizations,
  isForeignStorageEvent,
  SESSION_CHANGED_EVENT,
  type StoredOrganization,
} from '../../../lib/auth-session';
import { getActiveOrgId } from '../../../lib/org-context';
import {
  Button,
  Card,
  ErrorText,
  MutedText,
  SuccessText,
  Toggle,
} from '../../../components/ui';

type UiSettings = {
  autoConfirm: boolean;
  aiReplies: boolean;
  aiDraftOrders: boolean;
  aiProductSuggestions: boolean;
};

const defaultSettings: UiSettings = {
  autoConfirm: false,
  aiReplies: true,
  aiDraftOrders: true,
  aiProductSuggestions: true,
};

export default function SettingsPage() {
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<StoredOrganization[]>([]);
  const [settings, setSettings] = useState<UiSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeOrganization = useMemo(
    () => organizations.find((org) => org.id === activeOrgId) ?? null,
    [activeOrgId, organizations],
  );

  const loadSettings = useCallback(async () => {
    const orgId = getActiveOrgId();
    setActiveOrgId(orgId);
    setOrganizations(getStoredOrganizations());
    setLoading(true);
    setError(null);
    setMessage(null);

    if (!orgId) {
      setSettings(defaultSettings);
      setLoading(false);
      return;
    }

    try {
      const memberships = await listOrganizations();
      const membership = memberships.find(
        (item) => item.organization.id === orgId,
      );
      const serverSettings = settingsFromMembership(membership);
      setSettings(readLocalSettings(orgId) ?? serverSettings);
    } catch (err) {
      setSettings(readLocalSettings(orgId) ?? defaultSettings);
      setError(
        getApiErrorMessage(
          err,
          'Không thể tải cấu hình từ API; đang dùng cấu hình trong trình duyệt.',
        ),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      void loadSettings();
    }

    void loadSettings();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadSettings]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);

    if (!activeOrgId) {
      setError('Hãy chọn tổ chức trước khi lưu cài đặt.');
      setSaving(false);
      return;
    }

    try {
      await updateOrgSettings(activeOrgId, settings);
      // The server is now the source of truth, so drop any local override left
      // behind by a previous failed save — otherwise it keeps winning over the
      // freshly-saved server settings on the next load (see readLocalSettings).
      window.localStorage.removeItem(storageKey(activeOrgId));
      setMessage('Đã lưu cài đặt lên máy chủ.');
    } catch (err) {
      try {
        window.localStorage.setItem(storageKey(activeOrgId), JSON.stringify(settings));
        setError(
          getApiErrorMessage(
            err,
            'Không lưu được lên máy chủ, đã lưu tạm trên trình duyệt này.',
          ),
        );
      } catch {
        setError('Không thể lưu cài đặt vào trình duyệt.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <header>
        <h1 style={{ margin: 0, fontSize: 32 }}>Cài đặt</h1>
        <p style={descriptionStyle}>
          Bật/tắt tự xác nhận đơn và các luồng AI cho tổ chức đang chọn. Trang
          này không đưa secret vào NEXT_PUBLIC.
        </p>
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <SuccessText>{message}</SuccessText> : null}

      <Card
        title="Tổ chức"
        style={{ marginTop: 24, maxWidth: 860, padding: 24 }}
      >
        <MutedText>
          Đang cấu hình:{' '}
          <strong>{activeOrganization?.name ?? activeOrgId ?? 'Chưa chọn'}</strong>
        </MutedText>

        {loading ? (
          <MutedText>Đang tải cài đặt...</MutedText>
        ) : (
          <form onSubmit={(event) => void handleSubmit(event)}>
            <Toggle
              title="Tự xác nhận đơn"
              description="Khi backend hỗ trợ lưu, đơn nháp hợp lệ sẽ được xác nhận tự động theo settings_json.auto_confirm."
              checked={settings.autoConfirm}
              onChange={(checked) =>
                setSettings((current) => ({ ...current, autoConfirm: checked }))
              }
            />
            <Toggle
              title="AI trả lời hội thoại"
              description="Cho phép AI đề xuất hoặc gửi phản hồi trong hộp thư theo chính sách vận hành."
              checked={settings.aiReplies}
              onChange={(checked) =>
                setSettings((current) => ({ ...current, aiReplies: checked }))
              }
            />
            <Toggle
              title="AI tạo nháp đơn"
              description="Cho phép AI gom sản phẩm trong hội thoại và tạo đơn nháp để nhân viên duyệt."
              checked={settings.aiDraftOrders}
              onChange={(checked) =>
                setSettings((current) => ({ ...current, aiDraftOrders: checked }))
              }
            />
            <Toggle
              title="AI gợi ý sản phẩm"
              description="Cho phép AI dùng danh mục để đề xuất sản phẩm phù hợp với nhu cầu khách."
              checked={settings.aiProductSuggestions}
              onChange={(checked) =>
                setSettings((current) => ({
                  ...current,
                  aiProductSuggestions: checked,
                }))
              }
            />

            <Button
              type="submit"
              disabled={saving || !activeOrgId}
              style={{ marginTop: 18 }}
            >
              {saving ? 'Đang lưu...' : 'Lưu cài đặt'}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}

function storageKey(orgId: string) {
  return `omni.uiSettings.${orgId}`;
}

function readLocalSettings(orgId: string): UiSettings | null {
  try {
    const raw = window.localStorage.getItem(storageKey(orgId));
    if (!raw) {
      return null;
    }

    return normalizeSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

function settingsFromMembership(
  membership: OrganizationMembership | undefined,
): UiSettings {
  return normalizeSettings(membership?.organization.settingsJson ?? {});
}

function normalizeSettings(input: unknown): UiSettings {
  if (!input || typeof input !== 'object') {
    return defaultSettings;
  }

  const row = input as Record<string, unknown>;
  return {
    autoConfirm:
      row.auto_confirm === true ||
      row.autoConfirm === true ||
      defaultSettings.autoConfirm,
    aiReplies:
      booleanSetting(row.aiReplies, row.ai_replies, defaultSettings.aiReplies),
    aiDraftOrders: booleanSetting(
      row.aiDraftOrders,
      row.ai_draft_orders,
      defaultSettings.aiDraftOrders,
    ),
    aiProductSuggestions: booleanSetting(
      row.aiProductSuggestions,
      row.ai_product_suggestions,
      defaultSettings.aiProductSuggestions,
    ),
  };
}

function booleanSetting(
  camelValue: unknown,
  snakeValue: unknown,
  fallback: boolean,
) {
  if (typeof camelValue === 'boolean') {
    return camelValue;
  }
  if (typeof snakeValue === 'boolean') {
    return snakeValue;
  }

  return fallback;
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

const descriptionStyle: CSSProperties = {
  color: '#475569',
  fontSize: 18,
  maxWidth: 760,
};
