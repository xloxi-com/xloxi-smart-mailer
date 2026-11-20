import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EmailEventType,
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
  SuppressionReason,
} from "@prisma/client";
import {
  createMockEmailProvider,
  getMockEmailProviderStore,
  resetMockEmailProviderStore,
  setMockNextSendResult,
} from "../providers/mock.server";
import {
  applyProviderDeliveryEvents,
  deliverMarketingEmail,
  reconcileUnknownEmailJob,
} from "./email-delivery.server";
import {
  buildSignedUnsubscribeUrl,
  processUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe.server";
import { hasActiveSuppression } from "./consent.server";

const prisma = new PrismaClient();
const SHOP = `email-delivery-${process.pid}.myshopify.com`;

describe("email delivery integration (mock provider)", () => {
  let shopId: string;
  let subscriberId: string;

  beforeAll(async () => {
    process.env.EMAIL_SENDING_ENABLED = "false";
    process.env.EMAIL_PROVIDER = "mock";
    process.env.UNSUBSCRIBE_SIGNING_SECRET = "test-unsub-secret";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";

    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        automationSettings: { create: { dryRun: true } },
      },
    });
    shopId = shop.id;

    const sub = await prisma.subscriber.create({
      data: {
        shopId,
        shopifyCustomerGid: "gid://shopify/Customer/email-del-1",
        email: "subscriber@example.com",
        emailNormalized: "subscriber@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
        isSuppressed: false,
      },
    });
    subscriberId = sub.id;
  });

  beforeEach(() => {
    resetMockEmailProviderStore();
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.$disconnect();
  });

  async function createPendingJob(suffix: string) {
    // Partial unique index: only one active job per subscriber.
    await prisma.emailJob.updateMany({
      where: {
        shopId,
        subscriberId,
        status: {
          in: [
            EmailJobStatus.PENDING,
            EmailJobStatus.PROCESSING,
            EmailJobStatus.RETRY_SCHEDULED,
            EmailJobStatus.UNKNOWN,
          ],
        },
      },
      data: {
        status: EmailJobStatus.CANCELLED,
        completedAt: new Date(),
      },
    });

    return prisma.emailJob.create({
      data: {
        shopId,
        subscriberId,
        idempotencyKey: `email-del-${suffix}-${Date.now()}`,
        status: EmailJobStatus.PENDING,
        cycleNumber: 1,
        dryRun: true,
        productSnapshot: { products: [] },
      },
    });
  }

  it("accepts a mock send, records message id and SENT event", async () => {
    const job = await createPendingJob("ok");
    const provider = createMockEmailProvider();

    const result = await deliverMarketingEmail({
      emailJobId: job.id,
      to: "subscriber@example.com",
      subject: "SEDUCTIV picks",
      html: "<p>Hello</p>",
      text: "Hello",
      shopDomain: SHOP,
      provider,
    });

    expect(result.status).toMatch(/accepted|dry_run/);
    expect(result.providerMessageId).toBeTruthy();

    const updated = await prisma.emailJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(updated.status).toBe(EmailJobStatus.ACCEPTED);
    expect(updated.providerMessageId).toBe(result.providerMessageId);
    expect(updated.providerName).toBe("mock");

    const events = await prisma.emailEvent.findMany({
      where: { emailJobId: job.id, type: EmailEventType.SENT },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Idempotent provider replay
    const again = await provider.sendMarketingEmail({
      to: "subscriber@example.com",
      subject: "SEDUCTIV picks",
      html: "<p>Hello</p>",
      text: "Hello",
      idempotencyKey: job.idempotencyKey,
      unsubscribeUrl: "https://app.example.com/api/unsubscribe?token=x",
      shopDomain: SHOP,
      emailJobId: job.id,
    });
    expect(again.providerMessageId).toBe(result.providerMessageId);
  });

  it("never sends to suppressed recipients", async () => {
    await prisma.suppression.create({
      data: {
        shopId,
        subscriberId,
        emailNormalized: "subscriber@example.com",
        reason: SuppressionReason.UNSUBSCRIBED,
        active: true,
        source: "test",
      },
    });
    await prisma.subscriber.update({
      where: { id: subscriberId },
      data: { isSuppressed: true, eligible: false },
    });

    const job = await createPendingJob("suppressed");
    const result = await deliverMarketingEmail({
      emailJobId: job.id,
      to: "subscriber@example.com",
      subject: "Should not send",
      html: "<p>x</p>",
      text: "x",
      shopDomain: SHOP,
      provider: createMockEmailProvider(),
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("suppressed");
    expect(getMockEmailProviderStore().byIdempotency.size).toBe(0);

    const updated = await prisma.emailJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(updated.status).toBe(EmailJobStatus.CANCELLED);

    // cleanup suppression for later tests
    await prisma.suppression.deleteMany({ where: { shopId } });
    await prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        isSuppressed: false,
        eligible: true,
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
      },
    });
  });

  it("schedules retry for retryable errors and does not blind-retry ambiguous", async () => {
    const retryJob = await createPendingJob("retry");
    setMockNextSendResult({
      status: "rate_limited",
      retryable: true,
      errorCode: "rate_limited",
      retryAfterMs: 1000,
    });
    const retryResult = await deliverMarketingEmail({
      emailJobId: retryJob.id,
      to: "subscriber@example.com",
      subject: "Retry me",
      html: "<p>r</p>",
      text: "r",
      shopDomain: SHOP,
      provider: createMockEmailProvider(),
    });
    expect(retryResult.status).toBe("retry_scheduled");
    const retried = await prisma.emailJob.findUniqueOrThrow({
      where: { id: retryJob.id },
    });
    expect(retried.status).toBe(EmailJobStatus.RETRY_SCHEDULED);

    const ambigJob = await createPendingJob("ambig");
    setMockNextSendResult({
      status: "ambiguous",
      retryable: true,
      errorCode: "timeout",
      errorMessage: "provider timeout",
    });
    const ambig = await deliverMarketingEmail({
      emailJobId: ambigJob.id,
      to: "subscriber@example.com",
      subject: "Ambig",
      html: "<p>a</p>",
      text: "a",
      shopDomain: SHOP,
      provider: createMockEmailProvider(),
    });
    expect(ambig.status).toBe("unknown");
    const unknown = await prisma.emailJob.findUniqueOrThrow({
      where: { id: ambigJob.id },
    });
    expect(unknown.status).toBe(EmailJobStatus.UNKNOWN);
  });

  it("reconciles unknown jobs via getMessageStatus before accepting", async () => {
    const provider = createMockEmailProvider();
    const send = await provider.sendMarketingEmail({
      to: "subscriber@example.com",
      subject: "Reconcile",
      html: "<p>r</p>",
      text: "r",
      idempotencyKey: `reconcile-${Date.now()}`,
      unsubscribeUrl: "https://app.example.com/u",
      shopDomain: SHOP,
      emailJobId: "pending-reconcile",
    });

    await prisma.emailJob.updateMany({
      where: {
        shopId,
        subscriberId,
        status: {
          in: [
            EmailJobStatus.PENDING,
            EmailJobStatus.PROCESSING,
            EmailJobStatus.RETRY_SCHEDULED,
            EmailJobStatus.UNKNOWN,
          ],
        },
      },
      data: { status: EmailJobStatus.CANCELLED, completedAt: new Date() },
    });

    const job = await prisma.emailJob.create({
      data: {
        shopId,
        subscriberId,
        idempotencyKey: `unknown-${Date.now()}`,
        status: EmailJobStatus.UNKNOWN,
        cycleNumber: 1,
        dryRun: true,
        productSnapshot: {},
        providerMessageId: send.providerMessageId,
        providerName: "mock",
        attemptCount: 1,
      },
    });

    const result = await reconcileUnknownEmailJob(job.id, provider);
    expect(result.status).toBe("accepted");
    const updated = await prisma.emailJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(updated.status).toBe(EmailJobStatus.ACCEPTED);
  });

  it("processes provider delivery events idempotently and suppresses bounces", async () => {
    const job = await createPendingJob("bounce-evt");
    const provider = createMockEmailProvider();
    const delivered = await deliverMarketingEmail({
      emailJobId: job.id,
      to: "subscriber@example.com",
      subject: "Evt",
      html: "<p>e</p>",
      text: "e",
      shopDomain: SHOP,
      provider,
    });

    const eventId = `evt-bounce-${Date.now()}`;
    const first = await applyProviderDeliveryEvents(shopId, [
      {
        providerEventId: eventId,
        providerMessageId: delivered.providerMessageId,
        type: "bounced",
        occurredAt: new Date(),
        emailNormalizedHint: "subscriber@example.com",
      },
    ]);
    expect(first.applied).toBe(1);

    const second = await applyProviderDeliveryEvents(shopId, [
      {
        providerEventId: eventId,
        providerMessageId: delivered.providerMessageId,
        type: "bounced",
        occurredAt: new Date(),
        emailNormalizedHint: "subscriber@example.com",
      },
    ]);
    expect(second.duplicates).toBe(1);

    expect(
      await hasActiveSuppression(shopId, "subscriber@example.com"),
    ).toBe(true);

    await prisma.suppression.deleteMany({ where: { shopId } });
    await prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        isSuppressed: false,
        eligible: true,
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
      },
    });
  });

  it("builds and verifies signed unsubscribe tokens", async () => {
    const url = buildSignedUnsubscribeUrl({
      appUrl: "https://app.example.com",
      shopId,
      subscriberId,
      emailNormalized: "subscriber@example.com",
    });
    expect(url).toContain("/api/unsubscribe?token=");
    const token = new URL(url).searchParams.get("token")!;
    const payload = verifyUnsubscribeToken(token);
    expect(payload?.subscriberId).toBe(subscriberId);

    const result = await processUnsubscribeToken({
      token,
      source: "test",
    });
    expect(result.ok).toBe(true);
    expect(await hasActiveSuppression(shopId, "subscriber@example.com")).toBe(
      true,
    );

    const sub = await prisma.subscriber.findUniqueOrThrow({
      where: { id: subscriberId },
    });
    expect(sub.marketingConsentState).toBe(MarketingConsentState.UNSUBSCRIBED);
  });
});
