import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { IncomingHttpHeaders } from "node:http";

type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
  code?: string;
};

type ProblemDetailsRequest = {
  headers: IncomingHttpHeaders;
  originalUrl?: string;
  requestId?: string;
  url?: string;
};

type ProblemDetailsResponse = {
  status(statusCode: number): {
    json(body: ProblemDetails): void;
  };
};

const STATUS_TITLES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: "Bad Request",
  [HttpStatus.UNAUTHORIZED]: "Unauthorized",
  [HttpStatus.FORBIDDEN]: "Forbidden",
  [HttpStatus.NOT_FOUND]: "Not Found",
  [HttpStatus.CONFLICT]: "Conflict",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "Unprocessable Entity",
  [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
};

function getHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getStatusTitle(status: number) {
  return STATUS_TITLES[status] ?? "Error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getDetail(responseBody: unknown, exception: HttpException) {
  if (typeof responseBody === "string") {
    return responseBody;
  }

  if (isRecord(responseBody)) {
    if (typeof responseBody.detail === "string") {
      return responseBody.detail;
    }
    if (typeof responseBody.message === "string") {
      return responseBody.message;
    }
    if (Array.isArray(responseBody.message)) {
      return responseBody.message.join(", ");
    }
  }

  return exception.message;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<ProblemDetailsRequest>();
    const response = http.getResponse<ProblemDetailsResponse>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const responseBody = isHttpException ? exception.getResponse() : undefined;
    const responseRecord = isRecord(responseBody) ? responseBody : undefined;
    const code = responseRecord?.code;

    response.status(status).json({
      type: typeof responseRecord?.type === "string" ? responseRecord.type : "about:blank",
      title:
        typeof responseRecord?.title === "string"
          ? responseRecord.title
          : typeof responseRecord?.error === "string"
            ? responseRecord.error
            : getStatusTitle(status),
      status,
      detail: isHttpException
        ? getDetail(responseBody, exception)
        : "Internal server error",
      instance: request.originalUrl ?? request.url ?? "",
      requestId: request.requestId ?? getHeader(request.headers, "x-request-id") ?? "",
      ...(typeof code === "string" ? { code } : {}),
    });
  }
}
