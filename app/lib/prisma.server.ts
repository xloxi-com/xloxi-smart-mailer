/**
 * Vite SSR–safe Prisma runtime exports.
 *
 * `@prisma/client` is CommonJS. Vite's SSR module runner fails named ESM imports
 * (`import { WebhookEventStatus } from '@prisma/client'`) via analyzeImportedModDifference.
 * Loading through `createRequire` avoids that analysis; we re-export real ESM bindings
 * with matching type aliases so enum names work as both values and types.
 *
 * For the `Prisma` namespace types (`Prisma.EmailJobWhereInput`, etc.), also:
 *   import type { Prisma } from "@prisma/client";
 * alongside the value import from this module when needed.
 */
import { createRequire } from "node:module";
import type {
  AuditAction as AuditActionType,
  EmailEventType as EmailEventTypeType,
  EmailJobStatus as EmailJobStatusType,
  FlowBatchStatus as FlowBatchStatusType,
  MarketingConsentState as MarketingConsentStateType,
  PrismaClient as PrismaClientType,
  SuppressionReason as SuppressionReasonType,
  SyncJobStatus as SyncJobStatusType,
  SyncJobType as SyncJobTypeType,
  WebhookEventStatus as WebhookEventStatusType,
} from "@prisma/client";

const require = createRequire(import.meta.url);

/** Drop stale CJS entries after `prisma generate` so Vite SSR picks up new DMMF. */
function loadPrismaPackage(): typeof import("@prisma/client") {
  if (process.env.NODE_ENV !== "production") {
    for (const key of Object.keys(require.cache)) {
      if (
        key.includes(`${"@prisma"}${"/"}client`) ||
        key.includes(".prisma\\client") ||
        key.includes(".prisma/client")
      ) {
        delete require.cache[key];
      }
    }
  }
  return require("@prisma/client") as typeof import("@prisma/client");
}

const prismaPackage = loadPrismaPackage();

const PrismaClient = prismaPackage.PrismaClient;
type PrismaClient = PrismaClientType;
export { PrismaClient };

/** Runtime Prisma helpers (DbNull, validator, etc.). Import type namespace from `@prisma/client`. */
export const Prisma = prismaPackage.Prisma;

const WebhookEventStatus = prismaPackage.WebhookEventStatus;
type WebhookEventStatus = WebhookEventStatusType;
export { WebhookEventStatus };

const EmailJobStatus = prismaPackage.EmailJobStatus;
type EmailJobStatus = EmailJobStatusType;
export { EmailJobStatus };

const EmailEventType = prismaPackage.EmailEventType;
type EmailEventType = EmailEventTypeType;
export { EmailEventType };

const MarketingConsentState = prismaPackage.MarketingConsentState;
type MarketingConsentState = MarketingConsentStateType;
export { MarketingConsentState };

const SuppressionReason = prismaPackage.SuppressionReason;
type SuppressionReason = SuppressionReasonType;
export { SuppressionReason };

const SyncJobStatus = prismaPackage.SyncJobStatus;
type SyncJobStatus = SyncJobStatusType;
export { SyncJobStatus };

const SyncJobType = prismaPackage.SyncJobType;
type SyncJobType = SyncJobTypeType;
export { SyncJobType };

const AuditAction = prismaPackage.AuditAction;
type AuditAction = AuditActionType;
export { AuditAction };

const FlowBatchStatus = prismaPackage.FlowBatchStatus;
type FlowBatchStatus = FlowBatchStatusType;
export { FlowBatchStatus };
