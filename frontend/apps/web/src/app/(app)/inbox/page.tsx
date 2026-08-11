'use client';

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  ApiClientError,
  listInboxConversations,
  listInboxMessages,
  resumeInboxConversation,
  sendInboxMessage,
  takeoverInboxConversation,
  type InboxConversation,
  type InboxMessage,
} from '../../../lib/api-client';
import { isForeignStorageEvent, SESSION_CHANGED_EVENT } from '../../../lib/auth-session';
import {
  Button,
  Card,
  colorBackgroundCard,
  colorBackgroundSubtle,
  colorBorder,
  colorPrimary,
  colorTextBody,
  colorTextMuted,
  EmptyState,
  ErrorText,
  MutedText,
  radiusMd,
  SuccessText,
  Textarea,
} from '../../../components/ui';

const POLL_INTERVAL_MS = 4000;

type LoadOptions = {
  silent?: boolean;
};

export default function InboxPage() {
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takeoverMessage, setTakeoverMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const selectedConversationIdRef = useRef<string | null>(null);
  // Bumped on every conversations load; a resolved response is applied only
  // while it is still the latest, so an older org's in-flight load can't
  // overwrite the current org's data after a switch (or a newer poll).
  const loadSeqRef = useRef(0);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  const selectedConversation = useMemo(
    () =>
      conversations.find(
        (conversation) => conversation.id === selectedConversationId,
      ) ?? null,
    [conversations, selectedConversationId],
  );

  const loadConversations = useCallback(async (options: LoadOptions = {}) => {
    const seq = ++loadSeqRef.current;
    if (!options.silent) {
      setConversationsLoading(true);
    }

    try {
      const data = await listInboxConversations();
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setConversations(data);
      setSelectedConversationId((current) => {
        if (data.length === 0) {
          return null;
        }
        if (current && data.some((conversation) => conversation.id === current)) {
          return current;
        }

        return data[0].id;
      });
      setLastUpdatedAt(new Date());
      setError(null);
    } catch (err) {
      if (seq !== loadSeqRef.current) {
        return; // a newer load started; drop this stale response
      }
      setError(getApiErrorMessage(err, 'Không thể tải danh sách hội thoại.'));
      if (!options.silent) {
        setConversations([]);
        setSelectedConversationId(null);
      }
    } finally {
      if (!options.silent && seq === loadSeqRef.current) {
        setConversationsLoading(false);
      }
    }
  }, []);

  const loadMessages = useCallback(
    async (conversationId: string, options: LoadOptions = {}) => {
      if (!options.silent) {
        setMessagesLoading(true);
      }

      try {
        const data = await listInboxMessages(conversationId);
        if (selectedConversationIdRef.current === conversationId) {
          setMessages(data);
          setLastUpdatedAt(new Date());
          setError(null);
        }
      } catch (err) {
        if (selectedConversationIdRef.current === conversationId) {
          setError(getApiErrorMessage(err, 'Không thể tải tin nhắn.'));
          if (!options.silent) {
            setMessages([]);
          }
        }
      } finally {
        if (
          !options.silent &&
          selectedConversationIdRef.current === conversationId
        ) {
          setMessagesLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    function handleSessionChanged(event?: Event) {
      if (event && isForeignStorageEvent(event)) {
        return;
      }
      setSelectedConversationId(null);
      setMessages([]);
      setTakeoverMessage(null);
      void loadConversations();
    }

    void loadConversations();
    window.addEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
    window.addEventListener('storage', handleSessionChanged);

    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, handleSessionChanged);
      window.removeEventListener('storage', handleSessionChanged);
    };
  }, [loadConversations]);

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }

    setMessages([]);
    setTakeoverMessage(null);
    void loadMessages(selectedConversationId);
  }, [loadMessages, selectedConversationId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadConversations({ silent: true });

      const conversationId = selectedConversationIdRef.current;
      if (conversationId) {
        void loadMessages(conversationId, { silent: true });
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [loadConversations, loadMessages]);

  function patchConversation(updatedConversation: InboxConversation) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === updatedConversation.id
          ? {
              ...conversation,
              ...updatedConversation,
              contact: updatedConversation.contact ?? conversation.contact,
              channelConnection:
                updatedConversation.channelConnection ??
                conversation.channelConnection,
            }
          : conversation,
      ),
    );
  }

  async function handleTakeover() {
    if (!selectedConversation) {
      return;
    }

    setTakingOver(true);
    setTakeoverMessage(null);
    setError(null);

    try {
      const updatedConversation = await takeoverInboxConversation(
        selectedConversation.id,
      );
      patchConversation(updatedConversation);
      setTakeoverMessage('Đã tạm dừng bot cho cuộc hội thoại này.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể tiếp quản hội thoại.'));
    } finally {
      setTakingOver(false);
    }
  }

  async function handleResume() {
    if (!selectedConversation) {
      return;
    }

    setResuming(true);
    setTakeoverMessage(null);
    setError(null);

    try {
      const updatedConversation = await resumeInboxConversation(
        selectedConversation.id,
      );
      patchConversation(updatedConversation);
      setTakeoverMessage('Đã bật lại bot cho cuộc hội thoại này.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể bật lại bot.'));
    } finally {
      setResuming(false);
    }
  }

  async function handleSendMessage() {
    if (!selectedConversation || sending || !replyText.trim()) {
      return;
    }

    const conversationId = selectedConversation.id;
    setSending(true);
    setError(null);

    try {
      const sentMessage = await sendInboxMessage(
        conversationId,
        replyText.trim(),
      );
      // Only append to the thread we sent to; if the user switched threads
      // mid-send, skip the optimistic append (the poll reconciles the correct
      // thread). replyText/sending are still reset below.
      if (selectedConversationIdRef.current === conversationId) {
        setMessages((current) => [...current, sentMessage]);
      }
      setReplyText('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Không thể gửi tin nhắn.'));
    } finally {
      setSending(false);
    }
  }

  return (
    <main>
      <header>
        <h1 style={{ margin: 0, fontSize: 32 }}>Hộp thư</h1>
        <p style={{ color: '#475569', fontSize: 18, maxWidth: 760 }}>
          Theo dõi hội thoại Facebook/Instagram theo tổ chức đang chọn. Trang tự
          tải lại mỗi 4 giây khi đang mở.
        </p>
        {lastUpdatedAt ? (
          <MutedText>
            Đồng bộ lần cuối: {formatDateTime(lastUpdatedAt.toISOString())}
          </MutedText>
        ) : null}
      </header>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {takeoverMessage ? <SuccessText>{takeoverMessage}</SuccessText> : null}

      <div style={layoutStyle}>
        <Card>
          <div style={panelHeaderStyle}>
            <h2 style={{ fontSize: 22, margin: 0 }}>Cuộc hội thoại</h2>
            <Button
              variant="secondary"
              onClick={() => void loadConversations()}
              disabled={conversationsLoading}
            >
              {conversationsLoading ? 'Đang tải...' : 'Tải lại'}
            </Button>
          </div>

          {conversationsLoading ? (
            <MutedText>Đang tải hội thoại...</MutedText>
          ) : conversations.length === 0 ? (
            <EmptyState style={{ fontSize: 15 }}>Chưa có hội thoại nào.</EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {conversations.map((conversation) => {
                const active = conversation.id === selectedConversationId;

                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => setSelectedConversationId(conversation.id)}
                    style={{
                      ...conversationButtonStyle,
                      borderColor: active ? colorPrimary : colorBorder,
                      background: active ? '#eff6ff' : colorBackgroundCard,
                    }}
                  >
                    <span style={conversationTitleStyle}>
                      {getConversationName(conversation)}
                    </span>
                    <span style={conversationMetaStyle}>
                      {formatChannel(conversation.channel)} ·{' '}
                      {conversation.botPaused ? 'Bot tạm dừng' : 'Bot đang chạy'}
                    </span>
                    <span style={conversationMetaStyle}>
                      {conversation.lastMessageAt
                        ? formatDateTime(conversation.lastMessageAt)
                        : 'Chưa có tin nhắn'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card style={{ minHeight: 520 }}>
          {selectedConversation ? (
            <>
              <div style={threadHeaderStyle}>
                <div>
                  <h2 style={{ fontSize: 22, margin: 0 }}>
                    {getConversationName(selectedConversation)}
                  </h2>
                  <p style={{ color: colorTextMuted, margin: '6px 0 0' }}>
                    {formatChannel(selectedConversation.channel)} · Trạng thái:{' '}
                    {selectedConversation.status} ·{' '}
                    {getContactHandle(selectedConversation)}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    variant="primary"
                    onClick={() => void handleTakeover()}
                    disabled={takingOver || selectedConversation.botPaused}
                  >
                    {takingOver
                      ? 'Đang tiếp quản...'
                      : selectedConversation.botPaused
                        ? 'Đã tiếp quản'
                        : 'Tiếp quản'}
                  </Button>
                  {selectedConversation.botPaused ? (
                    <Button
                      variant="secondary"
                      onClick={() => void handleResume()}
                      disabled={resuming}
                    >
                      {resuming ? 'Đang bật bot...' : 'Bật lại bot'}
                    </Button>
                  ) : null}
                </div>
              </div>

              {messagesLoading ? (
                <MutedText>Đang tải tin nhắn...</MutedText>
              ) : messages.length === 0 ? (
                <EmptyState style={{ fontSize: 15 }}>
                  Chưa có tin nhắn trong hội thoại.
                </EmptyState>
              ) : (
                <div style={messagesStyle}>
                  {messages.map((message) => {
                    const outbound = message.direction === 'outbound';

                    return (
                      <div
                        key={message.id}
                        style={{
                          display: 'flex',
                          justifyContent: outbound ? 'flex-end' : 'flex-start',
                        }}
                      >
                        <article
                          style={{
                            ...messageBubbleStyle,
                            background: outbound ? '#dbeafe' : colorBackgroundSubtle,
                            borderColor: outbound ? '#bfdbfe' : colorBorder,
                          }}
                        >
                          <p style={messageMetaStyle}>
                            {formatSender(message)} ·{' '}
                            {formatDateTime(message.createdAt)}
                          </p>
                          <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                            {formatMessageBody(message)}
                          </p>
                        </article>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={composeRowStyle}>
                <Textarea
                  value={replyText}
                  onChange={(event) => setReplyText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                  rows={2}
                  placeholder="Nhập tin nhắn trả lời khách..."
                  style={{ flex: 1 }}
                />
                <Button
                  variant="primary"
                  onClick={() => void handleSendMessage()}
                  disabled={sending || !replyText.trim()}
                >
                  {sending ? 'Đang gửi...' : 'Gửi'}
                </Button>
              </div>
              {!selectedConversation.botPaused ? (
                <p style={hintTextStyle}>
                  Bot vẫn đang chạy — AI có thể trả lời đè lên tin nhắn của
                  bạn. Bấm &quot;Tiếp quản&quot; trước nếu muốn chắc chắn.
                </p>
              ) : null}
            </>
          ) : (
            <EmptyState style={{ fontSize: 15 }}>
              Chọn một hội thoại bên trái để xem tin nhắn.
            </EmptyState>
          )}
        </Card>
      </div>
    </main>
  );
}

function getApiErrorMessage(err: unknown, fallback: string) {
  return err instanceof ApiClientError ? err.message : fallback;
}

function getConversationName(conversation: InboxConversation) {
  return (
    conversation.contact?.displayName ??
    conversation.contact?.pageScopedId ??
    conversation.contact?.igScopedId ??
    `Hội thoại ${conversation.id.slice(0, 8)}`
  );
}

function getContactHandle(conversation: InboxConversation) {
  return (
    conversation.contact?.pageScopedId ??
    conversation.contact?.igScopedId ??
    conversation.channelConnection?.externalPageId ??
    'Không rõ khách'
  );
}

function formatChannel(channel: string) {
  if (channel === 'messenger') {
    return 'Messenger';
  }
  if (channel === 'instagram') {
    return 'Instagram';
  }
  if (channel === 'zalo') {
    return 'Zalo';
  }

  return channel;
}

function formatSender(message: InboxMessage) {
  const senderLabels: Record<string, string> = {
    ai: 'AI',
    customer: 'Khách',
    staff: 'Nhân viên',
    system: 'Hệ thống',
  };

  return senderLabels[message.senderType] ?? message.senderType;
}

function formatMessageBody(message: InboxMessage) {
  const text = message.bodyText?.trim();
  return text ? text : `[${message.rawType}]`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

const layoutStyle: CSSProperties = {
  alignItems: 'start',
  display: 'grid',
  gap: 24,
  gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)',
  marginTop: 28,
};

const panelHeaderStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 12,
  justifyContent: 'space-between',
  marginBottom: 16,
};

const threadHeaderStyle: CSSProperties = {
  alignItems: 'flex-start',
  borderBottom: `1px solid ${colorBorder}`,
  display: 'flex',
  gap: 16,
  justifyContent: 'space-between',
  margin: '-4px -4px 18px',
  padding: '4px 4px 16px',
};

const conversationButtonStyle: CSSProperties = {
  border: `1px solid ${colorBorder}`,
  borderRadius: 12,
  color: colorTextBody,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 14,
  textAlign: 'left',
};

const conversationTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
};

const conversationMetaStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 13,
};

const messagesStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const messageBubbleStyle: CSSProperties = {
  border: `1px solid ${colorBorder}`,
  borderRadius: radiusMd,
  color: colorTextBody,
  maxWidth: 'min(680px, 82%)',
  padding: '10px 12px',
};

const messageMetaStyle: CSSProperties = {
  color: colorTextMuted,
  fontSize: 12,
  fontWeight: 700,
  margin: 0,
};

const composeRowStyle: CSSProperties = {
  borderTop: `1px solid ${colorBorder}`,
  display: 'flex',
  gap: 10,
  marginTop: 16,
  paddingTop: 16,
};

const hintTextStyle: CSSProperties = {
  color: '#94a3b8',
  fontSize: 13,
  marginTop: 8,
};
