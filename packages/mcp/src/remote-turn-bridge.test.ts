import { expect, test } from 'bun:test';
import { startCodexBridgeMcpHttpServer } from './http-server';
import { connectCodexTurnBridge } from './remote-turn-bridge';

test('remote bridge remains usable after idle session reclamation and never replays calls', async () => {
  let calls = 0;
  const server = await startCodexBridgeMcpHttpServer({
    sessionIdleTimeoutMs: 20,
    bridge: {
      inventory() { return [{wireName:'fixture_read', name:'fixture_read', kind:'function' as const,
        description:'Read fixture', inputSchema:{type:'object'}, observedFrom:['fixture']}]; },
      async invoke(_capability, invocation) {
        calls++;
        if(invocation.callId==="reject-call") throw new Error("Controlled fixture failure");
        return {callId:invocation.callId, content:'fixture result', isError:false};
      },
    },
  });
  const bridge = await connectCodexTurnBridge({endpoint:server.endpointUrl, bearerToken:server.bearerToken!});
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(server.activeSessionCount).toBe(0);
    expect((await bridge.inventory('turnr_Fixture1_opaque_capability')).length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    const result = await bridge.invoke('turnr_Fixture1_opaque_capability', {
      callId:'fixture-call', wireName:'fixture_read', mode:'structured', arguments:{},
    });
    expect(result.content).toBe('fixture result');
    expect(calls).toBe(1);
    expect(server.activeSessionCount).toBe(0);
    const rejected = await bridge.invoke('turnr_Fixture1_opaque_capability', {
      callId:'reject-call', wireName:'fixture_read', mode:'structured', arguments:{},
    });
    expect(rejected.isError).toBe(true);
    expect(calls).toBe(2);
    expect(server.activeSessionCount).toBe(0);
    await bridge.close();
    await expect(bridge.inventory('turnr_Fixture1_opaque_capability')).rejects.toThrow('closed');
  } finally { await bridge.close(); await server.stop(); }
});
