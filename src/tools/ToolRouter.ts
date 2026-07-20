import type { AgentTool } from "../core/types.js";

const intentPacks: Array<{ pattern: RegExp; prefixes: string[] }> = [
  { pattern: /(excel|xlsx|csv|spreadsheet|report|dashboard|kpi|ยอดขาย|รายงาน|ตาราง|กราฟ|ข้อมูล)/i, prefixes: ["report_", "planner_", "memory_", "files_", "mcp_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(tor|rfp|proposal|bid|ประมูล|ข้อกำหนด|compliance)/i, prefixes: ["bidpilot_", "files_", "planner_", "mcp_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(email|gmail|calendar|drive|meeting|อีเมล|ปฏิทิน|ประชุม|เอกสาร)/i, prefixes: ["gmail_", "calendar_", "drive_", "office_", "planner_", "memory_", "report_", "files_", "mcp_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(ssh|linux|ubuntu|debian|shell|bash|systemctl|journalctl|nginx|apache|docker|server|node|machine|host|vm|proxmox|incident|database|sql|redis|debug|disk|filesystem|process|network|port|แก้ระบบ|ฐานข้อมูล|เซิร์ฟเวอร์|เครื่อง|ลินุกซ์|เชื่อมต่อ|ตรวจเครื่อง|\b(?:\d{1,3}\.){3}\d{1,3}\b)/i, prefixes: ["node_", "linux_", "security_", "engineer_", "proxmox_", "vsphere_", "db_", "files_", "system_", "orchestrator_", "agent_", "mcp_"] },
  { pattern: /(mcp|model context protocol|tool server|เครื่องมือเสริม)/i, prefixes: ["mcp_", "node_", "system_", "orchestrator_", "agent_"] },
  { pattern: /(stock|crypto|market|trade|หุ้น|คริปโต|ตลาด|ราคา)/i, prefixes: ["market_", "trade_", "planner_", "mcp_", "system_", "orchestrator_", "agent_"] },
];

const defaultPrefixes = ["report_", "office_", "planner_", "memory_", "files_", "node_", "mcp_", "system_", "orchestrator_", "agent_"];

export function routeToolNames(message: string, tools: AgentTool[], unavailablePrefixes: readonly string[] = []): Set<string> {
  const selectedPacks = intentPacks.filter((pack) => pack.pattern.test(message));
  const prefixes = [...new Set((selectedPacks.length ? selectedPacks.flatMap((pack) => pack.prefixes) : defaultPrefixes))];
  const matching = tools
    .filter((tool) => prefixes.some((prefix) => tool.name.startsWith(prefix)))
    .filter((tool) => !unavailablePrefixes.some((prefix) => tool.name.startsWith(prefix)));
  const messageTerms = new Set(message.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 2));
  const ranked = matching.sort((a, b) => {
    const score = (tool: AgentTool) => [...messageTerms].reduce((total, term) =>
      total + (tool.name.toLowerCase().includes(term) ? 4 : 0) + (tool.description.toLowerCase().includes(term) ? 1 : 0), 0);
    return score(b) - score(a);
  });
  const reserved = ranked.filter((tool) => tool.name.startsWith("node_") || tool.name.startsWith("mcp_")).slice(0, 20);
  const names = [...reserved, ...ranked]
    .filter((tool, index, items) => items.findIndex((candidate) => candidate.name === tool.name) === index)
    .slice(0, 60)
    .map((tool) => tool.name);
  return new Set(names);
}
