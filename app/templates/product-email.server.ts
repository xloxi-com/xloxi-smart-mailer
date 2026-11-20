/**
 * SEDUCTIV product marketing email renderer.
 * Table-based HTML + inline CSS for Gmail / Outlook / Apple Mail.
 * Never sends mail — render only.
 */
import { sanitizeHttpUrl } from "../lib/safe-url.server";
import { escapeAttr, escapeHtml, sanitizePlainText } from "./html-escape.server";

export const EMAIL_CONTENT_WIDTH = 600;
export const MAX_PRODUCTS_PER_EMAIL = 6;

export type EmailProduct = {
  id: string;
  title: string;
  handle?: string | null;
  imageUrl?: string | null;
  productUrl?: string | null;
  price?: string | number | null;
  compareAtPrice?: string | number | null;
  currencyCode?: string | null;
};

export type EmailBrandConfig = {
  brandName?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  mutedColor?: string | null;
  subject?: string | null;
  preheader?: string | null;
  heading?: string | null;
  introduction?: string | null;
  ctaText?: string | null;
  /** Public host without scheme, e.g. seductiv.net */
  storefrontDomain?: string | null;
  contactEmail?: string | null;
  contactLine?: string | null;
  privacyPolicyUrl?: string | null;
  unsubscribeUrl?: string | null;
  shopDomain?: string | null;
};

export type RenderProductEmailInput = {
  products: EmailProduct[];
  brand?: EmailBrandConfig | null;
};

export type RenderedProductEmail = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  productCount: number;
};

const DEFAULTS = {
  brandName: "SEDUCTIV",
  primaryColor: "#111111",
  accentColor: "#C4A484",
  backgroundColor: "#FFFFFF",
  textColor: "#222222",
  mutedColor: "#6B6B6B",
  subject: "A few pieces we think you'll love",
  preheader: "Fresh picks from SEDUCTIV — curated just for you.",
  heading: "Selected for you",
  introduction:
    "A quiet edit of pieces from SEDUCTIV. Explore what caught our eye this week.",
  ctaText: "SHOP NOW",
  storefrontDomain: "seductiv.net",
  privacyPolicyUrl: "https://seductiv.net/policies/privacy-policy",
  contactEmail: "hello@seductiv.net",
} as const;

/** Placeholder when a product has no image — neutral, non-explicit. */
export const MISSING_IMAGE_PLACEHOLDER =
  "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png";

function resolveBrand(brand?: EmailBrandConfig | null) {
  const b = brand ?? {};
  const storefrontDomain = normalizeHost(
    b.storefrontDomain || DEFAULTS.storefrontDomain,
  );
  const fallbackPrivacy = `https://${storefrontDomain}/policies/privacy-policy`;
  const fallbackUnsub =
    `https://${storefrontDomain}/account` +
    (b.shopDomain
      ? `?utm_source=xloxi&shop=${encodeURIComponent(b.shopDomain)}`
      : "");

  return {
    brandName: (b.brandName || DEFAULTS.brandName).trim() || DEFAULTS.brandName,
    logoUrl: sanitizeHttpUrl(b.logoUrl),
    primaryColor: sanitizeColor(b.primaryColor) || DEFAULTS.primaryColor,
    accentColor: sanitizeColor(b.accentColor) || DEFAULTS.accentColor,
    backgroundColor:
      sanitizeColor(b.backgroundColor) || DEFAULTS.backgroundColor,
    textColor: sanitizeColor(b.textColor) || DEFAULTS.textColor,
    mutedColor: sanitizeColor(b.mutedColor) || DEFAULTS.mutedColor,
    subject: (b.subject || DEFAULTS.subject).trim() || DEFAULTS.subject,
    preheader: (b.preheader || DEFAULTS.preheader).trim() || DEFAULTS.preheader,
    heading: (b.heading || DEFAULTS.heading).trim() || DEFAULTS.heading,
    introduction:
      (b.introduction || DEFAULTS.introduction).trim() || DEFAULTS.introduction,
    ctaText: (b.ctaText || DEFAULTS.ctaText).trim() || DEFAULTS.ctaText,
    storefrontDomain,
    contactEmail: (b.contactEmail || DEFAULTS.contactEmail).trim(),
    contactLine:
      b.contactLine?.trim() ||
      `${DEFAULTS.brandName} · ${b.contactEmail || DEFAULTS.contactEmail}`,
    privacyPolicyUrl:
      sanitizeHttpUrl(b.privacyPolicyUrl) || fallbackPrivacy,
    unsubscribeUrl: sanitizeHttpUrl(b.unsubscribeUrl) || fallbackUnsub,
  };
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Allow only simple hex colors for inline CSS safety. */
export function sanitizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return v;
  return null;
}

