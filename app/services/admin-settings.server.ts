import type { AutomationSettings, Shop } from "@prisma/client";
import prisma from "../db.server";
import { getShopifyAppEnv } from "../lib/env.server";
import { ensureShop } from "./shop.server";
import {
  getConfiguredProviderKind,
  getEmailProvider,
  isEmailSendingEnabled,
} from "./email-provider.server";

export type SettingsFormFields = {
  sendingEmailAddress: string;
  fromName: string;
  replyTo: string;
  timezone: string;
  syncIntervalMinutes: number;
  dataRetentionDays: number;
  emailProviderLabel: string;
};

export function settingsToSettingsForm(
  shop: Shop,
  settings: AutomationSettings | null,
): SettingsFormFields {
  return {
    sendingEmailAddress: settings?.sendingEmailAddress ?? "",
    fromName: settings?.fromName ?? "",
    replyTo: settings?.replyTo ?? settings?.contactEmail ?? "",
    timezone: shop.timezone || "UTC",
    syncIntervalMinutes: settings?.syncIntervalMinutes ?? 360,
    dataRetentionDays: settings?.dataRetentionDays ?? 365,
    emailProviderLabel: settings?.emailProviderLabel ?? "dry_run",
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function readSettingsForm(form: FormData): SettingsFormFields {
  const str = (key: string) => String(form.get(key) ?? "").trim();
  return {
    sendingEmailAddress: str("sendingEmailAddress"),
    fromName: str("fromName"),
    replyTo: str("replyTo"),
    timezone: str("timezone") || "UTC",
    syncIntervalMinutes: clampInt(form.get("syncIntervalMinutes"), 15, 10080, 360),
    dataRetentionDays: clampInt(form.get("dataRetentionDays"), 30, 2555, 365),
    emailProviderLabel: str("emailProviderLabel") || "dry_run",
  };
}

export async function saveAdminSettings(
  shopDomain: string,
  formData: FormData,
): Promise<{ shop: Shop; settings: AutomationSettings }> {
  const shop = await ensureShop(shopDomain);
  const fields = readSettingsForm(formData);

  const [updatedShop, settings] = await prisma.$transaction([
    prisma.shop.update({
      where: { id: shop.id },
      data: { timezone: fields.timezone },
    }),
    prisma.automationSettings.update({
      where: { shopId: shop.id },
      data: {
        sendingEmailAddress: fields.sendingEmailAddress || null,
        fromName: fields.fromName || null,
        replyTo: fields.replyTo || null,
        contactEmail: fields.replyTo || null,
        syncIntervalMinutes: fields.syncIntervalMinutes,
        dataRetentionDays: fields.dataRetentionDays,
        emailProviderLabel: "shopify_messaging",
      },
    }),
  ]);

  return { shop: updatedShop, settings };
}

export function getConnectionStatus() {
  const env = getShopifyAppEnv();
  const configuredKind = getConfiguredProviderKind();
  const provider = getEmailProvider();
  return {
    emailSendingEnabled: isEmailSendingEnabled(),
    configuredKind,
    providerName: provider.name,
    liveDelivery:
      isEmailSendingEnabled() &&
      provider.name !== "dry_run" &&
      provider.name !== "unapproved",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    shopifyApiKeyConfigured: Boolean(env.SHOPIFY_API_KEY),
  };
}
