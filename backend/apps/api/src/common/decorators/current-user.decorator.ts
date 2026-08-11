import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export type AuthenticatedUser = {
  id: string;
  email?: string;
};

type RequestWithUser = {
  user?: AuthenticatedUser;
};

export const CurrentUser = createParamDecorator<
  keyof AuthenticatedUser | undefined
>((field, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithUser>();
  if (!field) {
    return request.user;
  }
  return request.user?.[field];
});