export function formatMoney(
  amount: string | number | null | undefined,
  currencyCode?: string | null,
): string {
  if (amount == null || amount === "") return "";
  const num =
    typeof amount === "number" ? amount : Number.parseFloat(String(amount));
  if (!Number.isFinite(num)) return escapeHtml(String(amount));

  const code = (currencyCode || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "symbol",
    }).format(num);
  } catch {
    return `${code} ${num.toFixed(2)}`;
  }
}

/**
 * Prefer official storefront domain + handle; fall back to product URL host rewrite.
 */
export function buildStorefrontProductUrl(
  product: EmailProduct,
  storefrontDomain: string,
): string {
  const host = normalizeHost(storefrontDomain || DEFAULTS.storefrontDomain);
  if (product.handle) {
    return `https://${host}/products/${encodeURIComponent(product.handle)}`;
  }
  const raw = product.productUrl?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      return `https://${host}${u.pathname}${u.search}`;
    } catch {
      /* ignore */
    }
  }
  return `https://${host}`;
}

function isValidCompareAt(
  price: string | number | null | undefined,
  compareAt: string | number | null | undefined,
): boolean {
  if (compareAt == null || compareAt === "") return false;
  const p =
    typeof price === "number" ? price : Number.parseFloat(String(price ?? ""));
  const c =
    typeof compareAt === "number"
      ? compareAt
      : Number.parseFloat(String(compareAt));
  if (!Number.isFinite(p) || !Number.isFinite(c)) return false;
  return c > p;
}

function truncateTitle(title: string, max = 80): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function productCellHtml(
  product: EmailProduct,
  brand: ReturnType<typeof resolveBrand>,
  widthPct: "50%" | "100%",
): string {
  const title = truncateTitle(product.title || "Product");
  const url = buildStorefrontProductUrl(product, brand.storefrontDomain);
  const imageSrc =
    sanitizeHttpUrl(product.imageUrl) || MISSING_IMAGE_PLACEHOLDER;
  const priceLabel = formatMoney(product.price, product.currencyCode);
  const showCompare = isValidCompareAt(product.price, product.compareAtPrice);
  const compareLabel = showCompare
    ? formatMoney(product.compareAtPrice, product.currencyCode)
    : "";

  return `
<td class="product-col" valign="top" width="${widthPct}" style="width:${widthPct};padding:12px;vertical-align:top;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:0 0 14px 0;">
        <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">
          <img src="${escapeAttr(imageSrc)}" alt="${escapeAttr(title)}" width="260" style="display:block;width:100%;max-width:260px;height:auto;border:0;outline:none;text-decoration:none;background-color:#f3f1ee;" />
        </a>
      </td>
    </tr>
    <tr>
      <td align="center" style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.4;color:${escapeAttr(brand.textColor)};padding:0 4px 6px 4px;">
        <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="color:${escapeAttr(brand.textColor)};text-decoration:none;">${escapeHtml(title)}</a>
      </td>
    </tr>
    <tr>
      <td align="center" style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.4;color:${escapeAttr(brand.textColor)};padding:0 4px 14px 4px;">
        ${
          showCompare
            ? `<span style="text-decoration:line-through;color:${escapeAttr(brand.mutedColor)};margin-right:8px;">${escapeHtml(compareLabel)}</span>`
            : ""
        }
        <span style="font-weight:600;">${escapeHtml(priceLabel)}</span>
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:0 0 8px 0;">
        <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background-color:${escapeAttr(brand.primaryColor)};color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.08em;text-decoration:none;padding:12px 22px;border-radius:2px;">
          ${escapeHtml(brand.ctaText)}
        </a>
      </td>
    </tr>
  </table>
</td>`.trim();
}

