import { loadEnv } from "../../config/env";

export type GraphClientConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
  mode?: "live" | "stub";
  fetch?: typeof fetch;
};

export type MetaAccessTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
};

export type MetaDebugTokenResponse = {
  data: {
    app_id?: string;
    type?: string;
    is_valid?: boolean;
    expires_at?: number;
    scopes?: string[];
    user_id?: string;
  };
};

export type MetaManagedPage = {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
};

export type MetaManagedPagesResponse = {
  data: MetaManagedPage[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
};

export type MetaPageAccessTokenResponse = {
  id: string;
  access_token: string;
};

export type MetaSendMessageInput = {
  accessToken: string;
  recipientId: string;
  senderId: string;
  text: string;
};

export type MetaSendMessageResponse = {
  message_id?: string;
  recipient_id?: string;
};

export class GraphClient {
  constructor(private readonly config: GraphClientConfig) {}

  private get isStub() {
    return this.config.mode === "stub";
  }

  private get fetchFn(): typeof fetch {
    return this.config.fetch ?? fetch;
  }

  private graphUrl(path: string, params?: Record<string, string>): URL {
    const url = new URL(
      `https://graph.facebook.com/${this.config.graphVersion}/${path.replace(/^\//, "")}`,
    );
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  async exchangeCodeForToken(code: string): Promise<MetaAccessTokenResponse> {
    if (this.isStub) {
      return {
        access_token: `local-user-token-${code.slice(0, 12) || "default"}`,
        token_type: "bearer",
        expires_in: 3_600,
      };
    }

    const url = this.graphUrl("oauth/access_token", {
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      client_secret: this.config.appSecret,
      code,
    });
    const res = await this.fetchFn(url.toString());
    if (!res.ok) {
      throw new Error(`Meta token exchange failed: ${res.status}`);
    }
    return (await res.json()) as MetaAccessTokenResponse;
  }

  async debugToken(inputToken: string): Promise<MetaDebugTokenResponse> {
    if (this.isStub) {
      return {
        data: {
          app_id: this.config.appId,
          type: "USER",
          is_valid: inputToken.startsWith("local-user-token-"),
          scopes: ["pages_messaging", "instagram_manage_messages"],
          user_id: "local-meta-user",
        },
      };
    }

    const url = new URL("https://graph.facebook.com/debug_token");
    url.searchParams.set("input_token", inputToken);
    url.searchParams.set(
      "access_token",
      `${this.config.appId}|${this.config.appSecret}`,
    );
    const res = await this.fetchFn(url.toString());
    if (!res.ok) {
      throw new Error(`Meta debug_token failed: ${res.status}`);
    }
    return (await res.json()) as MetaDebugTokenResponse;
  }

  async getManagedPages(userToken: string): Promise<MetaManagedPagesResponse> {
    if (this.isStub) {
      return {
        data: [
          {
            id: "local-meta-page",
            name: "Local Meta Page",
            access_token: `local-page-token-${userToken.slice(-8)}`,
          },
        ],
      };
    }

    const url = this.graphUrl("me/accounts", {
      access_token: userToken,
      fields: "id,name,access_token,instagram_business_account",
    });
    const res = await this.fetchFn(url.toString());
    if (!res.ok) {
      throw new Error(`Meta getManagedPages failed: ${res.status}`);
    }
    return (await res.json()) as MetaManagedPagesResponse;
  }

  async getPageAccessToken(
    pageId: string,
    userToken: string,
  ): Promise<MetaPageAccessTokenResponse> {
    if (this.isStub) {
      return {
        id: pageId,
        access_token: `local-page-token-${userToken.slice(-8)}`,
      };
    }

    const url = this.graphUrl(pageId, {
      fields: "access_token",
      access_token: userToken,
    });
    const res = await this.fetchFn(url.toString());
    if (!res.ok) {
      throw new Error(`Meta getPageAccessToken failed: ${res.status}`);
    }
    return (await res.json()) as MetaPageAccessTokenResponse;
  }

  async sendMessage(input: MetaSendMessageInput): Promise<MetaSendMessageResponse> {
    if (this.isStub) {
      return {
        message_id: `local-meta-message-${input.recipientId}-${input.senderId}`,
        recipient_id: input.recipientId,
      };
    }

    const url = this.graphUrl(`${input.senderId}/messages`, {
      access_token: input.accessToken,
    });
    const res = await this.fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: input.recipientId },
        message: { text: input.text },
      }),
    });
    if (!res.ok) {
      throw new Error(`Meta sendMessage failed: ${res.status}`);
    }

    return (await res.json()) as MetaSendMessageResponse;
  }
}

export function createGraphClientFromEnv(): GraphClient {
  const env = loadEnv();
  return new GraphClient({
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    redirectUri: env.META_REDIRECT_URI,
    graphVersion: env.META_GRAPH_VERSION,
    mode: env.META_INTEGRATION_MODE,
  });
}
