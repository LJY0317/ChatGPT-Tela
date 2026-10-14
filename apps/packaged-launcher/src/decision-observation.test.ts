import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeTelaDecisions } from "./decision-observation";
import { runPackagedDiagnosticsCommand } from "./diagnostics";

test("missing, malformed, stale and genuinely empty decision evidence remain distinct",()=>{
  const root=mkdtempSync(join(tmpdir(),"tela-decisions-coverage-")),file=join(root,"menu-ui-events.json"),now=Date.now();
  try{
    expect(observeTelaDecisions(root,now)).toMatchObject({evidenceState:"unavailable",sourceState:"missing"});
    writeFileSync(file,"not-json");expect(observeTelaDecisions(root,now)).toMatchObject({evidenceState:"unavailable",sourceState:"invalid"});
    writeFileSync(file,"[]");expect(observeTelaDecisions(root,now)).toMatchObject({evidenceState:"empty",sourceState:"read"});
    writeFileSync(file,JSON.stringify([{at:(now-2*86400_000)/1000,slot:1,event:"decision_web_reopen_pending",uiSession:"11111111-1111-4111-8111-111111111111",decision:"22222222-2222-4222-8222-222222222222"}]));
    expect(observeTelaDecisions(root,now)).toMatchObject({evidenceState:"stale",currentForeignAppPrompts:"not_observable"});
    writeFileSync(file,JSON.stringify([{at:now/1000,slot:1,event:"decision_web_reopen_pending",decision:"invalid",uiSession:"invalid"}]));
    expect(observeTelaDecisions(root,now)).toMatchObject({evidenceState:"unavailable",invalidDecisionRows:1});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("read-only Tela dialog evidence distinguishes unanswered from resolved, without exposing dialog text", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-owned-dialogs-"));
  const time = Date.parse("2026-10-14T12:00:00Z");
  const uiSession = "11111111-1111-4111-8111-111111111111";
  const reopenId = "22222222-2222-4222-8222-222222222222";
  const disconnectId = "33333333-3333-4333-8333-333333333333";
  const write = (rows: object[]) => writeFileSync(join(root, "menu-ui-events.json"), JSON.stringify(rows), { mode: 0o600 });
  try {
    const pending = { at: time / 1000, event: "decision_web_reopen_pending",
      slot: 1, uiSession, decision: reopenId, dialogText: "private conversation title" };
    const closing = { at: time / 1000 + 1, event: "decision_web_disconnect_pending",
      slot: 2, uiSession, decision: disconnectId, buttonText: "private label" };
    const resolution = { ...closing, at: time / 1000 + 2, event: "decision_web_disconnect_deferred" };
    write([pending, closing, resolution]);
    const snapshot = runPackagedDiagnosticsCommand(["diagnostics", "decisions"], { logsRoot: root }) as ReturnType<typeof observeTelaDecisions>;
    // The default command observes current time, so use the deterministic helper
    // to exercise a synthetic old event without weakening production recency.
    const result = observeTelaDecisions(root, time + 5_000);
    expect(result.observed).toEqual([
      { slot: 1, kind: "web_reopen", state: "unanswered_at_last_observation",
        observedAt: new Date(time).toISOString(), owner: "tela_menu_bar", currentWindowPresence: "unverified" },
      { slot: 2, kind: "web_disconnect", state: "deferred",
        observedAt: new Date(time + 2_000).toISOString(), owner: "tela_menu_bar", currentWindowPresence: "unverified" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.currentForeignAppPrompts).toBe("not_observable");
    expect(observeTelaDecisions(root, time + 2 * 86400_000).observed).toHaveLength(0);
    write([{ ...pending, decision: "not-an-id" }, { ...pending, event: "another_apps_dialog" }]);
    expect(observeTelaDecisions(root, time + 5_000).observed).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
