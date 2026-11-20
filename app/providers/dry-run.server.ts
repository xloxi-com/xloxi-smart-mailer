/**
 * DryRunEmailProvider — default when EMAIL_SENDING_ENABLED is false.
 * Records intent with hashed recipient; never opens network sockets.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  DeliveryEvent,
  EmailProvider,
  MessageStatus,
  SendMarketingEmailInput,
  SendResult,
} from "../services/email-provider.server";
import { logger } from "../lib/logging.server";

function toHash(to: string): string {
  return createHash("sha256").update(to.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function createDryRunEmailProvider(): EmailProvider {
  return {
    name: "dry_run",

    async sendMarketingEmail(input: SendMarketingEmailInput): Promise<SendResult> {
      const providerMessageId = `dryrun_${randomUUID()}`;
      logger.info("dry_run_email_accepted", {
        provider: "dry_run",
        shop: input.shopDomain,
        emailJobId: input.emailJobId,
        idempotencyKey: input.idempotencyKey,
        toHash: toHash(input.to),
        subjectLength: input.subject.length,
        htmlLength: input.html.length,
        textLength: input.text.length,
        providerMessageId,
      });
      return {
        status: "accepted",
        providerMessageId,
        retryable: false,
      };
    },

    async getMessageStatus(providerMessageId: string): Promise<MessageStatus> {
      if (!providerMessageId.startsWith("dryrun_")) {
        return { providerMessageId, state: "unknown" };
      }
      return { providerMessageId, state: "accepted" };
    },

    async verifyWebhook(): Promise<{ ok: boolean; reason?: string }> {
      return { ok: false, reason: "dry_run_no_webhooks" };
    },

    async processDeliveryEvent(): Promise<DeliveryEvent[]> {
      return [];
    },

    async synchronizeSuppression(): Promise<{ synced: number }> {
      return { synced: 0 };
    },
  };
}
