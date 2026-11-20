/**
 * In-memory MockEmailProvider for development and integration tests.
 * Never contacts a network ESP. Does not log raw recipient addresses.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  DeliveryEvent,
  EmailProvider,
  MessageStatus,
  SendMarketingEmailInput,
  SendResult,
  SuppressionSyncItem,
} from "../services/email-provider.server";
import { logger } from "../lib/logging.server";

export type MockSendRecord = {
  idempotencyKey: string;
  providerMessageId: string;
  subject: string;
  toHash: string;
  emailJobId: string;
  shopDomain: string;
  acceptedAt: Date;
  state: MessageStatus["state"];
};

type MockStore = {
  byIdempotency: Map<string, MockSendRecord>;
  byMessageId: Map<string, MockSendRecord>;
  events: DeliveryEvent[];
  suppressions: Map<string, SuppressionSyncItem>;
  /** Force next send outcome for tests. */
  nextSendResult?: SendResult | null;
  failWebhookVerify?: boolean;
};

const globalStore: MockStore = {
  byIdempotency: new Map(),
  byMessageId: new Map(),
  events: [],
  suppressions: new Map(),
};

function hashRecipient(to: string): string {
  return createHash("sha256").update(to.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function resetMockEmailProviderStore(): void {
  globalStore.byIdempotency.clear();
  globalStore.byMessageId.clear();
  globalStore.events = [];
  globalStore.suppressions.clear();
  globalStore.nextSendResult = null;
  globalStore.failWebhookVerify = false;
}

export function getMockEmailProviderStore(): MockStore {
  return globalStore;
}

export function setMockNextSendResult(result: SendResult | null): void {
  globalStore.nextSendResult = result;
}

export function createMockEmailProvider(): EmailProvider {
  return {
    name: "mock",

    async sendMarketingEmail(input: SendMarketingEmailInput): Promise<SendResult> {
      if (globalStore.nextSendResult) {
        const forced = globalStore.nextSendResult;
        globalStore.nextSendResult = null;
        return forced;
      }

      const existing = globalStore.byIdempotency.get(input.idempotencyKey);
      if (existing) {
        return {
          status: "accepted",
          providerMessageId: existing.providerMessageId,
          retryable: false,
        };
      }

      const providerMessageId = `mock_${randomUUID()}`;
      const record: MockSendRecord = {
        idempotencyKey: input.idempotencyKey,
        providerMessageId,
        subject: input.subject,
        toHash: hashRecipient(input.to),
        emailJobId: input.emailJobId,
        shopDomain: input.shopDomain,
        acceptedAt: new Date(),
        state: "accepted",
      };
      globalStore.byIdempotency.set(input.idempotencyKey, record);
      globalStore.byMessageId.set(providerMessageId, record);

      logger.info("mock_email_accepted", {
        provider: "mock",
        emailJobId: input.emailJobId,
        shop: input.shopDomain,
        toHash: record.toHash,
        providerMessageId,
      });

      return {
        status: "accepted",
        providerMessageId,
        retryable: false,
      };
    },

    async getMessageStatus(providerMessageId: string): Promise<MessageStatus> {
      const record = globalStore.byMessageId.get(providerMessageId);
      if (!record) {
        return { providerMessageId, state: "unknown", detail: "not_found" };
      }
      return { providerMessageId, state: record.state };
    },

    async verifyWebhook(request: Request): Promise<{ ok: boolean; reason?: string }> {
      if (globalStore.failWebhookVerify) {
        return { ok: false, reason: "mock_verify_failed" };
      }
      const sig = request.headers.get("x-mock-email-signature");
      if (sig !== "mock-ok") {
        return { ok: false, reason: "invalid_signature" };
      }
      return { ok: true };
    },

    async processDeliveryEvent(request: Request): Promise<DeliveryEvent[]> {
      const body = (await request.json()) as {
        events?: Array<{
          id: string;
          messageId?: string;
          type: DeliveryEvent["type"];
          occurredAt?: string;
          emailNormalizedHint?: string;
        }>;
      };
      const events: DeliveryEvent[] = (body.events ?? []).map((e) => {
        const event: DeliveryEvent = {
          providerEventId: e.id,
          providerMessageId: e.messageId,
          type: e.type,
          occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
          emailNormalizedHint: e.emailNormalizedHint,
          safeMeta: { source: "mock" },
        };
        if (e.messageId) {
          const record = globalStore.byMessageId.get(e.messageId);
          if (record) {
            if (e.type === "delivered") record.state = "delivered";
            if (e.type === "bounced") record.state = "bounced";
            if (e.type === "complained") record.state = "complained";
            if (e.type === "failed") record.state = "failed";
          }
        }
        globalStore.events.push(event);
        return event;
      });
      return events;
    },

    async synchronizeSuppression(options: {
      shopDomain: string;
      items: SuppressionSyncItem[];
    }): Promise<{ synced: number }> {
      for (const item of options.items) {
        globalStore.suppressions.set(
          `${options.shopDomain}:${item.emailNormalized}:${item.reason}`,
          item,
        );
      }
      return { synced: options.items.length };
    },
  };
}
