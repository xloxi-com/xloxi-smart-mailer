import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EmailJobStatus,
  MarketingConsentState,
  PrismaClient,
} from "@prisma/client";
import {
  markEmailJobAccepted,
  reserveEmailBatch,
} from "./email-reservation.server";
import { countEligibleUnsent } from "./random-engine.server";
import { countHistoryInCycle } from "./product-history.server";
import { runEmailScheduler } from "./scheduler.server";
import {
  claimEmailJobs,
  DURABLE_LOCKS,
  recoverStaleEmailJobLeases,
  releaseDurableLock,
  tryDurableLock,
} from "./job-queue.server";
import {
  createMockEmailProvider,
  resetMockEmailProviderStore,
  setMockNextSendResult,
} from "../providers/mock.server";
import { deliverMarketingEmail } from "./email-delivery.server";
import {
  saveAutomationSettings,
  settingsToAutomationForm,
} from "./admin-automation.server";
import {
  saveAdminSettings,
  settingsToSettingsForm,
} from "./admin-settings.server";
import { saveEmailBranding, settingsToForm } from "./email-branding.server";
import { setProductsExcluded } from "./admin-products.server";
import { setSubscriberPaused } from "./admin-subscribers.server";
import { handleAppUninstalled } from "./webhook-uninstall.server";
import { renderProductEmail } from "../templates/product-email.server";
import { getDashboardStats } from "./admin-dashboard.server";

const prisma = new PrismaClient();
const SHOP = `prod-audit-${process.pid}.myshopify.com`;

