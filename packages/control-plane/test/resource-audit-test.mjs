import assert from "node:assert/strict";
import { evaluateAccountMetrics } from "../../../infra/scripts/cloudflare-resource-audit.mjs";

const budget = {
  maxRequests: 80_000,
  maxErrorRate: 0.01,
  maxCpuP99Microseconds: 8_000,
  maxSubrequestsPerRequest: 10,
};
const healthy = evaluateAccountMetrics({
  alias: "acc1",
  expectedWorkerNames: ["opus8cf-control", "opus8cf-node-acc1-n1-v2"],
  deployedWorkerNames: ["another-worker", "opus8cf-control", "opus8cf-node-acc1-n1-v2"],
  records: [
    {
      dimensions: { scriptName: "opus8cf-control", status: "success" },
      sum: { requests: 1_000, errors: 2, subrequests: 1_000 },
      quantiles: { cpuTimeP99: 500 },
    },
    {
      dimensions: {
        scriptName: "opus8cf-node-acc1-n1-v2",
        status: "success",
      },
      sum: { requests: 2_000, errors: 0, subrequests: 4_000 },
      quantiles: { cpuTimeP99: 1_200 },
    },
  ],
  budget,
});
assert.equal(healthy.ok, true);
assert.equal(healthy.totals.requests, 3_000);
assert.equal(healthy.rates.subrequestsPerRequest, 5_000 / 3_000);

const blocked = evaluateAccountMetrics({
  alias: "acc1",
  expectedWorkerNames: ["opus8cf-control"],
  deployedWorkerNames: ["opus8cf-control", "opus8cf-control-old"],
  records: [
    {
      dimensions: { scriptName: "opus8cf-control", status: "exceededResources" },
      sum: { requests: 81_000, errors: 2_000, subrequests: 900_000 },
      quantiles: { cpuTimeP99: 9_000 },
    },
  ],
  budget,
});
assert.equal(blocked.ok, false);
for (const expected of [
  "request_budget",
  "error_rate",
  "cpu_p99",
  "subrequests_per_request",
  "exceeded_resources",
  "undeclared_opus8_workers",
]) {
  assert(blocked.violations.includes(expected), `missing violation ${expected}`);
}

console.log("resource audit tests passed");
