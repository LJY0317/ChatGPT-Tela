import { expect, test } from "bun:test";
import { prepareWebTurnMedia, formatWebPhysicalContext } from "@chatgpt-tela/chatgpt";
import { bindNativePhysicalEvidence, projectNativeRequestContext } from "./native-request-planner";
import { projectNativeUserContent } from "./native-evidence";
import { AppServerCompactionHistorySource } from "@chatgpt-tela/codex";
import { restoreNativeHistoricalImages } from "@chatgpt-tela/codex";
import { defineNativeTurnAuthority } from "@chatgpt-tela/core";
import { NativeIngressMediaRegistry, prepareNativeIngressTurnMedia } from "@chatgpt-tela/core";
import { constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9RwvWgAAAABJRU5ErkJggg==";
const pdf = "data:application/pdf;base64," + Buffer.from("%PDF-1.4\nsynthetic pdf fixture").toString("base64");

function physical(projection: ReturnType<typeof projectNativeRequestContext>) {
  return bindNativePhysicalEvidence(projection, {
    headRevisionId: projection.headId, activeRequestRevisionId: projection.headId,
    mode: "full" as const, logicalTokens: 100, transferTokens: 100,
    segments: projection.revisions.map(r => ({
      type: "revision" as const, revisionId: r.revision.id, kind: r.revision.kind,
      content: r.content,
    })),
  });
}

/** Public paginated Native fixture; whole-history RPC is deliberately absent. */
function historicalSource(turns: readonly Record<string, unknown>[]) {
  const newestFirst = [...turns].reverse().map(turn => ({
    ...turn, itemsView: "full",
  }));
  return new AppServerCompactionHistorySource(async () => ({
    async request(method: string, params: Record<string, unknown>) {
      if (method === "thread/read") {
        if (params.includeTurns !== false) throw Error("unbounded history read forbidden");
        return { thread: { id: "thread", historyMode: "paginated", status: { type: "active" } } };
      }
      if (method === "thread/turns/list") {
        const offset = params.cursor ? Number(params.cursor) : 0;
        return {
          data: newestFirst.slice(offset, offset + 12),
          nextCursor: offset + 12 < newestFirst.length ? String(offset + 12) : null,
        };
      }
      throw Error("Unexpected Native history method");
    },
    async close() {},
  }));
}

test("Native request with image and document retains ordered references and exact Web upload bytes", () => {
  const projection = projectNativeRequestContext("thread", { input: [{
    type: "message", role: "user",
    content: [{ type: "input_text", text: "Compare these" },
      { type: "input_image", image_url: png },
      { type: "input_file", filename: "private-name.pdf", file_data: pdf }],
  }] });
  expect(projection.media).toHaveLength(2);
  expect(projection.revisions).toHaveLength(1);
  const context = physical(projection);
  const prepared = prepareWebTurnMedia(context, projection.media);
  expect(prepared.files).toHaveLength(2);
  expect(prepared.manifest.map(x => x.kind)).toEqual(["image", "file"]);
  expect(prepared.manifest.every(x => x.revisionId === projection.headId)).toBe(true);
  expect(prepared.files[0]!.mimeType).toBe("image/png");
  expect(prepared.files[1]!.mimeType).toBe("application/pdf");
  expect(Buffer.from(prepared.files[0]!.bytes).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const serialized = JSON.stringify(context);
  expect(serialized).toContain("Compare these");
  expect(serialized).not.toContain(png);
  expect(serialized).not.toContain(pdf);
  expect(serialized).not.toContain("private-name.pdf");
  const message = formatWebPhysicalContext(context, undefined, undefined, projection.media);
  expect(message).toContain("mediaManifest");
  expect(message).toContain(projection.media[0]!.evidence.id);
  expect(message).not.toContain("data:image");
  expect(message).not.toContain("private-name.pdf");
});

test("identical image content in two distinct references uploads once without losing relation", () => {
  const projection = projectNativeRequestContext("thread", { input: [{
    type: "message", role: "user", content: [
      { type: "input_image", image_url: png }, { type: "input_image", image_url: png },
    ],
  }] });
  expect(projection.media[0]!.evidence.id).not.toBe(projection.media[1]!.evidence.id);
  const { files, manifest } = prepareWebTurnMedia(physical(projection), projection.media);
  expect(files).toHaveLength(1);
  expect(manifest).toHaveLength(2);
  expect(manifest[0]!.filename).toBe(manifest[1]!.filename);
  expect(projectNativeRequestContext("thread", { input: [{
    type: "message", role: "user", content: [
      { type: "input_image", image_url: png }, { type: "input_image", image_url: png },
    ],
  }] }).media.map(m => m.evidence.id)).toEqual(projection.media.map(m => m.evidence.id));
});

test("media in structured tool output uses the same evidence and upload contract", () => {
  const projection = projectNativeRequestContext("thread", { input: [
    { type: "message", role: "user", content: "Inspect previous result" },
    { type: "function_call_output", call_id: "call-1", output: [
      { type: "input_image", image_url: png }, { type: "text", text: "Image returned" },
    ] },
  ] });
  expect(projection.media).toHaveLength(1);
  expect(projection.media[0]!.evidence.origin).toBe("tool-result");
  const prepared = prepareWebTurnMedia(physical(projection), projection.media);
  expect(prepared.files).toHaveLength(1);
  expect(projection.revisions[1]!.content).toContain(projection.media[0]!.evidence.id);
  expect(projection.revisions[1]!.content).not.toContain(png);
});

test("MCP image base64 and resource links use typed media without leaking URL or bytes",()=>{
  const bytes=Buffer.from("89504e470d0a1a0a00000000","hex");
  const p=projectNativeRequestContext("thread",{input:[
    {type:"message",role:"user",content:"What did the tool return?"},
    {type:"function_call_output",call_id:"call-2",output:{
      content:[{type:"image",mimeType:"image/png",data:bytes.toString("base64")},
        {type:"resource_link",uri:"https://private.test/download?auth=secret",mimeType:"application/pdf"}],
    }},
  ]});
  expect(p.media).toHaveLength(1);
  const uploaded=prepareWebTurnMedia(physical(p),p.media);
  expect(uploaded.files).toHaveLength(1);
  expect(uploaded.manifest[0]?.kind).toBe("image");
  const text=p.revisions[1]!.content;
  expect(text).not.toContain("auth=secret");
  expect(text).not.toContain(bytes.toString("base64"));
  expect(text).toContain('"kind":"file"');
  expect(text).toContain("unavailable");
});

test("public Native MCP tool result preserves embedded PDF, image and text resources as owned evidence", () => {
  const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const document = Buffer.from("%PDF-1.4\nMCP synthetic document");
  const projection = projectNativeRequestContext("thread", { input: [
    { type: "message", role: "user", content: "Inspect the MCP result" },
    { type: "mcp_tool_call_output", call_id: "owned-tool-call", output: {
      content: [
        { type: "image", mimeType: "image/png", data: image.toString("base64") },
        { type: "resource", resource: {
          uri: "file:///private/native/owner/document.pdf",
          mimeType: "application/pdf", blob: document.toString("base64"),
        }},
        { type: "resource", resource: {
          uri: "resource://owner/summary", mimeType: "text/plain", text: "Document summary" ,
        }},
        { type: "resource_link", uri: "https://private.test/doc?auth=secret",
          name: "Private attachment", mimeType: "application/pdf" },
      ],
      structuredContent: { status: "available" }, isError: false,
    }},
  ] });
  expect(projection.revisions.map(row => row.revision.kind)).toEqual(["user", "tool-result"]);
  expect(projection.media.map(row => [row.evidence.kind, row.evidence.origin])).toEqual([
    ["image", "tool-result"], ["file", "tool-result"], ["file", "tool-result"],
  ]);
  const { manifest, files, statistics } = prepareWebTurnMedia(physical(projection), projection.media);
  expect(files.map(f => f.mimeType)).toEqual(["image/png", "application/pdf", "text/plain"]);
  expect(statistics).toEqual({
    logicalReferences: 3, uniqueFiles: 3,
    uniqueBytes: image.length + document.length + Buffer.byteLength("Document summary"),
  });
  expect(manifest.every(entry => entry.revisionId === projection.revisions[1]!.revision.id)).toBe(true);
  expect(Buffer.from(files[1]!.bytes)).toEqual(document);
  expect(Buffer.from(files[2]!.bytes).toString("utf8")).toBe("Document summary");
  const visible = projection.revisions[1]!.content;
  expect(visible).toContain('"status":"available"');
  expect(visible).toContain('"availability":"unavailable"');
  for (const forbidden of ["file:///private", "auth=secret", document.toString("base64"),
    image.toString("base64"), "Document summary", "resource://owner/"]) {
    expect(visible).not.toContain(forbidden);
  }
});

test("MCP returned encrypted payloads are not Web model content or upload receipts", () => {
  const encrypted = "sensitive-encrypted-output-with-no-readable-model-provenance";
  const hidden = "private-mcp-tool-marked-encrypted-text";
  const result = projectNativeRequestContext("thread", { input: [
    { type: "message", role: "user", content: "Summarize only supported tool evidence" },
    { type: "mcp_tool_call_output", call_id: "tool", output: {
      content: [
        { type: "encrypted_content", encrypted_content: encrypted },
        { type: "text", text: hidden, _meta: { "codex/encryptedContent": true } },
        { type: "text", text: "Readable content" },
      ],
    }},
  ] });
  expect(result.media).toHaveLength(0);
  const content = result.revisions[1]!.content;
  expect(content).toContain("Readable content");
  expect(content).toContain('"availability":"unavailable"');
  expect(content).not.toContain(encrypted);
  expect(content).not.toContain(hidden);
  expect(content).not.toContain('"encrypted_content"');
});

test("Native MCP unknown resource normalized to input_text JSON is recovered only as exact tool evidence", () => {
  const pdf = Buffer.from("%PDF-1.7\nThe secret code is present only inside this PDF fixture.");
  const originalUri = "file:///private/owner/embedded.pdf?token=private";
  // Native Codex converts MCP resource blocks into JSON-serialized input_text
  // within function_call_output, before Tela receives the Responses request.
  const serialized = JSON.stringify({
    resource: { uri: originalUri, mimeType: "application/pdf", blob: pdf.toString("base64") },
    type: "resource",
  });
  const linked = JSON.stringify({
    uri: "https://sensitive.invalid/paper?auth=secret", type: "resource_link",
  });
  const projection = projectNativeRequestContext("thread", { input: [
    { type: "message", role: "user", content: "What does the prior tool PDF contain?" },
    { type: "function_call_output", call_id: "mcp-native-normalized", output: [
      { type: "input_text", text: serialized },
      { type: "input_text", text: linked },
      { type: "input_text", text: '{"ordinary":"JSON text; must stay text"}' },
    ] },
  ] });
  expect(projection.media).toHaveLength(1);
  expect(projection.media[0]!.evidence).toMatchObject({
    origin: "tool-result", kind: "file", availability: "verified_inline_bytes",
  });
  expect(prepareWebTurnMedia(physical(projection), projection.media).files[0]?.bytes).toEqual(pdf);
  const visible = projection.revisions[1]!.content;
  expect(visible).toContain('"kind":"file"');
  expect(visible).toContain('"availability":"unavailable"');
  expect(visible).toContain("ordinary");
  for (const forbidden of [originalUri, "auth=secret", pdf.toString("base64")]) {
    expect(visible).not.toContain(forbidden);
  }
});

test("MCP embedded resource cannot expand unsupported bytes or turn a link into authorized bytes", () => {
  const received = projectNativeRequestContext("thread", { input: [
    { type: "message", role: "user", content: "Explain unavailable evidence" },
    { type: "mcp_tool_call_output", call_id: "tool", output: { content: [
      { type: "resource", resource: { blob: "raw", mimeType: "application/octet-stream",
        uri: "file:///private/resource" } },
      { type: "resource_link", uri: "https://host.invalid/file?credential=secret" },
    ] } },
  ] });
  expect(received.media).toHaveLength(0);
  const content = received.revisions[1]!.content;
  expect(content.match(/"availability":"unavailable"/g)).toHaveLength(2);
  expect(content).not.toContain("file://");
  expect(content).not.toContain("credential=secret");
  expect(content).not.toContain("raw");
});

test("external URLs, file IDs, missing paths, invalid media and oversized MIME are never fetched", () => {
  for (const entry of [
    { type: "input_image", image_url: "https://example.invalid/private.png" },
    { type: "image", fileId: "remote-file" },
    { type: "localImage", path: "/private/example.png" },
    { type: "input_file", file_id: "remote-document" },
    { type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zy8+" },
    { type: "input_image", image_url: "data:image/png;base64,AA==" },
  ]) {
    expect(() => projectNativeUserContent([entry], "thread", "input:0")).toThrow();
  }
  const refs = projectNativeUserContent([
    { type: "skill", name: "selected", path: "/sensitive/skill.md" },
    { type: "mention", name: "Plugin", path: "app://private" },
  ], "thread", "input:0");
  expect(refs.media.every(m => m.file === undefined && m.evidence.availability === "unavailable")).toBe(true);
  expect(refs.text).not.toContain("/sensitive");
  expect(refs.text).not.toContain("app://private");
});

test("attachment cannot be submitted under a different revision or after tampering with bytes", () => {
  const p = projectNativeRequestContext("thread", { input: [{
    type: "message", role: "user", content: [{ type: "input_image", image_url: png }],
  }] });
  const context = physical(p);
  expect(() => prepareWebTurnMedia({ ...context, segments: [] }, p.media)).toThrow("ownership");
  expect(() => prepareWebTurnMedia(context,
    [{ ...p.media[0]!, revisionId: "foreign" }])).toThrow("ownership");
  expect(() => prepareWebTurnMedia(context, [{
    ...p.media[0]!, file: { ...p.media[0]!.file, bytes: Buffer.from("fake") },
  }])).toThrow("digest");
  expect(() => prepareWebTurnMedia(context, [...p.media, ...p.media])).toThrow("ownership");
});

test("media binding requires exact structured revision provenance, not a matching string",()=>{
  const p=projectNativeRequestContext("thread",{input:[{
    type:"message",role:"user",content:[
      {type:"input_text",text:"nativeEvidenceReference"},
      {type:"input_image",image_url:png},
    ],
  }]});
  const context=physical(p);
  const unbound={...context,segments:context.segments.map(segment=>({
    ...segment,evidence:[],
  }))};
  expect(()=>prepareWebTurnMedia(unbound,p.media)).toThrow("ownership");
  const forged={...context,segments:context.segments.map(segment=>({
    ...segment,evidence:[{...p.media[0]!.evidence,sha256:"f".repeat(64)}],
  }))};
  expect(()=>prepareWebTurnMedia(forged,p.media)).toThrow("ownership");
});

test("current public Native image ingress completes a text-only Responses payload without adding past instructions", () => {
  const pngBuffer=Buffer.from("89504e470d0a1a0a00000000","hex");
  const registry=new NativeIngressMediaRegistry();
  const pending=prepareNativeIngressTurnMedia({threadId:"thread",input:[
    {type:"text",text:"Read my attached image"},
    {type:"image",url:"data:image/png;base64,"+pngBuffer.toString("base64")},
  ]});
  registry.accept(pending,"active-turn");
  const ingress=registry.current("thread","active-turn")!;
  const projection=projectNativeRequestContext("thread",{input:[{
    type:"message",role:"user",content:[{type:"input_text",text:"Read my attached image"}],
  }]},undefined,[],undefined,ingress);
  expect(projection.revisions).toHaveLength(1);
  expect(projection.revisions[0]!.content).toBe("Read my attached image");
  expect(projection.media).toHaveLength(1);
  const upload=prepareWebTurnMedia(physical(projection),projection.media);
  expect(upload.statistics).toMatchObject({logicalReferences:1,uniqueFiles:1,uniqueBytes:pngBuffer.length});
  expect(upload.files[0]?.bytes).toEqual(pngBuffer);
  expect(() => projectNativeRequestContext("another-thread",{input:"test"},undefined,[],undefined,ingress))
    .toThrow("different thread");
  const unavailable=new NativeIngressMediaRegistry();
  unavailable.accept(prepareNativeIngressTurnMedia({threadId:"thread",input:[
    {type:"localImage",path:"/not-authorized"},
  ]}),"active-turn");
  expect(() => projectNativeRequestContext("thread",{input:"test"},undefined,[],undefined,
    unavailable.current("thread","active-turn"))).toThrow("unavailable");
});

test("logical image references and physical file budgets are independent",()=>{
  const repeated=projectNativeRequestContext("thread",{input:[{
    type:"message",role:"user",
    content:Array.from({length:12},()=>({type:"input_image",image_url:png})),
  }]});
  const prepared=prepareWebTurnMedia(physical(repeated),repeated.media);
  expect(prepared.statistics).toEqual({
    logicalReferences:12,uniqueFiles:1,uniqueBytes:repeated.media[0]!.file.bytes.byteLength,
  });
  const different=projectNativeRequestContext("thread",{input:[{
    type:"message",role:"user",
    content:Array.from({length:9},(_,index)=>({
      type:"input_image",image_url:"data:image/png;base64,"
        +Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),Buffer.from([index])]).toString("base64"),
    })),
  }]});
  expect(()=>prepareWebTurnMedia(physical(different),different.media)).toThrow("attachment count");
});