describe("production readiness audit workflows", () => {
  let shopId = "";
  let subscriberId = "";
  const productIds: string[] = [];

  beforeAll(async () => {
    process.env.EMAIL_SENDING_ENABLED = "false";
    process.env.EMAIL_PROVIDER = "mock";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    process.env.UNSUBSCRIBE_SIGNING_SECRET = "prod-audit-secret";

    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    const shop = await prisma.shop.create({
      data: {
        shopDomain: SHOP,
        timezone: "UTC",
        automationSettings: {
          create: {
            automationEnabled: true,
            dryRun: true,
            intervalDays: 3,
            productsPerEmail: 2,
            maxEmailsPerRun: 20,
            maxEmailsPerHour: 100,
            maxEmailsPerDay: 500,
            inStockOnly: true,
            preventDuplicates: true,
            autoResetCycle: true,
            randomSelection: true,
          },
        },
      },
    });
    shopId = shop.id;

    for (let i = 0; i < 4; i += 1) {
      const p = await prisma.product.create({
        data: {
          shopId,
          shopifyProductGid: `gid://shopify/Product/prod-audit-${i}`,
          title: `Audit Product ${i}`,
          handle: `audit-product-${i}`,
          status: "ACTIVE",
          publishedToOnlineStore: true,
          inStock: true,
          eligible: true,
          excludedFromAutomation: false,
          priceMin: 10 + i,
          currencyCode: "USD",
        },
      });
      productIds.push(p.id);
    }

    const sub = await prisma.subscriber.create({
      data: {
        shopId,
        shopifyCustomerGid: "gid://shopify/Customer/prod-audit-1",
        email: "audit@example.com",
        emailNormalized: "audit@example.com",
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        eligible: true,
        isSuppressed: false,
        paused: false,
        currentCycleNumber: 1,
        nextEmailAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    subscriberId = sub.id;
  });

  beforeEach(async () => {
    resetMockEmailProviderStore();
    await prisma.emailEvent.deleteMany({ where: { shopId } });
    await prisma.productHistory.deleteMany({ where: { shopId } });
    await prisma.emailJobProduct.deleteMany({ where: { shopId } });
    await prisma.emailJob.deleteMany({ where: { shopId } });
    await prisma.product.updateMany({
      where: { shopId },
      data: {
        eligible: true,
        inStock: true,
        excludedFromAutomation: false,
        deletedAt: null,
        status: "ACTIVE",
        publishedToOnlineStore: true,
      },
    });
    await prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        eligible: true,
        isSuppressed: false,
        paused: false,
        marketingConsentState: MarketingConsentState.SUBSCRIBED,
        currentCycleNumber: 1,
        nextEmailAt: new Date("2020-01-01T00:00:00.000Z"),
        lastSuccessfulEmailAt: null,
      },
    });
    await prisma.automationSettings.update({
      where: { shopId },
      data: {
        automationEnabled: true,
        dryRun: true,
        intervalDays: 3,
        productsPerEmail: 2,
        autoResetCycle: true,
        preventDuplicates: true,
      },
    });
    await releaseDurableLock({
      lockId: DURABLE_LOCKS.scheduler,
      owner: "any",
    }).catch(() => undefined);
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.$disconnect();
  });

  it("persists automation, branding, and settings from dashboard forms", async () => {
    const automationFd = new FormData();
    automationFd.set("automationEnabled", "true");
    automationFd.set("intervalDays", "3");
    automationFd.set("productsPerEmail", "4");
    automationFd.set("randomSelection", "true");
    automationFd.set("inStockOnly", "true");
    automationFd.set("preventDuplicates", "true");
    automationFd.set("autoResetCycle", "true");
    automationFd.set("dryRun", "true");
    automationFd.set("maxEmailsPerDay", "250");
    automationFd.set("maxEmailsPerHour", "80");
    automationFd.set("maxEmailsPerRun", "25");
    const automation = await saveAutomationSettings(SHOP, automationFd);
    expect(settingsToAutomationForm(automation).productsPerEmail).toBe(4);
    expect(settingsToAutomationForm(automation).maxEmailsPerDay).toBe(250);

    const brandFd = new FormData();
    brandFd.set("fromName", "SEDUCTIV");
    brandFd.set("brandLogoUrl", "https://seductiv.net/logo.png");
    brandFd.set("brandPrimaryColor", "#111111");
    brandFd.set("brandAccentColor", "#C4A484");
    brandFd.set("brandBackgroundColor", "#FFFFFF");
    brandFd.set("brandTextColor", "#222222");
    brandFd.set("emailSubject", "Audit subject");
    brandFd.set("emailHeading", "Audit heading");
    brandFd.set("emailIntroduction", "Audit intro");
    brandFd.set("ctaText", "SHOP NOW");
    brandFd.set("storefrontDomain", "seductiv.net");
    brandFd.set("contactEmail", "hello@seductiv.net");
    const branding = await saveEmailBranding(SHOP, brandFd);
    expect(settingsToForm(branding).emailSubject).toBe("Audit subject");

    const settingsFd = new FormData();
    settingsFd.set("sendingEmailAddress", "hello@seductiv.net");
    settingsFd.set("fromName", "SEDUCTIV");
    settingsFd.set("replyTo", "hello@seductiv.net");
    settingsFd.set("timezone", "Asia/Kolkata");
    settingsFd.set("syncIntervalMinutes", "180");
    settingsFd.set("dataRetentionDays", "180");
    settingsFd.set("emailProviderLabel", "mock");
    const saved = await saveAdminSettings(SHOP, settingsFd);
    const form = settingsToSettingsForm(saved.shop, saved.settings);
    expect(form.timezone).toBe("Asia/Kolkata");
    expect(form.dataRetentionDays).toBe(180);
    // App is Messaging-only — provider label is forced regardless of form input.
    expect(form.emailProviderLabel).toBe("shopify_messaging");
  });

  it("selects random non-repeating products and advances after acceptance", async () => {
    const first = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-batch-1",
      batchSize: 2,
    });
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") return;
    expect(first.job.products).toHaveLength(2);

    await markEmailJobAccepted(first.job.id, {
      providerMessageId: "audit-msg-1",
      providerName: "mock",
      intervalDays: 3,
    });

    const history = await countHistoryInCycle(prisma, {
      shopId,
      subscriberId,
      cycleNumber: 1,
    });
    expect(history).toBe(2);

    const remaining = await countEligibleUnsent(prisma, {
      shopId,
      subscriberId,
      cycleNumber: 1,
      inStockOnly: true,
    });
    expect(remaining).toBe(2);

    const sub = await prisma.subscriber.findUniqueOrThrow({
      where: { id: subscriberId },
    });
    expect(sub.nextEmailAt?.getTime()).toBeGreaterThan(Date.now());
    const deltaDays =
      ((sub.nextEmailAt?.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThan(2.5);
    expect(deltaDays).toBeLessThan(3.5);
  });

  it("restarts the cycle when the product pool is exhausted", async () => {
    await prisma.automationSettings.update({
      where: { shopId },
      data: { productsPerEmail: 2, autoResetCycle: true },
    });

    for (let i = 0; i < 2; i += 1) {
      const reserved = await reserveEmailBatch({
        shopId,
        subscriberId,
        idempotencyKey: `audit-cycle-${i}`,
        batchSize: 2,
      });
      expect(reserved.status).toBe("reserved");
      if (reserved.status !== "reserved") return;
      await markEmailJobAccepted(reserved.job.id, {
        providerMessageId: `audit-cycle-msg-${i}`,
        providerName: "mock",
        intervalDays: 3,
      });
      await prisma.emailJob.update({
        where: { id: reserved.job.id },
        data: { status: EmailJobStatus.ACCEPTED },
      });
      // Clear active-job uniqueness by completing; already ACCEPTED.
      await prisma.subscriber.update({
        where: { id: subscriberId },
        data: { nextEmailAt: new Date("2020-01-01T00:00:00.000Z") },
      });
    }

    const before = await prisma.subscriber.findUniqueOrThrow({
      where: { id: subscriberId },
    });
    expect(before.currentCycleNumber).toBeGreaterThanOrEqual(1);

    const restart = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-cycle-restart",
      batchSize: 2,
    });
    expect(restart.status).toBe("reserved");
    if (restart.status !== "reserved") return;
    expect(restart.job.cycleNumber).toBeGreaterThan(1);
  });

  it("excludes unavailable/deleted/excluded products and paused subscribers", async () => {
    await setProductsExcluded(shopId, [productIds[0]!], true);
    await prisma.product.update({
      where: { id: productIds[1]! },
      data: { deletedAt: new Date(), eligible: false },
    });
    await prisma.product.update({
      where: { id: productIds[2]! },
      data: { inStock: false, eligible: false },
    });

    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-exclude",
      batchSize: 2,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    const ids = reserved.job.products.map((p) => p.productId);
    expect(ids).not.toContain(productIds[0]);
    expect(ids).not.toContain(productIds[1]);
    expect(ids).not.toContain(productIds[2]);
    expect(ids).toContain(productIds[3]);

    await prisma.emailJob.deleteMany({ where: { shopId } });
    await setSubscriberPaused(shopId, subscriberId, true);
    const sched = await runEmailScheduler({ workerId: "audit-paused" });
    expect(sched.shops.reduce((n, s) => n + s.reserved, 0)).toBe(0);
  });

  it("delivers via mock provider and schedules retries for retryable failures", async () => {
    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-mock-send",
      batchSize: 2,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;

    const claimed = await claimEmailJobs({
      leaseOwner: "audit-worker",
      limit: 1,
      shopId,
    });
    expect(claimed).toHaveLength(1);

    const provider = createMockEmailProvider();
    const result = await deliverMarketingEmail({
      emailJobId: claimed[0]!.id,
      to: "audit@example.com",
      subject: "Audit",
      html: "<p>hi</p>",
      text: "hi",
      shopDomain: SHOP,
      provider,
      alreadyClaimedJob: claimed[0]!,
      intervalDays: 3,
    });
    expect(["accepted", "dry_run"]).toContain(result.status);

    await prisma.emailJob.deleteMany({ where: { shopId } });
    await prisma.productHistory.deleteMany({ where: { shopId } });
    await prisma.subscriber.update({
      where: { id: subscriberId },
      data: { nextEmailAt: new Date("2020-01-01T00:00:00.000Z") },
    });

    const retryReserve = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-retry",
      batchSize: 2,
    });
    expect(retryReserve.status).toBe("reserved");
    if (retryReserve.status !== "reserved") return;
    const retryClaim = await claimEmailJobs({
      leaseOwner: "audit-worker-2",
      limit: 1,
      shopId,
    });
    setMockNextSendResult({
      status: "rate_limited",
      retryable: true,
      errorCode: "rate_limited",
      errorMessage: "slow down",
      retryAfterMs: 1000,
    });
    const retryResult = await deliverMarketingEmail({
      emailJobId: retryClaim[0]!.id,
      to: "audit@example.com",
      subject: "Retry",
      html: "<p>r</p>",
      text: "r",
      shopDomain: SHOP,
      provider: createMockEmailProvider(),
      alreadyClaimedJob: retryClaim[0]!,
    });
    expect(retryResult.status).toBe("retry_scheduled");
    const job = await prisma.emailJob.findUniqueOrThrow({
      where: { id: retryClaim[0]!.id },
    });
    expect(job.status).toBe(EmailJobStatus.RETRY_SCHEDULED);
  });

  it("keeps providerMessageId when marking UNKNOWN after ambiguous acceptance race", async () => {
    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-unknown",
      batchSize: 2,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    const claimed = await claimEmailJobs({
      leaseOwner: "audit-unknown-worker",
      limit: 1,
      shopId,
    });
    setMockNextSendResult({
      status: "ambiguous",
      retryable: true,
      providerMessageId: "ambiguous-msg-1",
      errorCode: "timeout",
      errorMessage: "provider timeout after accept",
    });
    const result = await deliverMarketingEmail({
      emailJobId: claimed[0]!.id,
      to: "audit@example.com",
      subject: "Ambiguous",
      html: "<p>a</p>",
      text: "a",
      shopDomain: SHOP,
      provider: createMockEmailProvider(),
      alreadyClaimedJob: claimed[0]!,
    });
    expect(result.status).toBe("unknown");
    const job = await prisma.emailJob.findUniqueOrThrow({
      where: { id: claimed[0]!.id },
    });
    expect(job.status).toBe(EmailJobStatus.UNKNOWN);
    expect(job.providerMessageId).toBe("ambiguous-msg-1");
  });

  it("recovers stale leases and skips overlapping schedulers", async () => {
    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-stale",
      batchSize: 2,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    await prisma.emailJob.update({
      where: { id: reserved.job.id },
      data: {
        status: EmailJobStatus.PROCESSING,
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const recovered = await recoverStaleEmailJobLeases();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const held = await tryDurableLock({
      lockId: DURABLE_LOCKS.scheduler,
      owner: "holder",
      ttlMs: 60_000,
    });
    expect(held).toBe(true);
    const overlap = await runEmailScheduler({ workerId: "challenger" });
    expect(overlap.locked).toBe(false);
    await releaseDurableLock({
      lockId: DURABLE_LOCKS.scheduler,
      owner: "holder",
    });
  });

  it("renders email templates safely and reports live dashboard stats", async () => {
    const rendered = renderProductEmail({
      products: [
        {
          id: productIds[0]!,
          title: `<script>alert(1)</script>`,
          handle: "safe",
          imageUrl: "javascript:alert(1)",
          price: "10",
          currencyCode: "USD",
        },
      ],
      brand: {
        logoUrl: "javascript:alert(1)",
        unsubscribeUrl: "javascript:alert(1)",
      },
    });
    expect(rendered.html).not.toContain("javascript:alert");
    expect(rendered.html).toContain("&lt;script&gt;");

    const stats = await getDashboardStats(shopId);
    expect(stats.totals.totalProducts).toBeGreaterThanOrEqual(4);
    expect(stats.totals.totalSubscribers).toBeGreaterThanOrEqual(1);
  });

  it("cancels jobs and disables automation on uninstall", async () => {
    const reserved = await reserveEmailBatch({
      shopId,
      subscriberId,
      idempotencyKey: "audit-uninstall",
      batchSize: 2,
    });
    expect(reserved.status).toBe("reserved");
    await handleAppUninstalled({ shopDomain: SHOP, shopId });
    const settings = await prisma.automationSettings.findUniqueOrThrow({
      where: { shopId },
    });
    expect(settings.automationEnabled).toBe(false);
    const active = await prisma.emailJob.count({
      where: {
        shopId,
        status: {
          in: [
            EmailJobStatus.PENDING,
            EmailJobStatus.PROCESSING,
            EmailJobStatus.RETRY_SCHEDULED,
            EmailJobStatus.UNKNOWN,
          ],
        },
      },
    });
    expect(active).toBe(0);
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.uninstalledAt).not.toBeNull();

    await prisma.shop.update({
      where: { id: shopId },
      data: { uninstalledAt: null },
    });
    await prisma.automationSettings.update({
      where: { shopId },
      data: { automationEnabled: true },
    });
  });
});
