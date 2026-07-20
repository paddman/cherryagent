export const DEFAULT_TENANT_ID = "org-default";
export const DEFAULT_TENANT_NAME = "Cherry Workspace";
export const DEFAULT_TENANT_PLAN = "shared" as const;

export type TenantPlan = "pilot" | "shared" | "enterprise" | "dedicated";