test("public Native compaction checkpoint binds inline historical image to assistant evidence without executing old request", async () => {
  const history = await historicalSource([
      { id:"before", items:[{id:"image-user", type:"userMessage", content:[
        {type:"text",text:"Previous request"}, {type:"image",url:png},
      ]}]},
      { id:"checkpoint", items:[{id:"compacted",type:"contextCompaction"}]},
      { id:"now", status:"inProgress", items:[{id:"new",type:"userMessage",content:[
        {type:"text",text:"Describe the last photo"}
      ]}]},
    ]).project("thread","now");
  const request={ input:[{type:"compaction",encrypted_content:"opaque"},{
    type:"message",role:"user",content:"Describe the last photo",
  }]};
  const p=projectNativeRequestContext("thread",request,history.content,history.inlineAssets,history.references);
  expect(p.revisions.map(r=>r.revision.kind)).toEqual(["assistant","user"]);
  expect(p.revisions[0]?.content).toContain("Previous request");
  expect(p.revisions[1]?.content).toBe("Describe the last photo");
  expect(p.media).toHaveLength(1);
  expect(p.media[0]?.evidence.origin).toBe("historical-user");
  const uploaded=prepareWebTurnMedia(physical(p),p.media);
  expect(uploaded.files).toHaveLength(1);
  expect(uploaded.manifest[0]?.revisionId).toBe(p.revisions[0]?.revision.id);
  expect(() => prepareWebTurnMedia(physical(p),[{...p.media[0]!,revisionId:p.revisions[1]!.revision.id}])).toThrow();
});

