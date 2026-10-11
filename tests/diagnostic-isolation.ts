import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Test runners must never inherit the active product's diagnostic sink or private capture policy.
const root=mkdtempSync(join(tmpdir(),"tela-test-diagnostics-"));
process.env.CHATGPT_TELA_DIAGNOSTIC_FILE=join(root,"test.diagnostics.jsonl");
process.env.CHATGPT_TELA_DIAGNOSTIC_ENVIRONMENT="test";
process.on("exit",()=>{delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;rmSync(root,{recursive:true,force:true});});
