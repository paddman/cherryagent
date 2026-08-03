import type { AgentTool } from "../core/types.js";

const intentPacks: Array<{ pattern: RegExp; prefixes: string[] }> = [
  { pattern: /(excel|xlsx|csv|spreadsheet|report|dashboard|kpi|ยอดขาย|รายงาน|ตาราง|กราฟ|ข้อมูล)/i, prefixes: ["report_", "planner_", "memory_", "skill_", "ai_", "files_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(tor|rfp|proposal|bid|ประมูล|ข้อกำหนด|compliance)/i, prefixes: ["bidpilot_", "files_", "planner_", "skill_", "ai_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(email|gmail|calendar|drive|meeting|อีเมล|ปฏิทิน|ประชุม|เอกสาร)/i, prefixes: ["gmail_", "calendar_", "drive_", "office_", "planner_", "memory_", "report_", "skill_", "ai_", "files_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(ssh|linux|ubuntu|debian|shell|bash|systemctl|journalctl|nginx|apache|docker|server|vm|proxmox|incident|database|sql|redis|debug|disk|filesystem|process|network|port|แก้ระบบ|ฐานข้อมูล|เซิร์ฟเวอร์|ลินุกซ์|เชื่อมต่อ|ตรวจเครื่อง|\b(?:\d{1,3}\.){3}\d{1,3}\b)/i, prefixes: ["linux_", "security_", "engineer_", "skill_", "proxmox_", "vsphere_", "db_", "files_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(stock|crypto|market|trade|หุ้น|คริปโต|ตลาด|ราคา)/i, prefixes: ["market_", "trade_", "planner_", "skill_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(skill|runbook|procedure|playbook|learn this|remember how|ทักษะ|รันบุ๊ก|คู่มือ|จำวิธี|เรียนรู้วิธี)/i, prefixes: ["skill_", "engineer_", "memory_", "files_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(embedding|rerank|rag|chunk|semantic|vector|ocr|document ai|เอ็มเบด|เวกเตอร์|แบ่งชังก์|จัดอันดับเอกสาร)/i, prefixes: ["ai_", "skill_", "report_", "files_", "memory_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(pairing|allowlist|channel access|approve sender|revoke sender|จับคู่|อนุมัติผู้ส่ง|เพิกถอนผู้ส่ง|ช่องทางภายนอก)/i, prefixes: ["channel_access_", "system_", "planner_", "agent_"] },
];

const defaultPrefixes = ["report_", "office_", "planner_", "memory_", "skill_", "files_", "system_", "orchestrator_", "agent_"];

export function routeToolNames(message: string, tools: AgentTool[], unavailablePrefixes: readonly string[] = []): Set<string> {
  const selectedPacks = intentPacks.filter((pack) => pack.pattern.test(message));
  const prefixes = [...new Set((selectedPacks.length ? selectedPacks.flatMap((pack) => pack.prefixes) : defaultPrefixes))];
  const names = tools
    .filter((tool) => prefixes.some((prefix) => tool.name.startsWith(prefix)))
    .filter((tool) => !unavailablePrefixes.some((prefix) => tool.name.startsWith(prefix)))
    .slice(0, 72)
    .map((tool) => tool.name);
  return new Set(names);
}
