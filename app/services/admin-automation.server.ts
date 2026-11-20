import type { AutomationSettings, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { ensureShop } from "./shop.server";

export type AutomationFormFields = {
  automationEnabled: boolean;
  intervalDays: number;
  productsPerEmail: number;
  randomSelection: boolean;
  inStockOnly: boolean;
  preventDuplicates: boolean;
  autoResetCycle: boolean;
  testMode: boolean;
  appSchedulerEnabled: boolean;
  maxEmailsPerDay: number;
  maxEmailsPerHour: number;
  maxEmailsPerRun: number;
};

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function settingsToAutomationForm(
  settings: AutomationSettings | null,
): AutomationFormFields {
  return {
    automationEnabled: settings?.automationEnabled ?? false,
    intervalDays: settings?.intervalDays ?? 3,
    productsPerEmail: settings?.productsPerEmail ?? 6,
    randomSelection: settings?.randomSelection ?? true,
    inStockOnly: settings?.inStockOnly ?? true,
    preventDuplicates: settings?.preventDuplicates ?? true,
    autoResetCycle: settings?.autoResetCycle ?? true,
    testMode: settings?.testMode ?? true,
    appSchedulerEnabled: settings?.appSchedulerEnabled ?? false,
    maxEmailsPerDay: settings?.maxEmailsPerDay ?? 500,
    maxEmailsPerHour: settings?.maxEmailsPerHour ?? 200,
    maxEmailsPerRun: settings?.maxEmailsPerRun ?? 50,
  };
}

export function readAutomationForm(form: FormData): AutomationFormFields {
  const on = (key: string) => form.get(key) === "on" || form.get(key) === "true";
  return {
    automationEnabled: on("automationEnabled"),
    intervalDays: clampInt(form.get("intervalDays"), 1, 30, 3),
    productsPerEmail: clampInt(form.get("productsPerEmail"), 1, 12, 6),
    randomSelection: on("randomSelection"),
    inStockOnly: on("inStockOnly"),
    preventDuplicates: on("preventDuplicates"),
    autoResetCycle: on("autoResetCycle"),
    testMode: on("testMode"),
    appSchedulerEnabled: on("appSchedulerEnabled"),
    maxEmailsPerDay: clampInt(form.get("maxEmailsPerDay"), 1, 10000, 500),
    maxEmailsPerHour: clampInt(form.get("maxEmailsPerHour"), 1, 5000, 200),
    maxEmailsPerRun: clampInt(form.get("maxEmailsPerRun"), 1, 500, 50),
  };
}

export async function saveAutomationSettings(
  shopDomain: string,
  formData: FormData,
): Promise<AutomationSettings> {
  const shop = await ensureShop(shopDomain);
  const fields = readAutomationForm(formData);
  const data: Prisma.AutomationSettingsUpdateInput = {
    automationEnabled: fields.automationEnabled,
    intervalDays: fields.intervalDays,
    productsPerEmail: fields.productsPerEmail,
    randomSelection: fields.randomSelection,
    inStockOnly: fields.inStockOnly,
    preventDuplicates: fields.preventDuplicates,
    autoResetCycle: fields.autoResetCycle,
    testMode: fields.testMode,
    appSchedulerEnabled: fields.appSchedulerEnabled,
    dryRun: true,
    emailProviderLabel: "shopify_messaging",
    maxEmailsPerDay: fields.maxEmailsPerDay,
    maxEmailsPerHour: fields.maxEmailsPerHour,
    maxEmailsPerRun: fields.maxEmailsPerRun,
  };

  return prisma.automationSettings.update({
    where: { shopId: shop.id },
    data,
  });
}
