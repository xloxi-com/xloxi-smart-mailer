import { describe, expect, it } from "vitest";
import {
  buildStorefrontProductUrl,
  EMAIL_CONTENT_WIDTH,
  formatMoney,
  MISSING_IMAGE_PLACEHOLDER,
  renderProductEmail,
  sanitizeColor,
  type EmailProduct,
} from "./product-email.server";
import { escapeHtml } from "./html-escape.server";

function product(overrides: Partial<EmailProduct> = {}): EmailProduct {
  return {
    id: "p1",
    title: "Classic Tee",
    handle: "classic-tee",
    imageUrl: "https://cdn.example/img.jpg",
    price: "42.00",
    currencyCode: "USD",
    ...overrides,
  };
}

describe("product email template", () => {
  it("strips javascript: URLs from logo and images", () => {
    const rendered = renderProductEmail({
      products: [
        product({
          imageUrl: "javascript:alert(1)",
          productUrl: "javascript:alert(2)",
        }),
      ],
      brand: {
        logoUrl: "javascript:alert(3)",
        unsubscribeUrl: "javascript:alert(4)",
        privacyPolicyUrl: "javascript:alert(5)",
      },
    });
    expect(rendered.html).not.toMatch(/javascript:/i);
    expect(rendered.html).toContain(MISSING_IMAGE_PLACEHOLDER);
    expect(rendered.html).toContain("https://seductiv.net/policies/privacy-policy");
  });

  it("escapes untrusted HTML in titles and copy", () => {
    const rendered = renderProductEmail({
      products: [
        product({
          title: `<img src=x onerror=alert(1)> "Sale" & more`,
        }),
      ],
      brand: {
        heading: `<script>alert('x')</script>`,
        introduction: `Hello <b>there</b> & welcome`,
        subject: `Subject <evil>`,
      },
    });

    expect(rendered.html).not.toMatch(/<script[\s>]/i);
    expect(rendered.html).not.toContain("<img src=x onerror=");
    expect(rendered.html).toContain(
      escapeHtml(`<img src=x onerror=alert(1)> "Sale" & more`),
    );
    expect(rendered.html).toContain(escapeHtml(`<script>alert('x')</script>`));
    expect(rendered.html).toContain("Hello &lt;b&gt;there&lt;/b&gt; &amp; welcome");
    expect(rendered.html).toContain("Subject &lt;evil&gt;");
    expect(rendered.subject).toBe("Subject <evil>");
  });

  it("uses placeholder when product image is missing", () => {
    const rendered = renderProductEmail({
      products: [product({ imageUrl: null }), product({ imageUrl: "  " })],
    });
    expect(rendered.html).toContain(MISSING_IMAGE_PLACEHOLDER);
    expect(rendered.productCount).toBe(2);
  });

  it("truncates long titles without breaking the layout markup", () => {
    const long =
      "An Extremely Long Product Title That Goes On And On About Fabric Softness Texture And Seasonal Details Beyond Eighty Characters";
    const rendered = renderProductEmail({
      products: [product({ title: long })],
    });
    expect(rendered.html).toContain("…");
    expect(rendered.html).not.toContain(long);
    expect(rendered.text).toContain("…");
  });

  it("formats different currencies", () => {
    expect(formatMoney("19.99", "USD")).toMatch(/\$19\.99/);
    expect(formatMoney("25.50", "EUR")).toMatch(/25/);
    expect(formatMoney(1000, "JPY")).toBeTruthy();
    expect(formatMoney("12.00", "GBP")).toMatch(/12/);

    const rendered = renderProductEmail({
      products: [
        product({ price: "19.99", currencyCode: "USD" }),
        product({
          id: "p2",
          title: "Euro Piece",
          handle: "euro-piece",
          price: "25.50",
          currencyCode: "EUR",
        }),
        product({
          id: "p3",
          title: "Yen Piece",
          handle: "yen-piece",
          price: 1200,
          currencyCode: "JPY",
        }),
      ],
    });
    expect(rendered.html).toContain("19.99");
    expect(rendered.html).toContain("25");
  });

  it("renders fewer than 6 products and caps at 6", () => {
    const one = renderProductEmail({ products: [product()] });
    expect(one.productCount).toBe(1);
    expect(one.html).toContain("SHOP NOW");
    expect(one.html).toContain(`max-width:${EMAIL_CONTENT_WIDTH}px`);

    const three = renderProductEmail({
      products: [
        product({ id: "1", handle: "a" }),
        product({ id: "2", handle: "b", title: "B" }),
        product({ id: "3", handle: "c", title: "C" }),
      ],
    });
    expect(three.productCount).toBe(3);
    // Last odd product uses full-width cell.
    expect(three.html).toContain('width="100%"');

    const many = renderProductEmail({
      products: Array.from({ length: 10 }, (_, i) =>
        product({
          id: `p${i}`,
          handle: `h-${i}`,
          title: `Item ${i}`,
        }),
      ),
    });
    expect(many.productCount).toBe(6);
  });

  it("builds product links on the official storefront domain", () => {
    expect(
      buildStorefrontProductUrl(
        product({ handle: "soft-blouse" }),
        "seductiv.net",
      ),
    ).toBe("https://seductiv.net/products/soft-blouse");

    expect(
      buildStorefrontProductUrl(
        product({
          handle: null,
          productUrl: "https://other.myshopify.com/products/x?variant=1",
        }),
        "seductiv.net",
      ),
    ).toBe("https://seductiv.net/products/x?variant=1");

    const rendered = renderProductEmail({
      products: [product({ handle: "linen-wrap" })],
      brand: { storefrontDomain: "seductiv.net" },
    });
    expect(rendered.html).toContain("https://seductiv.net/products/linen-wrap");
    expect(rendered.text).toContain("https://seductiv.net/products/linen-wrap");
  });

  it("shows compare-at only when higher than price", () => {
    const withCompare = renderProductEmail({
      products: [
        product({ price: "40", compareAtPrice: "55", currencyCode: "USD" }),
      ],
    });
    expect(withCompare.html).toContain("line-through");

    const equal = renderProductEmail({
      products: [
        product({ price: "40", compareAtPrice: "40", currencyCode: "USD" }),
      ],
    });
    expect(equal.html).not.toContain("line-through");

    const lower = renderProductEmail({
      products: [
        product({ price: "40", compareAtPrice: "30", currencyCode: "USD" }),
      ],
    });
    expect(lower.html).not.toContain("line-through");
  });

  it("includes subject, preheader, unsubscribe and privacy links", () => {
    const rendered = renderProductEmail({
      products: [product()],
      brand: {
        subject: "This week at SEDUCTIV",
        preheader: "Quiet new arrivals",
        privacyPolicyUrl: "https://seductiv.net/policies/privacy-policy",
        unsubscribeUrl: "https://seductiv.net/account",
        contactEmail: "hello@seductiv.net",
      },
    });
    expect(rendered.subject).toBe("This week at SEDUCTIV");
    expect(rendered.preheader).toBe("Quiet new arrivals");
    expect(rendered.html).toContain("Quiet new arrivals");
    expect(rendered.html).toContain("Unsubscribe");
    expect(rendered.html).toContain("Privacy Policy");
    expect(rendered.html).toContain("https://seductiv.net/account");
    expect(rendered.text).toContain("Unsubscribe:");
    expect(rendered.text).toContain("Privacy Policy:");
  });

  it("includes a plain-text alternative and no scripts", () => {
    const rendered = renderProductEmail({
      products: [product({ title: "Knit Set" })],
    });
    expect(rendered.text).toContain("SEDUCTIV");
    expect(rendered.text).toContain("Knit Set");
    expect(rendered.text).toContain("SHOP NOW:");
    expect(rendered.html).not.toMatch(/<script[\s>]/i);
    expect(rendered.html).not.toMatch(/stylesheet/i);
  });

  it("sanitizes brand colors", () => {
    expect(sanitizeColor("#abc")).toBe("#abc");
    expect(sanitizeColor("#112233")).toBe("#112233");
    expect(sanitizeColor("red")).toBeNull();
    expect(sanitizeColor("url(evil)")).toBeNull();
  });

  it("uses a 2-column row for pairs on desktop markup", () => {
    const rendered = renderProductEmail({
      products: [
        product({ id: "1", handle: "a", title: "A" }),
        product({ id: "2", handle: "b", title: "B" }),
      ],
    });
    expect(rendered.html).toContain('width="50%"');
    expect(rendered.html).toContain("product-col");
    expect(rendered.html).toContain("@media only screen and (max-width: 620px)");
  });
});
