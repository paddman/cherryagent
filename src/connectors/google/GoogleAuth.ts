export type GoogleAuthConfig = {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  tokenEndpoint?: string;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export class GoogleAuth {
  #cachedToken?: CachedToken;

  constructor(private readonly config: GoogleAuthConfig) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.accessToken ||
        (this.config.clientId && this.config.clientSecret && this.config.refreshToken),
    );
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.config.accessToken && !forceRefresh) return this.config.accessToken;

    const now = Date.now();
    if (!forceRefresh && this.#cachedToken && this.#cachedToken.expiresAt > now + 60_000) {
      return this.#cachedToken.value;
    }

    const { clientId, clientSecret, refreshToken } = this.config;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Google Workspace is not configured. Set CHERRY_GOOGLE_ACCESS_TOKEN or CHERRY_GOOGLE_CLIENT_ID, CHERRY_GOOGLE_CLIENT_SECRET, and CHERRY_GOOGLE_REFRESH_TOKEN.",
      );
    }

    const response = await fetch(this.config.tokenEndpoint ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data = (await response.json()) as TokenResponse;
    if (!response.ok || !data.access_token) {
      const detail = data.error_description ?? data.error ?? `HTTP ${response.status}`;
      throw new Error(`Google OAuth token refresh failed: ${detail}`);
    }

    this.#cachedToken = {
      value: data.access_token,
      expiresAt: now + Math.max(60, data.expires_in ?? 3600) * 1000,
    };
    return data.access_token;
  }

  async authorizedFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const request = async (forceRefresh: boolean): Promise<Response> => {
      const token = await this.getAccessToken(forceRefresh);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    };

    let response = await request(false);
    if (response.status === 401 && !this.config.accessToken) {
      this.#cachedToken = undefined;
      response = await request(true);
    }
    return response;
  }
}
