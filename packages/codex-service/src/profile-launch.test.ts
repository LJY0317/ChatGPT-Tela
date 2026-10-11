import {expect,test} from "bun:test";
import {profileLaunch,verifyProfileRuntimeProcess} from "./profile-launch";
test("macOS launches the exact verified bundle and separates OS waiter from application",()=>{
 const launch=profileLaunch(["/synthetic/Runtime With Spaces.app/Contents/MacOS/Electron","/synthetic/runtime.cjs"],"darwin");
 expect(launch.kind).toBe("macos-application");
 expect(launch.command).toEqual(["/usr/bin/open","-W","-n","-a","/synthetic/Runtime With Spaces.app","--args","/synthetic/runtime.cjs"]);
 expect(launch.command.join(" ")).not.toContain("--env");
});
test("CLI fixtures and other operating systems keep direct process semantics",()=>{
 const cmd=["/synthetic/Runtime.app/Contents/MacOS/Electron","/synthetic/runtime.cjs"] as const;
 expect(profileLaunch(cmd,"linux").command).toEqual(cmd);expect(profileLaunch(cmd,"win32").kind).toBe("direct");
 expect(profileLaunch(["/synthetic/bun","fixture.ts"],"darwin").kind).toBe("direct");
 expect(()=>profileLaunch(["bad\0command"],"darwin")).toThrow("invalid");
});

test("direct runtime readiness is bound to its exact spawned PID",async()=>{
 const launch=profileLaunch(["/synthetic/bun","fixture.ts"],"darwin");
 await verifyProfileRuntimeProcess(launch,123,123);
 await expect(verifyProfileRuntimeProcess(launch,123,124)).rejects.toThrow("different child");
});