function productGridHtml(
  products: EmailProduct[],
  brand: ReturnType<typeof resolveBrand>,
): string {
  if (products.length === 0) {
    return `<tr><td align="center" style="padding:24px;font-family:Helvetica,Arial,sans-serif;color:${escapeAttr(brand.mutedColor)};font-size:14px;">No products in this email.</td></tr>`;
  }

  const rows: string[] = [];
  for (let i = 0; i < products.length; i += 2) {
    const left = products[i]!;
    const right = products[i + 1];
    if (right) {
      rows.push(`
<tr>
  ${productCellHtml(left, brand, "50%")}
  ${productCellHtml(right, brand, "50%")}
</tr>`);
    } else {
      rows.push(`
<tr>
  ${productCellHtml(left, brand, "100%")}
</tr>`);
    }
  }
  return rows.join("\n");
}

function renderHtml(
  products: EmailProduct[],
  brand: ReturnType<typeof resolveBrand>,
): string {
  const logoBlock = brand.logoUrl
    ? `<img src="${escapeAttr(brand.logoUrl)}" alt="${escapeAttr(brand.brandName)}" width="160" style="display:block;max-width:160px;height:auto;border:0;margin:0 auto;" />`
    : `<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:0.28em;color:${escapeAttr(brand.primaryColor)};">${escapeHtml(brand.brandName)}</div>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(brand.subject)}</title>
<!--[if mso]>
<style type="text/css">
  table, td { font-family: Arial, sans-serif !important; }
</style>
<![endif]-->
<style type="text/css">
  @media only screen and (max-width: 620px) {
    .email-shell { width: 100% !important; }
    .product-col {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
    }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f4f2ef;color:${escapeAttr(brand.textColor)};">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
    ${escapeHtml(brand.preheader)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:#f4f2ef;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" class="email-shell" width="${EMAIL_CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_CONTENT_WIDTH}px;border-collapse:collapse;background-color:${escapeAttr(brand.backgroundColor)};">
          <tr>
            <td align="center" style="padding:28px 24px 12px 24px;border-bottom:1px solid #ece8e2;">
              ${logoBlock}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 28px 8px 28px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;color:${escapeAttr(brand.primaryColor)};">
              ${escapeHtml(brand.heading)}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 36px 24px 36px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:${escapeAttr(brand.mutedColor)};">
              ${escapeHtml(brand.introduction)}
            </td>
          </tr>
          <tr>
            <td style="padding:0 12px 8px 12px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                ${productGridHtml(products, brand)}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 28px 12px 28px;border-top:1px solid #ece8e2;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${escapeAttr(brand.mutedColor)};">
              ${escapeHtml(brand.contactLine)}
              ${
                brand.contactEmail
                  ? `<br /><a href="mailto:${escapeAttr(brand.contactEmail)}" style="color:${escapeAttr(brand.mutedColor)};text-decoration:underline;">${escapeHtml(brand.contactEmail)}</a>`
                  : ""
              }
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 28px 28px 28px;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:${escapeAttr(brand.mutedColor)};">
              <a href="${escapeAttr(brand.privacyPolicyUrl)}" target="_blank" rel="noopener noreferrer" style="color:${escapeAttr(brand.mutedColor)};text-decoration:underline;">Privacy Policy</a>
              &nbsp;&nbsp;·&nbsp;&nbsp;
              <a href="${escapeAttr(brand.unsubscribeUrl)}" target="_blank" rel="noopener noreferrer" style="color:${escapeAttr(brand.mutedColor)};text-decoration:underline;">Unsubscribe</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderText(
  products: EmailProduct[],
  brand: ReturnType<typeof resolveBrand>,
): string {
  const lines: string[] = [
    sanitizePlainText(brand.brandName),
    "",
    sanitizePlainText(brand.heading),
    sanitizePlainText(brand.introduction),
    "",
  ];

  for (const product of products) {
    const title = truncateTitle(product.title || "Product");
    const url = buildStorefrontProductUrl(product, brand.storefrontDomain);
    const priceLabel = formatMoney(product.price, product.currencyCode);
    const showCompare = isValidCompareAt(product.price, product.compareAtPrice);
    const compareLabel = showCompare
      ? formatMoney(product.compareAtPrice, product.currencyCode)
      : "";
    lines.push(sanitizePlainText(title));
    lines.push(
      showCompare
        ? `Price: ${priceLabel} (was ${compareLabel})`
        : `Price: ${priceLabel}`,
    );
    lines.push(`${brand.ctaText}: ${url}`);
    lines.push("");
  }

  lines.push(sanitizePlainText(brand.contactLine));
  if (brand.contactEmail) lines.push(brand.contactEmail);
  lines.push(`Privacy Policy: ${brand.privacyPolicyUrl}`);
  lines.push(`Unsubscribe: ${brand.unsubscribeUrl}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Render HTML + plain-text marketing email for 1–6 products.
 */
export function renderProductEmail(
  input: RenderProductEmailInput,
): RenderedProductEmail {
  const brand = resolveBrand(input.brand);
  const products = (input.products ?? [])
    .slice(0, MAX_PRODUCTS_PER_EMAIL)
    .filter((p) => p && p.title);

  return {
    subject: brand.subject,
    preheader: brand.preheader,
    html: renderHtml(products, brand),
    text: renderText(products, brand),
    productCount: products.length,
  };
}

/** Safe sample products for Admin preview when catalog is empty. */
export function samplePreviewProducts(): EmailProduct[] {
  return [
    {
      id: "sample-1",
      title: "Soft Tailored Blouse",
      handle: "soft-tailored-blouse",
      imageUrl: null,
      price: "68.00",
      compareAtPrice: "88.00",
      currencyCode: "USD",
    },
    {
      id: "sample-2",
      title: "Everyday Knit Set",
      handle: "everyday-knit-set",
      imageUrl: null,
      price: "54.00",
      currencyCode: "USD",
    },
    {
      id: "sample-3",
      title: "Linen Wrap Skirt",
      handle: "linen-wrap-skirt",
      imageUrl: null,
      price: "72.00",
      compareAtPrice: "72.00",
      currencyCode: "USD",
    },
  ];
}

export function brandConfigFromSettings(settings: {
  brandLogoUrl?: string | null;
  brandPrimaryColor?: string | null;
  brandAccentColor?: string | null;
  brandBackgroundColor?: string | null;
  brandTextColor?: string | null;
  emailSubject?: string | null;
  emailPreheader?: string | null;
  emailHeading?: string | null;
  emailIntroduction?: string | null;
  ctaText?: string | null;
  storefrontDomain?: string | null;
  contactEmail?: string | null;
  privacyPolicyUrl?: string | null;
  unsubscribeUrl?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
} | null | undefined, shopDomain?: string): EmailBrandConfig {
  if (!settings) {
    return { shopDomain: shopDomain ?? null };
  }
  return {
    brandName: settings.fromName || DEFAULTS.brandName,
    logoUrl: settings.brandLogoUrl,
    primaryColor: settings.brandPrimaryColor,
    accentColor: settings.brandAccentColor,
    backgroundColor: settings.brandBackgroundColor,
    textColor: settings.brandTextColor,
    subject: settings.emailSubject,
    preheader: settings.emailPreheader,
    heading: settings.emailHeading,
    introduction: settings.emailIntroduction,
    ctaText: settings.ctaText,
    storefrontDomain: settings.storefrontDomain,
    contactEmail: settings.contactEmail || settings.replyTo,
    privacyPolicyUrl: settings.privacyPolicyUrl,
    unsubscribeUrl: settings.unsubscribeUrl,
    shopDomain: shopDomain ?? null,
  };
}
