import type { AgentTool } from "../../core/types.js";
import type { LinuxSshClient } from "../../connectors/linux/LinuxSshClient.js";

function optionalInteger(args: Record<string, unknown>, key: string, fallback: number): number {
  if (args[key] === undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ipFamily(value: unknown): "inet" | "ip" | "ip6" {
  if (value === undefined) return "inet";
  if (value !== "inet" && value !== "ip" && value !== "ip6") throw new Error("family must be inet, ip, or ip6");
  return value;
}

function blockKind(value: unknown): "ip" | "subnet" {
  if (value === undefined) return "ip";
  if (value !== "ip" && value !== "subnet") throw new Error("kind must be ip or subnet");
  return value;
}

function serviceKind(value: unknown): "nginx" | "apache" | "caddy" | "generic" {
  if (value === undefined) return "nginx";
  if (value !== "nginx" && value !== "apache" && value !== "caddy" && value !== "generic") {
    throw new Error("service must be nginx, apache, caddy, or generic");
  }
  return value;
}

function nginxLogPath(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function createSecurityOpsTools(linux: LinuxSshClient): AgentTool[] {
  return [
    {
      name: "securityops_get_stack_status",
      description: "Inspect the Linux security stack: nftables/iptables, conntrack, CrowdSec, Suricata, fail2ban, and common WAF-related services. Use this before proposing firewall, DDoS, IDS, IPS, or WAF actions.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => linux.execute([
        "set -o pipefail",
        "echo '## kernel'; uname -a",
        "echo; echo '## firewall backends'; command -v nft || true; command -v iptables || true; command -v ip6tables || true",
        "echo; echo '## nftables'; systemctl is-active nftables 2>/dev/null || true; nft list tables 2>/dev/null || true",
        "echo; echo '## conntrack'; command -v conntrack >/dev/null && conntrack -S 2>/dev/null || true",
        "echo; echo '## security services'; for s in crowdsec crowdsec-firewall-bouncer suricata fail2ban nginx apache2 httpd caddy; do systemctl is-active $s 2>/dev/null | sed \"s/^/$s=/\"; done",
        "echo; echo '## listening sockets'; ss -lntup 2>/dev/null | head -n 80 || true",
      ].join("; ")),
    },
    {
      name: "security_firewall_get_ruleset",
      description: "Read the active Linux firewall ruleset and relevant counters. Prefer this before any firewall change. Does not modify firewall state.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          backend: { type: "string", enum: ["nft", "iptables"], description: "Firewall backend to inspect; defaults to nft" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const backend = optionalString(args, "backend") ?? "nft";
        if (backend !== "nft" && backend !== "iptables") throw new Error("backend must be nft or iptables");
        if (backend === "iptables") {
          return await linux.execute("iptables -S; echo; iptables -L -n -v --line-numbers; echo; ip6tables -S 2>/dev/null || true; echo; ip6tables -L -n -v --line-numbers 2>/dev/null || true");
        }
        return await linux.execute("nft list ruleset -a");
      },
    },
    {
      name: "security_conntrack_summary",
      description: "Inspect conntrack usage, TCP state distribution, top source IPs, and possible connection exhaustion indicators for DDoS diagnosis.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          top: { type: "number", description: "Number of top source IPs to show; defaults to 25" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const top = Math.min(optionalInteger(args, "top", 25), 200);
        return await linux.execute([
          "echo '## conntrack count/max'; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || true; cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || true",
          "echo; echo '## conntrack stats'; command -v conntrack >/dev/null && conntrack -S 2>/dev/null || true",
          "echo; echo '## TCP socket states'; ss -ant state all 2>/dev/null | awk 'NR>1 {c[$1]++} END {for (s in c) print s,c[s]}' | sort -k2 -nr || true",
          `echo; echo '## top remote addresses'; ss -Hant state all 2>/dev/null | awk '{print $5}' | sed 's/.*::ffff://;s/^\\[//;s/\\]$//;s/:.*$//' | grep -E '^[0-9a-fA-F:.]+$' | sort | uniq -c | sort -nr | head -n ${top} || true`,
        ].join("; "));
      },
    },
    {
      name: "security_ddos_snapshot",
      description: "Collect a fast DDoS triage snapshot from Linux: socket states, top talkers, UDP/TCP listeners, firewall counters, conntrack pressure, CPU load, and recent web log intensity. Read-only.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          accessLog: { type: "string", description: "Optional web access log path; defaults to /var/log/nginx/access.log" },
          lines: { type: "number", description: "Recent log lines to sample; defaults to 10000" },
          top: { type: "number", description: "Top result count; defaults to 20" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const log = shellQuote(nginxLogPath(args.accessLog, "/var/log/nginx/access.log"));
        const lines = Math.min(optionalInteger(args, "lines", 10_000), 200_000);
        const top = Math.min(optionalInteger(args, "top", 20), 200);
        return await linux.execute([
          "echo '## load'; uptime; top -b -n1 | head -n 20",
          "echo; echo '## conntrack pressure'; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || true; cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || true",
          "echo; echo '## TCP states'; ss -ant state all 2>/dev/null | awk 'NR>1 {c[$1]++} END {for (s in c) print s,c[s]}' | sort -k2 -nr || true",
          `echo; echo '## top socket peers'; ss -Hant state all 2>/dev/null | awk '{print $5}' | sed 's/.*::ffff://;s/^\\[//;s/\\]$//;s/:.*$//' | sort | uniq -c | sort -nr | head -n ${top} || true`,
          "echo; echo '## listening'; ss -lntup 2>/dev/null | head -n 120 || true",
          "echo; echo '## nft counters'; nft list ruleset -a 2>/dev/null | grep -E 'counter packets|limit rate|drop|reject|synproxy' | head -n 120 || true",
          `echo; echo '## top web clients'; test -r ${log} && tail -n ${lines} ${log} | awk '{print $1}' | sort | uniq -c | sort -nr | head -n ${top} || true`,
          `echo; echo '## top web paths'; test -r ${log} && tail -n ${lines} ${log} | awk '{print $7}' | sort | uniq -c | sort -nr | head -n ${top} || true`,
          `echo; echo '## top status codes'; test -r ${log} && tail -n ${lines} ${log} | awk '{print $9}' | sort | uniq -c | sort -nr || true`,
        ].join("; "), 45_000);
      },
    },
    {
      name: "security_firewall_temporary_block",
      description: "Temporarily block an IP address or subnet using an nftables set with timeout. Creates a Cherry-managed table/chain if needed. Verify service health after use and record rollback evidence.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "IP address or CIDR subnet to block" },
          reason: { type: "string", description: "Human-readable reason for audit output" },
          timeout: { type: "string", description: "nft timeout such as 15m, 1h, or 1d; defaults to 1h" },
          family: { type: "string", enum: ["inet", "ip", "ip6"], description: "nft family; defaults to inet" },
          kind: { type: "string", enum: ["ip", "subnet"], description: "Use ip for address set or subnet for interval set; defaults to ip" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const family = ipFamily(args.family);
        const kind = blockKind(args.kind);
        const target = shellQuote(requiredString(args, "target"));
        const timeout = shellQuote(optionalString(args, "timeout") ?? "1h");
        const reason = shellQuote(optionalString(args, "reason") ?? "Cherry SecurityOps temporary containment");
        const setName = kind === "subnet" ? "cherry_blocked_subnets" : "cherry_blocked_ips";
        const flags = kind === "subnet" ? "flags interval,timeout;" : "flags timeout;";
        const type = family === "ip6" ? "ipv6_addr" : "ipv4_addr";
        const addrExpr = family === "ip6" ? "ip6 saddr" : family === "ip" ? "ip saddr" : family === "inet" && type === "ipv6_addr" ? "ip6 saddr" : "ip saddr";
        return await linux.execute([
          `echo ${reason}`,
          `sudo nft add table ${family} cherry_security 2>/dev/null || true`,
          `sudo nft 'add set ${family} cherry_security ${setName} { type ${type}; ${flags} }' 2>/dev/null || true`,
          `sudo nft 'add chain ${family} cherry_security input { type filter hook input priority -10; policy accept; }' 2>/dev/null || true`,
          `sudo nft add rule ${family} cherry_security input ${addrExpr} @${setName} counter drop comment ${shellQuote("cherry-securityops-temporary-block")} 2>/dev/null || true`,
          `sudo nft add element ${family} cherry_security ${setName} { ${target} timeout ${timeout} }`,
          `sudo nft list set ${family} cherry_security ${setName}`,
        ].join("; "));
      },
    },
    {
      name: "security_firewall_remove_block",
      description: "Remove a Cherry-managed nftables temporary block for one IP or subnet. Use as rollback after false positive or incident closeout.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "IP address or CIDR subnet to remove" },
          family: { type: "string", enum: ["inet", "ip", "ip6"], description: "nft family; defaults to inet" },
          kind: { type: "string", enum: ["ip", "subnet"], description: "Use ip or subnet; defaults to ip" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const family = ipFamily(args.family);
        const setName = blockKind(args.kind) === "subnet" ? "cherry_blocked_subnets" : "cherry_blocked_ips";
        return await linux.execute(`sudo nft delete element ${family} cherry_security ${setName} { ${shellQuote(requiredString(args, "target"))} }; sudo nft list set ${family} cherry_security ${setName}`);
      },
    },
    {
      name: "security_auth_bruteforce_summary",
      description: "Summarize recent Linux SSH/authentication failures from journalctl and auth logs. Use for brute-force detection before blocking.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "journalctl --since value; defaults to 1 hour ago" },
          top: { type: "number", description: "Top source IPs/users to show; defaults to 20" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const since = shellQuote(optionalString(args, "since") ?? "1 hour ago");
        const top = Math.min(optionalInteger(args, "top", 20), 200);
        return await linux.execute([
          `journalctl -u ssh -u sshd --since ${since} --no-pager 2>/dev/null | grep -Ei 'failed|invalid|authentication failure|disconnect|maximum authentication' | tail -n 500 || true`,
          `echo; echo '## top source IPs'; journalctl -u ssh -u sshd --since ${since} --no-pager 2>/dev/null | grep -Eo '([0-9]{1,3}\\.){3}[0-9]{1,3}' | sort | uniq -c | sort -nr | head -n ${top} || true`,
          `echo; echo '## auth.log fallback'; test -r /var/log/auth.log && grep -Ei 'failed|invalid|authentication failure' /var/log/auth.log | tail -n 500 || true`,
        ].join("; "));
      },
    },
    {
      name: "security_web_attack_summary",
      description: "Summarize recent web access logs for suspicious paths, status codes, user agents, top clients, and common exploit probes. Read-only and suitable for HTTP flood/WAF triage.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          accessLog: { type: "string", description: "Access log path; defaults to /var/log/nginx/access.log" },
          lines: { type: "number", description: "Recent lines to analyze; defaults to 20000" },
          top: { type: "number", description: "Top count; defaults to 25" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const log = shellQuote(nginxLogPath(args.accessLog, "/var/log/nginx/access.log"));
        const lines = Math.min(optionalInteger(args, "lines", 20_000), 500_000);
        const top = Math.min(optionalInteger(args, "top", 25), 200);
        const probePattern = shellQuote("(union select|/etc/passwd|wp-login|xmlrpc|\.env|\.git|\.php|base64|cmd=|eval\(|<script|select%20|../|%2e%2e|jndi:|/cgi-bin/)");
        return await linux.execute([
          `test -r ${log} || { echo 'access log not readable:' ${log}; exit 0; }`,
          `echo '## top client IPs'; tail -n ${lines} ${log} | awk '{print $1}' | sort | uniq -c | sort -nr | head -n ${top}`,
          `echo; echo '## status codes'; tail -n ${lines} ${log} | awk '{print $9}' | sort | uniq -c | sort -nr`,
          `echo; echo '## top paths'; tail -n ${lines} ${log} | awk '{print $7}' | sort | uniq -c | sort -nr | head -n ${top}`,
          `echo; echo '## suspicious probes'; tail -n ${lines} ${log} | grep -Eai ${probePattern} | tail -n 200 || true`,
          `echo; echo '## top user agents'; tail -n ${lines} ${log} | awk -F'"' '{print $6}' | sort | uniq -c | sort -nr | head -n ${top}`,
        ].join("; "), 45_000);
      },
    },
    {
      name: "security_suricata_alert_summary",
      description: "Summarize Suricata EVE JSON alerts by signature, source IP, destination IP, and severity. Read-only IDS/IPS triage.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          evePath: { type: "string", description: "Suricata eve.json path; defaults to /var/log/suricata/eve.json" },
          lines: { type: "number", description: "Recent JSON lines to analyze; defaults to 20000" },
          top: { type: "number", description: "Top count; defaults to 20" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const eve = shellQuote(nginxLogPath(args.evePath, "/var/log/suricata/eve.json"));
        const lines = Math.min(optionalInteger(args, "lines", 20_000), 500_000);
        const top = Math.min(optionalInteger(args, "top", 20), 200);
        return await linux.execute([
          `test -r ${eve} || { echo 'eve.json not readable:' ${eve}; exit 0; }`,
          `echo '## alert count'; tail -n ${lines} ${eve} | grep '"event_type":"alert"' | wc -l`,
          `echo; echo '## top signatures'; tail -n ${lines} ${eve} | grep '"event_type":"alert"' | sed -n 's/.*"signature":"\\([^"]*\\)".*/\\1/p' | sort | uniq -c | sort -nr | head -n ${top}`,
          `echo; echo '## top src_ip'; tail -n ${lines} ${eve} | grep '"event_type":"alert"' | sed -n 's/.*"src_ip":"\\([^"]*\\)".*/\\1/p' | sort | uniq -c | sort -nr | head -n ${top}`,
          `echo; echo '## top dest_ip'; tail -n ${lines} ${eve} | grep '"event_type":"alert"' | sed -n 's/.*"dest_ip":"\\([^"]*\\)".*/\\1/p' | sort | uniq -c | sort -nr | head -n ${top}`,
          `echo; echo '## recent alerts'; tail -n ${lines} ${eve} | grep '"event_type":"alert"' | tail -n 50`,
        ].join("; "), 45_000);
      },
    },
    {
      name: "security_waf_summary",
      description: "Inspect common WAF/ModSecurity/OWASP CRS signals from audit logs and service status. Use before disabling any rule or adding exclusions.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", enum: ["nginx", "apache", "caddy", "generic"], description: "Web service family; defaults to nginx" },
          auditLog: { type: "string", description: "Optional ModSecurity audit log path" },
          lines: { type: "number", description: "Recent log lines to sample; defaults to 5000" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const service = serviceKind(args.service);
        const defaultAudit = service === "apache" ? "/var/log/apache2/modsec_audit.log" : "/var/log/modsec_audit.log";
        const audit = shellQuote(nginxLogPath(args.auditLog, defaultAudit));
        const lines = Math.min(optionalInteger(args, "lines", 5_000), 200_000);
        return await linux.execute([
          `echo '## service'; systemctl status --no-pager --full ${shellQuote(service === "apache" ? "apache2" : service)} 2>/dev/null | head -n 80 || true`,
          "echo; echo '## loaded modules/config hints'; nginx -T 2>/dev/null | grep -Ei 'modsecurity|owasp|crs|waf|security2' | head -n 120 || true; apachectl -M 2>/dev/null | grep -Ei 'security|unique' || true",
          `echo; echo '## audit log'; test -r ${audit} && tail -n ${lines} ${audit} | grep -Eai 'ModSecurity|Access denied|\[id "?[0-9]+"?\]|OWASP|CRS|SQL Injection|XSS|RFI|LFI' | tail -n 200 || true`,
          `echo; echo '## top CRS rule ids'; test -r ${audit} && tail -n ${lines} ${audit} | grep -Eao '\[id "?[0-9]+"?\]' | sort | uniq -c | sort -nr | head -n 30 || true`,
        ].join("; "), 45_000);
      },
    },
    {
      name: "security_verify_posture",
      description: "Verify security posture after a mitigation: firewall table exists, SSH is still reachable locally, web endpoint returns expected status, and key services are active.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Optional HTTP/HTTPS endpoint to verify from the Linux host" },
          expectedStatus: { type: "number", description: "Expected HTTP status; defaults to 200" },
          services: { type: "string", description: "Comma-separated systemd services to verify, for example nginx,ssh,suricata" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const expectedStatus = optionalInteger(args, "expectedStatus", 200);
        const url = optionalString(args, "url");
        const services = (optionalString(args, "services") ?? "ssh,sshd,nftables,nginx")
          .split(",")
          .map((service) => service.trim())
          .filter(Boolean);
        const serviceChecks = services.map((service) => `systemctl is-active ${shellQuote(service)} 2>/dev/null | sed 's/^/${service}=/' || true`).join("; ");
        const httpCheck = url
          ? `echo; echo '## http verification'; code=$(curl -sS -L --max-time 10 -o /dev/null -w '%{http_code}' ${shellQuote(url)}); echo status=$code expected=${expectedStatus}; test "$code" = "${expectedStatus}"`
          : "true";
        return await linux.execute([
          "echo '## services'",
          serviceChecks,
          "echo; echo '## firewall cherry table'; nft list table inet cherry_security 2>/dev/null || true",
          "echo; echo '## listening critical sockets'; ss -lntup 2>/dev/null | grep -E ':(22|80|443)\\b' || true",
          httpCheck,
        ].join("; "));
      },
    },
  ];
}
