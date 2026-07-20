import type { AgentTool } from "../core/types.js";

const intentPacks: Array<{ pattern: RegExp; prefixes: string[] }> = [
  { pattern: /(excel|xlsx|csv|spreadsheet|report|dashboard|kpi|ยอดขาย|รายงาน|ตาราง|กราฟ|ข้อมูล)/i, prefixes: ["report_", "planner_", "memory_", "files_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(tor|rfp|proposal|bid|ประมูล|ข้อกำหนด|compliance)/i, prefixes: ["bidpilot_", "files_", "planner_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(email|gmail|calendar|drive|meeting|อีเมล|ปฏิทิน|ประชุม|เอกสาร)/i, prefixes: ["gmail_", "calendar_", "drive_", "office_", "planner_", "memory_", "report_", "files_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(incident|server|docker|vm|proxmox|database|sql|redis|debug|แก้ระบบ|ฐานข้อมูล|เซิร์ฟเวอร์)/i, prefixes: ["engineer_", "proxmox_", "vsphere_", "db_", "files_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(stock|crypto|market|trade|หุ้น|คริปโต|ตลาด|ราคา)/i, prefixes: ["market_", "trade_", "planner_", "system_", "orchestrator_", "agent_"] },
];

const defaultPrefixes = ["report_", "office_", "planner_", "memory_", "files_", "system_", "orchestrator_", "agent_"];

export function routeToolNames(message: string, tools: AgentTool[], unavailablePrefixes: readonly string[] = []): Set<string> {
  const selectedPacks = intentPacks.filter((pack) => pack.pattern.test(message));
  const prefixes = [...new Set((selectedPacks.length ? selectedPacks.flatMap((pack) => pack.prefixes) : defaultPrefixes))];
  const names = tools
    .filter((tool) => prefixes.some((prefix) => tool.name.startsWith(prefix)))
    .filter((tool) => !unavailablePrefixes.some((prefix) => tool.name.startsWith(prefix)))
    .slice(0, 60)
    .map((tool) => tool.name);
  return new Set(names);
}
