import type { AgentTool } from "../../core/types.js";
import type { SystemDoctor } from "../../doctor/SystemDoctor.js";

export function createDoctorTools(doctor: SystemDoctor): AgentTool[] {
  return [
    {
      name: "system_doctor",
      description: "Run read-only deployment, security, channel-ingress, model-failover, storage, and optional Python AI worker diagnostics. Use before remote exposure and when the agent behaves inconsistently.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => doctor.run(),
    },
  ];
}
