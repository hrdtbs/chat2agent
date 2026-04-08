import type {
  DevinBackend,
  DevinSessionMessage,
  DevinSessionSnapshot,
  SessionResult,
} from "../types.js";

/**
 * Devin API v3 — Create Session
 * @see https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md
 * Base URL: https://docs.devin.ai/api-reference/v3/overview.md
 */
export type DevinClientConfig = {
  apiKey: string;
  orgId: string;
  /** Default `https://api.devin.ai` */
  baseUrl?: string;
};

export function createDevinBackend(config: DevinClientConfig): DevinBackend {
  const base = (config.baseUrl ?? "https://api.devin.ai").replace(/\/$/, "");
  const orgPath = `${base}/v3/organizations/${encodeURIComponent(config.orgId)}`;

  async function parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Devin API: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  return {
    async createSession(input: {
      prompt: string;
      repos?: string[];
      title?: string;
    }): Promise<SessionResult> {
      const url = `${orgPath}/sessions`;
      const body: Record<string, unknown> = {
        prompt: input.prompt,
      };
      if (input.repos?.length) body.repos = input.repos;
      if (input.title) body.title = input.title;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const json = (await parseJson(res)) as Record<string, unknown>;

      if (!res.ok) {
        const detail =
          "detail" in json ? JSON.stringify(json.detail) : JSON.stringify(json);
        throw new Error(`Devin API ${res.status}: ${detail}`);
      }

      const o = json as {
        session_id?: string;
        url?: string;
      };
      if (!o.session_id || !o.url) {
        throw new Error(`Devin API: unexpected shape: ${JSON.stringify(json).slice(0, 300)}`);
      }
      return { id: o.session_id, url: o.url, raw: json };
    },

    async getSession(sessionId: string): Promise<DevinSessionSnapshot> {
      const url = `${orgPath}/sessions/${encodeURIComponent(sessionId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      const json = (await parseJson(res)) as Record<string, unknown>;
      if (!res.ok) {
        const detail =
          "detail" in json ? JSON.stringify(json.detail) : JSON.stringify(json);
        throw new Error(`Devin API ${res.status}: ${detail}`);
      }
      const o = json as {
        session_id?: string;
        url?: string;
        status?: string;
        status_detail?: string | null;
      };
      if (!o.session_id || !o.status) {
        throw new Error(`Devin API: unexpected get session shape`);
      }
      return {
        sessionId: o.session_id,
        url: o.url ?? "",
        status: o.status,
        statusDetail: o.status_detail ?? null,
      };
    },

    async listSessionMessages(
      sessionId: string,
      options?: { first?: number; after?: string | null },
    ): Promise<{
      items: DevinSessionMessage[];
      hasNextPage: boolean;
      endCursor?: string | null;
    }> {
      const u = new URL(`${orgPath}/sessions/${encodeURIComponent(sessionId)}/messages`);
      if (options?.first != null) u.searchParams.set("first", String(options.first));
      if (options?.after) u.searchParams.set("after", options.after);

      const res = await fetch(u.toString(), {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      const json = (await parseJson(res)) as Record<string, unknown>;
      if (!res.ok) {
        const detail =
          "detail" in json ? JSON.stringify(json.detail) : JSON.stringify(json);
        throw new Error(`Devin API ${res.status}: ${detail}`);
      }
      const items = (json.items as DevinSessionMessage[] | undefined) ?? [];
      return {
        items,
        hasNextPage: Boolean(json.has_next_page),
        endCursor: (json.end_cursor as string | null | undefined) ?? null,
      };
    },

    async sendSessionMessage(sessionId: string, message: string): Promise<void> {
      const url = `${orgPath}/sessions/${encodeURIComponent(sessionId)}/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });
      const json = await parseJson(res);
      if (!res.ok) {
        const o = json as Record<string, unknown>;
        const detail =
          "detail" in o ? JSON.stringify(o.detail) : JSON.stringify(json);
        throw new Error(`Devin API ${res.status}: ${detail}`);
      }
    },
  };
}