test("owner-authorized Native localImage is restored only for its same historical part and Web context",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tela-web-image-restore-")));
  try {
    const path=join(root,"image.png");
    writeFileSync(path,Buffer.from("89504e470d0a1a0a00000000","hex"));
    const history=await historicalSource([
        {id:"old",items:[{type:"userMessage",id:"img-1",content:[
          {type:"text",text:"Prior question"},{type:"localImage",path}]}]},
        {id:"summary",items:[{type:"contextCompaction",id:"checkpoint"}]},
        {id:"current",status:"inProgress",items:[{type:"userMessage",id:"current-user",content:[
          {type:"text",text:"Now refer back to the picture"}]}]},
      ]).project("thread","current");
    const original=history.references.find(ref=>ref.kind==="image");
    expect(original?.availability).toBe("unavailable");
    expect(history.content).not.toContain(path);
    const restored=await restoreNativeHistoricalImages(history,defineNativeTurnAuthority({
      threadId:"thread",turnId:"current",cwd:root,workspaceRoots:[root],
      sandbox:{kind:"read-only",network:"restricted"},
    }));
    if (constants.O_NOFOLLOW === undefined) {
      // The Native reader cannot safely reject symlink traversal here.
      // Preserve its fail-closed behavior instead of weakening media access.
      expect(restored.inlineAssets).toHaveLength(0);
      expect(restored.references.find(ref=>ref.kind==="image")?.availability).toBe("unavailable");
      expect(restored.content).not.toContain(path);
      return;
    }
    expect(restored.inlineAssets).toHaveLength(1);
    expect(restored.references.find(ref=>ref.kind==="image")?.id).toBe(original?.id);
    expect(restored.references.find(ref=>ref.kind==="image")?.availability).toBe("verified_inline_bytes");
    expect(restored.content).not.toContain(path);
    const native=projectNativeRequestContext("thread",{input:[
      {type:"compaction",encrypted_content:"opaque"},
      {type:"message",role:"user",content:"Now refer back to the picture"},
    ]},restored.content,restored.inlineAssets,restored.references);
    const media=prepareWebTurnMedia(physical(native),native.media);
    expect(media.statistics).toMatchObject({logicalReferences:1,uniqueFiles:1});
    expect(native.revisions[0]!.revision.kind).toBe("assistant");
    expect(native.revisions.at(-1)!.content).toBe("Now refer back to the picture");
  }finally{rmSync(root,{recursive:true,force:true});}
});
