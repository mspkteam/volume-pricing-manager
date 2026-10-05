import type { PricingCompatibility, PricingSyncStatus } from "@prisma/client";

export function pricingStatusLabel(status: PricingSyncStatus): string {
  switch (status) {
    case "NOT_CONFIGURED":
      return "Setup required";
    case "READY":
      return "Ready";
    case "SYNCING":
      return "Syncing";
    case "SYNCED":
      return "Synced";
    case "FAILED":
      return "Failed";
    case "UNSUPPORTED":
      return "Unsupported";
    default:
      return status;
  }
}

export function pricingCompatibilityLabel(compatibility: PricingCompatibility): string {
  switch (compatibility) {
    case "UNKNOWN":
      return "Unknown";
    case "SUPPORTED":
      return "Supported";
    case "UNSUPPORTED":
      return "Unsupported";
    case "SETUP_REQUIRED":
      return "Setup required";
    default:
      return compatibility;
  }
}
