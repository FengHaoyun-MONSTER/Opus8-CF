export interface ComplianceEnv {
  COMPLIANCE_PROXY_ALLOWED?: string;
  COMPLIANCE_ENFORCEMENT_MODE?: string;
  COMPLIANCE_POLICY_ID?: string;
  COMPLIANCE_MAINTENANCE_NODE_IDS?: string;
}

export interface ComplianceStatus {
  proxyProvisioningAllowed: boolean;
  enforcement: "fail-closed" | "observe-only";
  policyId: string;
  reason:
    | "operator_override"
    | "documented_authorization_verified"
    | "documented_authorization_required";
}

export function complianceStatus(env: ComplianceEnv): ComplianceStatus {
  const proxyProvisioningAllowed =
    env.COMPLIANCE_PROXY_ALLOWED === "1";
  const observeOnly =
    env.COMPLIANCE_ENFORCEMENT_MODE === "observe-only";
  return {
    proxyProvisioningAllowed,
    enforcement: observeOnly ? "observe-only" : "fail-closed",
    policyId: env.COMPLIANCE_POLICY_ID || "cloudflare-data-plane-v1",
    reason: observeOnly
      ? "operator_override"
      : proxyProvisioningAllowed
      ? "documented_authorization_verified"
      : "documented_authorization_required",
  };
}

export function proxyProvisioningAllowed(env: ComplianceEnv): boolean {
  return complianceStatus(env).proxyProvisioningAllowed;
}

export function maintenanceNodeAllowed(
  env: ComplianceEnv,
  nodeId: string,
): boolean {
  return (env.COMPLIANCE_MAINTENANCE_NODE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(nodeId);
}

export function trafficLimitIncreases(
  current: number,
  requested: number | undefined,
): boolean {
  if (requested === undefined || current === 0) return false;
  return requested === 0 || requested > current;
}

function hostCovered(host: string, allowed: string[]): boolean {
  return allowed.some(
    (parent) => host === parent || host.endsWith(`.${parent}`),
  );
}

export function domainScopeIncreases(
  current: string[],
  requested: string[],
  emptyMeansAll = false,
): boolean {
  if (emptyMeansAll) {
    if (current.length === 0) return false;
    if (requested.length === 0) return true;
  }
  return requested.some((host) => !hostCovered(host, current));
}
