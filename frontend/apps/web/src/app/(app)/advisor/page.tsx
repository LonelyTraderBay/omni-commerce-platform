'use client';

import { type CSSProperties, useState } from 'react';

import {
  ApiClientError,
  getAdvisorSuggestion,
  type AdvisorSuggestion,
} from '../../../lib/api-client';
import {
  Button,
  Card,
  colorBorder,
  colorDanger,
  colorTextBody,
  colorTextHeading,
  EmptyState,
  Input,
  MutedText,
} from '../../../components/ui';

export default function AdvisorPage() {
  const [goal, setGoal] = useState('Tăng doanh thu tuần này');
  const [suggestion, setSuggestion] = useState<AdvisorSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSuggest() {
    setLoading(true);
    setError(null);

    try {
      setSuggestion(
        await getAdvisorSuggestion({
          goal: goal.trim() || undefined,
        }),
      );
    } catch (err) {
      setSuggestion(null);
      setError(getApiErrorMessage(err, 'Không thể lấy gợi ý advisor.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>Owner Advisor</h1>
          <p style={descriptionStyle}>
            AI advisor chỉ đưa gợi ý bán hàng dựa trên RAG/catalog aggregate
            stub. Người bán duyệt thủ công; hệ thống không auto-post, không mua
            ads và không gửi Meta từ trang này.
          </p>
        </div>
      </header>

      <Card style={{ marginTop: 24 }}>
        <label style={labelStyle}>
          Mục tiêu
          <Input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            maxLength={500}
            placeholder="Ví dụ: đẩy hàng tồn cuối tuần"
          />
        </label>
        <Button onClick={() => void handleSuggest()} disabled={loading}>
          {loading ? 'Đang lấy gợi ý...' : 'Lấy gợi ý'}
        </Button>
      </Card>

      {error ? (
        <p role="alert" style={alertStyle}>
          {error}
        </p>
      ) : null}

      <Card style={{ marginTop: 24 }}>
        <h2 style={sectionTitleStyle}>Gợi ý</h2>
        {!suggestion ? (
          <EmptyState>Bấm “Lấy gợi ý” để tạo đề xuất cho chủ shop.</EmptyState>
        ) : (
          <>
            <p role="status" style={disclaimerStyle}>
              {suggestion.disclaimer} Người duyệt: chủ shop hoặc nhân sự được
              phân quyền.
            </p>
            <pre style={suggestionStyle}>{suggestion.suggestionsText}</pre>
            <MutedText>
              Prompt: {suggestion.promptVersion} · Model: {suggestion.model}
            </MutedText>
            <MutedText>{suggestion.entitlement.note}</MutedText>
          </>
        )}
      </Card>
    </main>
  );
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

const headerStyle: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  justifyContent: 'space-between',
};

const descriptionStyle: CSSProperties = {
  color: '#475569',
  fontSize: 18,
  maxWidth: 860,
};

const labelStyle: CSSProperties = {
  color: colorTextHeading,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  fontWeight: 700,
  gap: 6,
  marginBottom: 12,
};

// Tinted danger banner (background + border) — kept bespoke like the other
// pages in this wave; only `color` has an exact token match.
const alertStyle: CSSProperties = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: 12,
  color: colorDanger,
  marginTop: 16,
  padding: 16,
};

// Tinted warning/disclaimer banner for the AI-advisor disclaimer text. Uses
// the darker `#92400e` amber, which tokens.ts documents as a deliberately
// separate, higher-contrast-on-tint color from `colorWarning` (#b45309) —
// left as a raw literal on purpose, not folded into a token.
const disclaimerStyle: CSSProperties = {
  background: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: 12,
  color: '#92400e',
  padding: 16,
};

// Bespoke `<pre>` block rendering the raw AI advisor response — the one
// visual element this wave's ground rules explicitly call out to keep
// custom. `background`/`color` reuse `colorTextBody`/`colorBorder` since
// those tokens happen to hold the exact hex values already used here.
const suggestionStyle: CSSProperties = {
  background: colorTextBody,
  borderRadius: 12,
  color: colorBorder,
  fontFamily: 'inherit',
  lineHeight: 1.6,
  overflowX: 'auto',
  padding: 16,
  whiteSpace: 'pre-wrap',
};

// No bottom margin (matches attribution's identical case) — the content
// that follows (EmptyState or the disclaimer block) sits flush under the
// heading in the original, so this stays a manual <h2> in a bare `Card`
// rather than using `Card`'s `title` prop (which would add a 16px gap).
const sectionTitleStyle: CSSProperties = {
  fontSize: 22,
  margin: 0,
};
