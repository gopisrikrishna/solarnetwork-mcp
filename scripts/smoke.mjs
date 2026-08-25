/**
 * Live end-to-end probe of every tool against SolarNetwork's public API.
 * Not a test suite -- it hits the real network and prints what came back.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"] }),
);

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

const calls = [
  ["list_sources", { nodeId: 1000 }],
  ["diagnose_site", {
    nodeId: 1000,
    startDate: "2026-08-01",
    endDate: "2026-08-24",
    aggregation: "Day",
  }],
  ["get_energy", {
    nodeIds: [1000],
    localStartDate: "2026-08-01T00:00",
    localEndDate: "2026-08-24T00:00",
  }],
  ["compare_fleet", {
    nodeIds: [1000, 976, 953, 964, 987],
    startDate: "2026-08-17",
    endDate: "2026-08-24",
    aggregation: "Day",
  }],
];

for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  const label = r.isError ? `${name} [ERROR]` : name;
  console.log(`===== ${label} =====`);
  console.log(r.content[0].text.slice(0, 2600));
  console.log();
}

await client.close();
