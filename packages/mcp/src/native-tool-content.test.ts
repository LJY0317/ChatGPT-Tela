import { expect, test } from "bun:test";
import { nativeToolResultToMcpContent } from "./native-tool-content";

const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001","hex");

test("tool image content remains a genuine MCP image, not JSON-escaped text",()=>{
  const input=[{type:"text",text:"One snapshot"},{
    type:"image",mimeType:"image/png",data:png.toString("base64"),
  }] as const;
  const projected=nativeToolResultToMcpContent(input);
  expect(projected.content).toEqual(input);
  expect(projected.referencedImages).toBe(1);
  expect(projected.distinctImages).toBe(1);
  expect(projected.uniqueImageBytes).toBe(png.length);
});

test("one physical tool image can be referenced repeatedly",()=>{
  const data="data:image/png;base64,"+png.toString("base64");
  const source=Array.from({length:12},()=>({type:"inputImage",imageUrl:data}));
  const projected=nativeToolResultToMcpContent(source);
  expect(projected.referencedImages).toBe(12);
  expect(projected.distinctImages).toBe(1);
  expect(projected.uniqueImageBytes).toBe(png.length);
  expect(projected.content.filter(part=>part.type==="image")).toHaveLength(1);
  expect(projected.content.filter(part=>part.type==="text")).toHaveLength(11);
});

test("external tool resource URLs are never fetched or echoed",()=>{
  const confidential="https://secret.test/document?auth=private";
  const projected=nativeToolResultToMcpContent([{
    type:"resource_link",uri:confidential,mimeType:"application/pdf",name:"Document",
  },{type:"resource",resource:{uri:confidential,text:"Public excerpt"}}]);
  expect(projected.content[0]?.type).toBe("text");
  expect(JSON.stringify(projected)).not.toContain(confidential);
  expect(JSON.stringify(projected)).not.toContain("private");
  expect(projected.content[1]).toMatchObject({
    type:"resource",resource:{mimeType:"text/plain",text:"Public excerpt"},
  });
  expect(JSON.stringify(projected.content[1])).not.toContain(confidential);
});

test("MCP EmbeddedResource PDF stays a binary result with Tela-owned non-sensitive URI", () => {
  const pdf = Buffer.from("%PDF-1.5\nA safe test fixture");
  const secret = "file:///private/attachments/item.pdf?token=redacted";
  const tool = nativeToolResultToMcpContent([
    {type:"resource",resource:{uri:secret,mimeType:"application/pdf",blob:pdf.toString("base64")}},
    {type:"resource",resource:{uri:secret,mimeType:"application/pdf",blob:pdf.toString("base64")}},
  ]);
  expect(tool.content[0]).toMatchObject({
    type:"resource",resource:{mimeType:"application/pdf",blob:pdf.toString("base64")},
  });
  const first=tool.content[0]!;
  expect(first.type).toBe("resource");
  if(first.type!=="resource")throw Error("Expected an embedded resource");
  expect(first.resource.uri).toMatch(/^tela-native-asset:\/\/sha256\/[a-f0-9]{64}$/);
  expect(tool.content[1]?.type).toBe("text");
  expect(JSON.stringify(tool)).not.toContain(secret);
  expect(JSON.stringify(tool)).not.toContain("token=redacted");
  expect(tool.distinctImages).toBe(0);
  expect(tool.uniqueImageBytes).toBe(0);
});

test("Native tool file bytes reach MCP as an embedded resource while opaque audio and future parts cannot leak",()=>{
  const bytes=Buffer.from("%PDF-1.4\nTest");
  const privateUrl="https://somewhere.test/path?credential=never-visible";
  const raw=bytes.toString("base64");
  const result=nativeToolResultToMcpContent([
    {type:"input_file",file_data:`data:application/pdf;base64,${raw}`,url:privateUrl},
    {type:"input_file",file_data:`data:application/pdf;base64,${raw}`,url:privateUrl},
    {type:"audio",mimeType:"audio/wav",data:"YXVkaW8tcHJpdmF0ZQ=="},
    {type:"futureBlob",uri:privateUrl,blob:"unowned-bytes"},
    {type:"input_text",text:"Safe commentary"},
  ]);
  expect(result.content.map(v=>v.type)).toEqual(["resource","text","text","text","text"]);
  const embedded=result.content[0] as any;
  expect(embedded.resource.blob).toBe(raw);
  expect(embedded.resource.uri).toMatch(/^tela-native-asset:\/\/sha256\/[a-f0-9]{64}$/);
  expect(result.distinctImages).toBe(0);
  expect(result.uniqueImageBytes).toBe(0);
  expect(JSON.stringify(result)).not.toContain(privateUrl);
  expect(JSON.stringify(result)).not.toContain("unowned-bytes");
  expect(JSON.stringify(result)).not.toContain("YXVkaW8tcHJpdmF0ZQ");
  expect(result.content.at(-1)).toEqual({type:"text",text:"Safe commentary"});
});

test("encrypted MCP tool output is explicitly unavailable and never serialized as model text",()=>{
  const confidential="encoded-native-confidential-data";
  const result=nativeToolResultToMcpContent([
    {type:"encrypted_content",encrypted_content:confidential},
    {type:"text",text:confidential,_meta:{"codex/encryptedContent":true}},
    {type:"text",text:"Visible result"},
  ]);
  expect(result.content.map(row=>row.type)).toEqual(["text","text","text"]);
  expect(JSON.stringify(result)).not.toContain(confidential);
  expect(JSON.stringify(result)).toContain("Visible result");
});

test("Native-normalized MCP resource text is reconstructed for MCP result delivery without source URI",()=>{
  const pdf=Buffer.from("%PDF-1.7\nExample document");
  const src="file:///private/session/blob.pdf?token=private";
  const text=JSON.stringify({resource:{
    mimeType:"application/pdf",uri:src,blob:pdf.toString("base64"),
  },type:"resource"});
  const link=JSON.stringify({type:"resource_link",uri:"https://host.invalid/?secret=hidden"});
  const result=nativeToolResultToMcpContent([
    {type:"input_text",text},
    {type:"input_text",text},
    {type:"input_text",text:link},
  ]);
  expect(result.content[0]).toMatchObject({
    type:"resource",resource:{mimeType:"application/pdf",blob:pdf.toString("base64")},
  });
  expect(result.content[1]?.type).toBe("text");
  expect(result.content[2]?.type).toBe("text");
  expect(JSON.stringify(result)).not.toContain(src);
  expect(JSON.stringify(result)).not.toContain("secret=hidden");
  expect(result.distinctImages).toBe(0);
  expect(result.uniqueImageBytes).toBe(0);
});

test("oversized, unsupported and unknown media cannot masquerade as a valid MCP image",()=>{
  expect(()=>nativeToolResultToMcpContent([{
    type:"image",data:"AA==",mimeType:"image/png",
  }])).toThrow("declared media type");
  expect(()=>nativeToolResultToMcpContent([{
    type:"image",data:"PHN2Zy8+",mimeType:"image/svg+xml",
  }])).toThrow("MIME is unsupported");
  expect(()=>nativeToolResultToMcpContent(Array.from({length:129},()=>({type:"text",text:"x"}))))
    .toThrow("too many content parts");
});
