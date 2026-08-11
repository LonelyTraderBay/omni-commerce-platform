import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { InboxController } from './inbox.controller';
import { type InboxService } from './inbox.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';

describe('InboxController sendMessage', () => {
  it('delegates POST /v1/inbox/conversations/:id/messages to the service with the caller identity and parsed body', async () => {
    const service = {
      sendMessage: vi.fn(async () => ({
        message: { id: 'msg-1', bodyText: 'Xin chào' },
      })),
    } as unknown as InboxService;
    const controller = new InboxController(service);

    const result = await controller.sendMessage(
      ORG_ID,
      { id: USER_ID },
      CONVERSATION_ID,
      { text: 'Xin chào' },
    );

    expect(service.sendMessage).toHaveBeenCalledWith({
      orgId: ORG_ID,
      actorUserId: USER_ID,
      conversationId: CONVERSATION_ID,
      body: { text: 'Xin chào' },
    });
    expect(result).toEqual({ message: { id: 'msg-1', bodyText: 'Xin chào' } });
  });

  it('rejects a blank or missing text body before ever reaching the service', () => {
    const service = { sendMessage: vi.fn() } as unknown as InboxService;
    const controller = new InboxController(service);

    let thrown: unknown;
    try {
      controller.sendMessage(ORG_ID, { id: USER_ID }, CONVERSATION_ID, {
        text: '   ',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      response: expect.objectContaining({ code: 'validation_error' }),
      status: 400,
    });
    expect(service.sendMessage).not.toHaveBeenCalled();
  });

  it('requires inbox.reply — already granted to owner/cskh and withheld from kho in the authz matrix', () => {
    const permission = Reflect.getMetadata(
      PERMISSION_KEY,
      InboxController.prototype.sendMessage,
    );

    expect(permission).toBe('inbox.reply');
  });
});
