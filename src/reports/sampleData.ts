export function salesSampleCsv(): Buffer {
  const products = ["Cherry Cloud", "Agent Workspace", "Report Studio", "Private AI"];
  const regions = ["กรุงเทพฯ", "ภาคกลาง", "ภาคเหนือ", "ภาคตะวันออก", "ภาคใต้"];
  const rows = [["date", "region", "product", "revenue", "cost", "orders", "status"]];
  for (let month = 0; month < 12; month += 1) {
    for (let index = 0; index < 10; index += 1) {
      const date = new Date(Date.UTC(2025, month, 1 + index * 2)).toISOString().slice(0, 10);
      const product = products[(month + index) % products.length] ?? products[0] ?? "Product";
      const region = regions[(month * 2 + index) % regions.length] ?? regions[0] ?? "Region";
      const orders = 8 + ((month * 7 + index * 3) % 34);
      const revenue = orders * (4200 + ((month + index) % 5) * 900);
      const cost = Math.round(revenue * (0.48 + ((index % 4) * 0.035)));
      rows.push([date, region, product, String(revenue), String(cost), String(orders), index % 9 === 0 ? "pending" : "completed"]);
    }
  }
  return Buffer.from(rows.map((row) => row.map((cell) => /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(",")).join("\n") + "\n", "utf8");
}
