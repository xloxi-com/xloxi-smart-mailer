# Shopify Messaging setup — XLOXI Smart Mailer

XLOXI does **not** invent or call a Shopify Messaging send API.  
Merchants design and send email **inside Shopify Messaging**. Flow Workflow B invokes Messaging.

## Custom Liquid

1. Open the app → **Shopify Messaging**.
2. Click **Copy Liquid Code**.
3. In Shopify Admin → Marketing / Messaging, edit the email template used by Flow.
4. Paste into a **Custom Liquid** (or HTML/Liquid) block.

### What the Liquid does

- Reads `customer.tags`
- Finds tags starting with `xloxi-pick:`
- Resolves each handle with `all_products[handle]`
- Renders up to 6 products (image, title, price, SHOP NOW link)
- Responsive 2-column layout
- Includes `unsubscribe_url` / `unsubscribe_link`
- Includes `{{ open_tracking }}` when enabled in the template generator

### Unsupported / plan notes

- Messaging Liquid capabilities can differ from Online Store theme Liquid.
- If `all_products` or `image_url` is unavailable in your Messaging editor, report that as a **blocker** — do not switch to an external ESP.
- Always use Shopify’s official unsubscribe variables required by Messaging compliance.

## Flow action

Use **Send marketing email** (Shopify Messaging) when `xloxi-ready` is added.  
Do not configure SMTP, Resend, SendGrid, or other providers in XLOXI.

## Verification

1. Prepare a test batch for one subscribed customer (Random Selection page).
2. Confirm pick tags appear on the customer.
3. Confirm `xloxi-ready` is present (then removed by Workflow B).
4. Confirm the received Messaging email renders the two (or up to six) products.
5. Confirm `processed_batch_id` acknowledgement updates in the app (not delivery proof).
