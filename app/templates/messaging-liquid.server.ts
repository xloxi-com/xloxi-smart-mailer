/**
 * Custom Liquid for Shopify Messaging email editor.
 * Merchants copy this into Messaging — the app does not send email.
 */
export function buildMessagingLiquidTemplate(options?: {
  includeOpenTracking?: boolean;
}): string {
  const openTracking = options?.includeOpenTracking !== false;

  return `{% comment %}
  XLOXI Smart Mailer — Shopify Messaging product block
  Paste into the Shopify Messaging email editor (Custom Liquid).
  Products are selected via customer tags: xloxi-pick:PRODUCT_HANDLE
{% endcomment %}
${openTracking ? `{{ open_tracking }}
` : ""}{% assign xloxi_handles = "" %}
{% for tag in customer.tags %}
  {% assign tag_down = tag | downcase | strip %}
  {% if tag_down contains "xloxi-pick:" %}
    {% assign handle = tag_down | remove: "xloxi-pick:" | strip %}
    {% if handle != blank %}
      {% if xloxi_handles == "" %}
        {% assign xloxi_handles = handle %}
      {% else %}
        {% assign xloxi_handles = xloxi_handles | append: "," | append: handle %}
      {% endif %}
    {% endif %}
  {% endif %}
{% endfor %}

{% assign handle_list = xloxi_handles | split: "," %}

<style>
  .xloxi-wrap { width:100%; max-width:600px; margin:0 auto; font-family:Arial,Helvetica,sans-serif; color:#222; }
  .xloxi-grid { width:100%; border-collapse:collapse; }
  .xloxi-cell { width:50%; vertical-align:top; padding:12px; box-sizing:border-box; }
  .xloxi-card { border:1px solid #eee; padding:12px; text-align:center; }
  .xloxi-img { width:100%; max-width:240px; height:auto; display:block; margin:0 auto 10px; }
  .xloxi-title { font-size:16px; font-weight:bold; margin:0 0 6px; line-height:1.3; }
  .xloxi-price { font-size:14px; margin:0 0 12px; }
  .xloxi-btn {
    display:inline-block; background:#111; color:#fff !important; text-decoration:none;
    padding:10px 16px; font-size:13px; font-weight:bold; border-radius:4px;
  }
  .xloxi-footer { font-size:12px; color:#666; text-align:center; padding:24px 12px; }
  @media only screen and (max-width:480px) {
    .xloxi-cell { display:block !important; width:100% !important; }
  }
</style>

<div class="xloxi-wrap">
  <table class="xloxi-grid" role="presentation" cellpadding="0" cellspacing="0">
    <tr>
    {% assign shown = 0 %}
    {% for handle in handle_list %}
      {% if shown >= 6 %}{% break %}{% endif %}
      {% assign handle = handle | strip %}
      {% if handle == blank %}{% continue %}{% endif %}
      {% assign product = all_products[handle] %}
      {% if product == blank %}{% continue %}{% endif %}

      {% if shown == 2 or shown == 4 %}
        </tr><tr>
      {% endif %}

      <td class="xloxi-cell">
        <div class="xloxi-card">
          {% if product.featured_image %}
            <a href="{{ product.url }}">
              <img class="xloxi-img" src="{{ product.featured_image | image_url: width: 480 }}" alt="{{ product.title | escape }}" />
            </a>
          {% endif %}
          <p class="xloxi-title">{{ product.title }}</p>
          <p class="xloxi-price">{{ product.price | money }}</p>
          <a class="xloxi-btn" href="{{ product.url }}">SHOP NOW</a>
        </div>
      </td>

      {% assign shown = shown | plus: 1 %}
    {% endfor %}
    </tr>
  </table>

  {% if shown == 0 %}
    <p style="text-align:center;padding:24px;">No products selected for this email.</p>
  {% endif %}

  <div class="xloxi-footer">
    <p>
      <a href="{% if unsubscribe_url %}{{ unsubscribe_url }}{% else %}{{ unsubscribe_link }}{% endif %}">
        Unsubscribe
      </a>
    </p>
  </div>
</div>
`;
}

export function buildMessagingSetupGuide(): string {
  return [
    "1. Open Shopify Admin → Marketing → Shopify Messaging (or Email campaigns).",
    "2. Create or edit a marketing email template used by your Flow action.",
    "3. Add a Custom Liquid / HTML block and paste the XLOXI Liquid code.",
    "4. Ensure the template can read customer.tags and all_products[handle].",
    "5. Include Shopify unsubscribe and open tracking as required by Messaging.",
    "6. In Flow Workflow B, use “Send marketing email” with this template when xloxi-ready is added.",
    "7. Do not configure an external ESP in XLOXI — this app only selects products.",
  ].join("\n");
}
