export type {
  AdminAccount,
  AdminAccounts,
  AdminDeviceFlow as DeviceFlow,
  AdminDeviceFlowPoll as DeviceFlowPoll,
  AdminHistorySummary,
  AdminModels,
  AdminPerformanceMetric,
  AdminPreference,
  AdminRuntimeConfig,
  AdminStatus,
} from "../../src/admin/api.js";
export type { AdminSessionMetadata } from "../../src/admin/auth.js";
export type {
  AdminEventPage,
  AdminOperationalEvent,
  AdminUsagePage,
} from "../../src/telemetry/admin.js";

export type StreamState = "connecting" | "live" | "reconnecting";
