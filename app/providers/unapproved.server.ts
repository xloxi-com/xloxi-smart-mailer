/**
 * Refuses live sends until a compatible ESP is selected, documented for the
 * merchant product category, and EMAIL_PROVIDER_APPROVED=true.
 * Does not invent Shopify Messaging or any undocumented endpoints.
 */
import type {
  DeliveryEvent,
  EmailProvider,
  MessageStatus,
  SendMarketingEmailInput,
  SendResult,
} from "../services/email-provider.server";
import { logger } from "../lib/logging.server";

export function createUnapprovedEmailProvider(
  requestedKind: string,
): EmailProvider {
  return {
    name: `unapproved:${requestedKind}`,

    async sendMarketingEmail(input: SendMarketingEmailInput): Promise<SendResult> {
      logger.error("email_send_blocked_unapproved_provider", {
        requestedKind,
        shop: input.shopDomain,
        emailJobId: input.emailJobId,
      });
      return {
        status: "rejected",
        retryable: false,
        errorCode: "provider_unapproved",
        errorMessage:
          "Live email provider is not approved. Keep EMAIL_SENDING_ENABLED=false until a compatible marketing ESP is selected and documented.",
      };
    },

    async getMessageStatus(providerMessageId: string): Promise<MessageStatus> {
      return { providerMessageId, state: "unknown", detail: "unapproved" };
    },

    async verifyWebhook(): Promise<{ ok: boolean; reason?: string }> {
      return { ok: false, reason: "unapproved_provider" };
    },

    async processDeliveryEvent(): Promise<DeliveryEvent[]> {
      return [];
    },

    async synchronizeSuppression(): Promise<{ synced: number }> {
      return { synced: 0 };
    },
  };
}
