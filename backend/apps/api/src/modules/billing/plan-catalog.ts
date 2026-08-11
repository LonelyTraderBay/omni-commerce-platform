export const PLAN_CATALOG = {
  free: {
    maxPages: 1,
    aiMonthlyTokenLimit: 100_000,
    autoConfirmAllowed: false,
  },
  pilot: {
    maxPages: 2,
    aiMonthlyTokenLimit: 2_000_000,
    autoConfirmAllowed: true,
  },
  starter: {
    maxPages: 5,
    aiMonthlyTokenLimit: 10_000_000,
    autoConfirmAllowed: true,
  },
  enterprise: {
    maxPages: 50,
    aiMonthlyTokenLimit: 100_000_000,
    autoConfirmAllowed: true,
  },
} as const;

export type PlanSlug = keyof typeof PLAN_CATALOG;

export function isPlanSlug(value: string): value is PlanSlug {
  return Object.hasOwn(PLAN_CATALOG, value);
}
