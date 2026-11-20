import type { AutomationSettings, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { ensureShop } from "./shop.server";
import type { EmailBrandConfig } from "../templates/product-email.server";
import { brandConfigFromSettings } from "../templates/product-email.server";

export type BrandingFormFields = {
  brandLogoUrl: string;
  brandPrimaryColor: string;
  brandAccentColor: string;
  brandBackgroundColor: string;
  brandTextColor: string;
  emailSubject: string;
  emailPreheader: string;
  emailHeading: string;
  emailIntroduction: string;
  ctaText: string;
  storefrontDomain: string;
  contactEmail: string;
  privacyPolicyUrl: string;
  unsubscribeUrl: string;
  fromName: string;
};

export function settingsToForm(
  settings: AutomationSettings | null,
): BrandingFormFields {
  return {
    brandLogoUrl: settings?.brandLogoUrl ?? "",
    brandPrimaryColor: settings?.brandPrimaryColor ?? "#111111",
    brandAccentColor: settings?.brandAccentColor ?? "#C4A484",
    brandBackgroundColor: settings?.brandBackgroundColor ?? "#FFFFFF",
    brandTextColor: settings?.brandTextColor ?? "#222222",
    emailSubject: settings?.emailSubject ?? "",
    emailPreheader: settings?.emailPreheader ?? "",
    emailHeading: settings?.emailHeading ?? "",
    emailIntroduction: settings?.emailIntroduction ?? "",
    ctaText: settings?.ctaText ?? "SHOP NOW",
    storefrontDomain: settings?.storefrontDomain ?? "seductiv.net",
    contactEmail: settings?.contactEmail ?? settings?.replyTo ?? "",
    privacyPolicyUrl: settings?.privacyPolicyUrl ?? "",
    unsubscribeUrl: settings?.unsubscribeUrl ?? "",
    fromName: settings?.fromName ?? "SEDUCTIV",
  };
}

export function formToBrandConfig(
  form: BrandingFormFields,
  shopDomain: string,
): EmailBrandConfig {
  return brandConfigFromSettings(
    {
      brandLogoUrl: form.brandLogoUrl || null,
      brandPrimaryColor: form.brandPrimaryColor,
      brandAccentColor: form.brandAccentColor,
      brandBackgroundColor: form.brandBackgroundColor,
      brandTextColor: form.brandTextColor,
      emailSubject: form.emailSubject || null,
      emailPreheader: form.emailPreheader || null,
      emailHeading: form.emailHeading || null,
      emailIntroduction: form.emailIntroduction || null,
      ctaText: form.ctaText || "SHOP NOW",
      storefrontDomain: form.storefrontDomain || "seductiv.net",
      contactEmail: form.contactEmail || null,
      privacyPolicyUrl: form.privacyPolicyUrl || null,
      unsubscribeUrl: form.unsubscribeUrl || null,
      fromName: form.fromName || "SEDUCTIV",
      replyTo: form.contactEmail || null,
    },
    shopDomain,
  );
}

function readForm(form: FormData): BrandingFormFields {
  const str = (key: string) => String(form.get(key) ?? "").trim();
  return {
    brandLogoUrl: str("brandLogoUrl"),
    brandPrimaryColor: str("brandPrimaryColor") || "#111111",
    brandAccentColor: str("brandAccentColor") || "#C4A484",
    brandBackgroundColor: str("brandBackgroundColor") || "#FFFFFF",
    brandTextColor: str("brandTextColor") || "#222222",
    emailSubject: str("emailSubject"),
    emailPreheader: str("emailPreheader"),
    emailHeading: str("emailHeading"),
    emailIntroduction: str("emailIntroduction"),
    ctaText: str("ctaText") || "SHOP NOW",
    storefrontDomain: str("storefrontDomain") || "seductiv.net",
    contactEmail: str("contactEmail"),
    privacyPolicyUrl: str("privacyPolicyUrl"),
    unsubscribeUrl: str("unsubscribeUrl"),
    fromName: str("fromName") || "SEDUCTIV",
  };
}

export async function saveEmailBranding(
  shopDomain: string,
  formData: FormData,
): Promise<AutomationSettings> {
  const shop = await ensureShop(shopDomain);
  const fields = readForm(formData);
  const data: Prisma.AutomationSettingsUpdateInput = {
    brandLogoUrl: fields.brandLogoUrl || null,
    brandPrimaryColor: fields.brandPrimaryColor,
    brandAccentColor: fields.brandAccentColor,
    brandBackgroundColor: fields.brandBackgroundColor,
    brandTextColor: fields.brandTextColor,
    emailSubject: fields.emailSubject || null,
    emailPreheader: fields.emailPreheader || null,
    emailHeading: fields.emailHeading || null,
    emailIntroduction: fields.emailIntroduction || null,
    ctaText: fields.ctaText,
    storefrontDomain: fields.storefrontDomain || null,
    contactEmail: fields.contactEmail || null,
    privacyPolicyUrl: fields.privacyPolicyUrl || null,
    unsubscribeUrl: fields.unsubscribeUrl || null,
    fromName: fields.fromName || null,
    replyTo: fields.contactEmail || null,
  };

  return prisma.automationSettings.update({
    where: { shopId: shop.id },
    data,
  });
}

export { readForm as readBrandingForm };
