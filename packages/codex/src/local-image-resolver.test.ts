import { expect, test } from "bun:test";
import { constants, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineNativeTurnAuthority, nativeEvidenceRef } from "@chatgpt-tela/core";
import { resolveNativeHistoricalImages } from "./local-image-resolver";

const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001","hex");
function candidate(path:string, index=1) {
  const owner = { threadId: "thread", currentTurnId: "active",
    sourceTurnId: "old", itemId: "user-old", partIndex: index, path };
  return { ...owner, evidenceId: nativeEvidenceRef({
    threadId: owner.threadId, itemKey: "old:user-old", partKey: String(index),
    kind: "image", origin: "historical-user", source: "native_thread_read",
  }).id };
}
function authority(root:string, kind:"read-only"|"native-enforced"="read-only") {
  return defineNativeTurnAuthority({
    threadId: "thread", turnId: "active", cwd: root, workspaceRoots:[root],
    sandbox: kind === "read-only"
      ? {kind:"read-only",network:"restricted"} : {kind:"native-enforced"},
  });
}

test("exact Native owner can restore workspace image through a bounded no-follow handle", async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tela-native-image-")));
  try {
    mkdirSync(join(root,"safe"));
    const path=join(root,"safe","photo.png");
    writeFileSync(path,png);
    const source=[candidate(path,1),candidate(path,2)];
    const result=await resolveNativeHistoricalImages({authority:authority(root),candidates:source});
    if (constants.O_NOFOLLOW === undefined) {
      // Windows has no supported no-follow descriptor contract for this path.
      // Fail closed instead of reading a private image via a weaker file API.
      expect(result.assets).toHaveLength(0);
      expect(result.unavailable.map(entry=>entry.reason)).toEqual(["native_authority_unavailable","native_authority_unavailable"]);
      return;
    }
    expect(result.assets).toHaveLength(2);
    expect(result.uniqueFiles).toBe(1);
    expect(result.uniqueBytes).toBe(png.length);
    expect(result.unavailable).toHaveLength(0);
    expect(result.assets[0]?.evidence.id).toBe(source[1]!.evidenceId);
    expect(result.assets[0]?.evidence.sha256).toBe(result.assets[1]?.evidence.sha256);
    expect(result.assets[0]?.evidence.availability).toBe("verified_inline_bytes");
    expect(result.assets[0]?.mimeType).toBe("image/png");
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("foreign, native-enforced, outside-root, missing and symlink paths cannot be read",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tela-native-media-deny-")));
  const external=realpathSync(mkdtempSync(join(tmpdir(),"tela-native-media-external-")));
  try {
    const safe=join(root,"safe.png");writeFileSync(safe,png);
    const privateFile=join(external,"private.png");writeFileSync(privateFile,png);
    const link=join(root,"linked.png");symlinkSync(privateFile,link);
    const missing=join(root,"missing.png");
    const candidates=[candidate(safe),candidate(privateFile,2),candidate(link,3),candidate(missing,4)];
    const native=await resolveNativeHistoricalImages({
      authority:authority(root,"native-enforced"),candidates,
    });
    expect(native.assets).toHaveLength(0);
    expect(native.unavailable.every(entry=>entry.reason==="native_authority_unavailable")).toBe(true);
    const restricted=await resolveNativeHistoricalImages({authority:authority(root),candidates});
    if (constants.O_NOFOLLOW === undefined) {
      expect(restricted.assets).toHaveLength(0);
      expect(restricted.unavailable.map(item=>item.reason).sort())
        .toEqual(["native_authority_unavailable","native_authority_unavailable","native_authority_unavailable","outside_workspace"]);
    } else {
      expect(restricted.assets).toHaveLength(1);
      expect(restricted.unavailable.map(item=>item.reason).sort())
        .toEqual(["missing_file","outside_workspace","unsafe_path"]);
    }
    const forged=await resolveNativeHistoricalImages({
      authority:authority(root),candidates:[{...candidate(safe),currentTurnId:"forged"}],
    });
    expect(forged.assets).toHaveLength(0);
    expect(forged.unavailable[0]?.reason).toBe("owner_mismatch");
  } finally {
    rmSync(root,{recursive:true,force:true});
    rmSync(external,{recursive:true,force:true});
  }
});

test("Native cancellation prevents any file read and leaves no retained file cache",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"tela-native-media-abort-")));
  try {
    const path=join(root,"picture.png");writeFileSync(path,png);
    const controller=new AbortController();controller.abort(new Error("native owner ended"));
    await expect(resolveNativeHistoricalImages({
      authority:authority(root),candidates:[candidate(path)],signal:controller.signal,
    })).rejects.toThrow("native owner ended");
  } finally {rmSync(root,{recursive:true,force:true});}
});
