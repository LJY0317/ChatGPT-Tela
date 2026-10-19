import { expect, test, spyOn } from "bun:test";
import { observeDiagnosticEvents } from "@chatgpt-tela/core";
import { diagnosePublicIngress } from "./public-ingress-diagnostics";

test("on-demand ingress snapshot keeps only structural local state and never gates DNS evidence", async () => {
  const rows: unknown[] = [], calls: string[][] = [];
  const stop = observeDiagnosticEvents(row => rows.push(row));
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ Status: 0, Answer: [] }));
  try {
    const result = await diagnosePublicIngress(new URL("https://fixture.invalid/mcp"), "https://resolver.invalid", {
      async run(args) {
        calls.push([...args]);
        return { stderr: "", stdout: JSON.stringify(args[0] === "status"
          ? { BackendState: "Running", Self: { Online: true, DNSName: "private-host" }, Health: ["private-health"],
            Peer: { private: { Tags: ["tag:ingress"], DNSName: "private-peer" } } }
          : { AllowFunnel: { "private-host:443": true }, Web: { private: { Proxy: "private-proxy" } } }) };
      },
    });
    expect(result).toMatchObject({ stage: "dns", localState: { status_observed: true, routes_observed: true,
      state: "running", node_online: true, health_count: 1, ingress_peer_count: 1, funnel_enabled_count: 1 } });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify({ rows, result })).not.toMatch(/private-host|private-health|private-peer|private-proxy/);
    const failed = await diagnosePublicIngress(new URL("https://fixture.invalid/mcp"), "https://resolver.invalid", {
      async run() { throw Error("private-failure"); },
    });
    expect(failed).toMatchObject({ stage: "dns", localState: { status_observed: false, routes_observed: false } });
    expect(JSON.stringify(rows)).not.toContain("private-failure");
  } finally { fetchMock.mockRestore(); stop?.(); }
});
