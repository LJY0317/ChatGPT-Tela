import {expect, test} from 'bun:test';
import {ControlledBrowserHost} from '@chatgpt-tela/browser-host';
import {ChatGptConnectorCatalogUnavailableError,ChatGptWebModelPickerControlUnavailableError,ChatGptWebLoginRequiredError} from '@chatgpt-tela/chatgpt';
import {createChatGptProfileControl, webPreparationFailureDetail} from './profile-control';

test('account-only observation needs no composer, submits nothing and releases its hidden page on failure',async()=>{
  let created=0,closed=0,observed=0;
  const host=new ControlledBrowserHost(async()=>{created++;return {async navigate(){},async reveal(){throw Error('no reveal');},async hide(){},async close(){closed++;}};});
  const control=createChatGptProfileControl({browserHost:host,provider:{async observeCapabilities(){throw Error('no composer probing');}},
    async accountIdentityObserver(){observed++;throw Error('signed out');}});
  expect(created).toBe(0);
  await expect(control.probeChatGptAccount()).rejects.toThrow('signed out');
  expect(created).toBe(1);expect(closed).toBe(1);expect(observed).toBe(1);
  const cancel=new AbortController();cancel.abort();await expect(control.probeChatGptAccount(cancel.signal)).rejects.toThrow();
  expect(created).toBe(1);await control.close();
});

function fixture(options: {failReadiness?: boolean; failCleanup?: boolean; retryCatalog?: boolean; missingConnector?: boolean; cancelAfterConnector?: boolean} = {}) {
  const controller = new AbortController();
  const order: string[] = [];
  let created = 0, closed = 0, attempts = 0;
  let connectorLease = '';
  const host = new ControlledBrowserHost(async () => {
    created++;
    return {async navigate() {}, async reveal() {throw Error('must stay hidden');}, async hide() {}, async close() {closed++;order.push('close');}};
  });
  const control = createChatGptProfileControl({browserHost:host, provider:{
    async probeConnector(surface) {
      connectorLease=surface.leaseId;order.push('connector');attempts++;
      if (options.retryCatalog && attempts===1) throw new ChatGptConnectorCatalogUnavailableError();
      if (options.missingConnector && attempts===1) throw Error('connector not available');
      if (options.failCleanup) throw Error('cleanup failed');
      order.push('cleanup-complete');
      if(options.cancelAfterConnector)controller.abort();
      return {connectorName:'fixture',connectorFingerprint:'fixture',routingMode:'explicit' as const};
    },
    async observeCapabilities(surface) {
      expect(surface.leaseId).toBe(connectorLease);order.push('readiness');
      if(options.failReadiness)return {state:'probable' as const,value:{observed:new Set<string>()},evidence:['unproven']};
      return {state:'proven' as const,value:{observed:new Set(['composer'])},evidence:['fixture']};
    },
  }});
  return {control,controller,order,get created(){return created;},get closed(){return closed;}};
}

test('connection proof checks readiness after connector cleanup on one hidden surface and releases it',async()=>{
  const f=fixture();const r=await f.control.probeChatGptConnection(f.controller.signal,()=>f.order.push('connector-proven'));
  expect(r.capabilities.observed.has('send')).toBe(false);
  expect(f.order).toEqual(['connector','cleanup-complete','connector-proven','readiness','close']);
  expect(f.created).toBe(1);expect(f.closed).toBe(1);await f.control.close();expect(f.closed).toBe(1);
});

test('an unavailable plugin is not silently repaired and an explicit later check can reuse the profile',async()=>{
  const f=fixture({missingConnector:true});
  await expect(f.control.probeChatGptConnection()).rejects.toThrow('connector not available');
  expect(f.order).toEqual(['connector','close']);
  expect(f.created).toBe(1);
  // Simulate the user restoring the plugin; the existing control must not cache its absence.
  const restored=await f.control.probeChatGptConnection();
  expect(restored.connector.connectorName).toBe('fixture');
  expect(f.created).toBe(2);expect(f.closed).toBe(2);
  await f.control.close();
});

test('unproven same-surface readiness rejects admission and closes its page',async()=>{
  const f=fixture({failReadiness:true});await expect(f.control.probeChatGptConnection()).rejects.toThrow('not proven');expect(f.created).toBe(1);expect(f.closed).toBe(1);
});

test('connector cleanup failure cannot be replaced by a new empty readiness page',async()=>{
  const f=fixture({failCleanup:true});await expect(f.control.probeChatGptConnection()).rejects.toThrow('cleanup failed');expect(f.order).toEqual(['connector','close']);expect(f.closed).toBe(1);
});

test('cancellation after connector proof closes the page without readiness or admission',async()=>{
  const f=fixture({cancelAfterConnector:true});await expect(f.control.probeChatGptConnection(f.controller.signal)).rejects.toThrow();expect(f.order).toEqual(['connector','cleanup-complete','close']);expect(f.closed).toBe(1);
});

test('catalog-unavailable retry owns a fresh page and still proves final cleanup/readiness',async()=>{
  const f=fixture({retryCatalog:true});await f.control.probeChatGptConnection();expect(f.created).toBe(2);expect(f.closed).toBe(2);expect(f.order).toEqual(['connector','close','connector','cleanup-complete','readiness','close']);
});

function preparationFixture(options: {
  mismatch?: boolean; empty?: boolean; retry?: boolean; retryPicker?: boolean; retryPickerAccountChanged?: boolean;
  failCleanup?: boolean; cancelDiscovery?: boolean;
} = {}) {
  let created = 0, closed = 0, accountCalls = 0, connectorCalls = 0, discoveries = 0;
  const leases = new Set<string>();
  const order: string[] = [];
  const controller = new AbortController();
  const host = new ControlledBrowserHost(async () => {
    created++;
    return { async navigate() {}, async reveal() { throw Error('must stay hidden'); }, async hide() {}, async close() { closed++; } };
  });
  const control = createChatGptProfileControl({
    browserHost: host,
    accountIdentityObserver: async surface => {
      leases.add(surface.leaseId); order.push('account'); accountCalls++;
      return { accountFingerprint: (options.mismatch && accountCalls > 1)
          || (options.retryPickerAccountChanged && created > 1) ? 'b'.repeat(64) : 'a'.repeat(64),
        accountStructure: 'personal', containerFingerprint: 'container' };
    },
    modelFamilyDiscovery: async surface => {
      leases.add(surface.leaseId); order.push('models'); discoveries++;
      if (options.cancelDiscovery) controller.abort();
      if ((options.retryPicker || options.retryPickerAccountChanged) && discoveries === 1) {
        throw new ChatGptWebModelPickerControlUnavailableError();
      }
      return options.empty ? [] : [{ key: 'a'.repeat(20), label: 'Fixture', availableEfforts: ['medium'] }];
    },
    provider: {
      async observeCapabilities(surface) {
        leases.add(surface.leaseId); order.push('readiness');
        return { state: 'proven', value: { observed: new Set(['composer', 'send']) }, evidence: ['fixture'] };
      },
      async probeConnector(surface) {
        leases.add(surface.leaseId); order.push('connector'); connectorCalls++;
        if (options.retry && connectorCalls === 1) throw new ChatGptConnectorCatalogUnavailableError();
        if (options.failCleanup) throw Error('cleanup failed');
        order.push('cleanup');
        return { connectorName: 'fixture', connectorFingerprint: 'fixture', routingMode: 'explicit' };
      },
    },
  });
  return { control, controller, leases, order, host, get created() { return created; }, get closed() { return closed; } };
}

test('whole Web preparation owns one hidden lease, validates before discovery and after cleanup, then releases', async () => {
  const f = preparationFixture();
  const result = await f.control.prepareChatGptWebSession({ signal: f.controller.signal,
    onProfile: () => f.order.push('binding'), onFamilies: () => f.order.push('families'),
    onConnectorStarting: () => f.order.push('pending'), onConnectorProven: () => f.order.push('proven') });
  expect(result.families).toHaveLength(1);
  expect(f.order).toEqual(['account','readiness','binding','models','families','pending','connector','cleanup','proven','readiness','account']);
  expect(f.leases.size).toBe(1); expect(f.created).toBe(1); expect(f.closed).toBe(1); expect(f.host.activeSurfaceCount).toBe(0);
});

test('binding rejection releases preparation without discovering models or touching connector', async () => {
  const f = preparationFixture();
  await expect(f.control.prepareChatGptWebSession({ onProfile() { throw Error('binding mismatch'); } })).rejects.toThrow('binding mismatch');
  expect(f.order).toEqual(['account','readiness']); expect(f.closed).toBe(1);
});

test('account change during preparation rejects result and releases page', async () => {
  const f = preparationFixture({ mismatch: true });
  await expect(f.control.prepareChatGptWebSession({ onProfile() {} })).rejects.toThrow('account changed');
  expect(f.closed).toBe(1); expect(f.host.activeSurfaceCount).toBe(0);
});

test('empty model discovery cannot begin connector proof', async () => {
  const f = preparationFixture({ empty: true });
  await expect(f.control.prepareChatGptWebSession({ onProfile() {} })).rejects.toThrow('discovery is incomplete');
  expect(f.order).toEqual(['account','readiness','models']); expect(f.closed).toBe(1);
});

test('preparation cancellation after discovery releases without connector actions', async () => {
  const f = preparationFixture({ cancelDiscovery: true });
  await expect(f.control.prepareChatGptWebSession({ signal: f.controller.signal, onProfile() {} })).rejects.toThrow();
  expect(f.order).toEqual(['account','readiness','models']); expect(f.closed).toBe(1);
});

test('preparation cleanup failure never admits Web or starts another readiness page', async () => {
  const f = preparationFixture({ failCleanup: true });
  await expect(f.control.prepareChatGptWebSession({ onProfile() {} })).rejects.toThrow('cleanup failed');
  expect(f.order).toEqual(['account','readiness','models','connector']); expect(f.created).toBe(1); expect(f.closed).toBe(1);
});

test('existing catalog retry repeats complete preparation in a new lease', async () => {
  const f = preparationFixture({ retry: true });
  await f.control.prepareChatGptWebSession({ onProfile() {} });
  expect(f.created).toBe(2); expect(f.closed).toBe(2); expect(f.leases.size).toBe(2);
  expect(f.order).toEqual(['account','readiness','models','connector','account','readiness','models','connector','cleanup','readiness','account']);
});

test('a missing model picker control retries exactly once after releasing its owned preparation surface', async () => {
  const f = preparationFixture({ retryPicker: true });
  const result = await f.control.prepareChatGptWebSession({ onProfile() {} });
  expect(result.families).toHaveLength(1);
  expect(f.created).toBe(2);
  expect(f.closed).toBe(2);
  expect(f.leases.size).toBe(2);
  expect(f.order).toEqual(['account','readiness','models','account','readiness','models',
    'connector','cleanup','readiness','account']);
});

test('the picker retry does not authorize a changed Web account', async () => {
  const f = preparationFixture({ retryPickerAccountChanged: true });
  await expect(f.control.prepareChatGptWebSession({ onProfile() {} }))
    .rejects.toThrow('account changed during Web preparation recovery');
  expect(f.created).toBe(2);
  expect(f.closed).toBe(2);
  expect(f.order).toEqual(['account','readiness','models','account','readiness']);
});


test('unknown catalog exception retains its original identity with bounded discovery provenance', async () => {
  const failure = new Error('fixture confidential detail');
  let closed = 0;
  const host = new ControlledBrowserHost(async () => ({
    async navigate() {}, async reveal() { throw Error('hidden'); },
    async hide() {}, async close() { closed++; },
  }));
  const control = createChatGptProfileControl({
    browserHost: host,
    accountIdentityObserver: async () => ({
      accountFingerprint: 'a'.repeat(64), containerFingerprint: 'container',
      accountStructure: 'personal',
    }),
    modelFamilyDiscovery: async () => { throw failure; },
    provider: {
      async observeCapabilities() {
        return { state: 'proven', value: { observed: new Set(['composer', 'send']) }, evidence: ['fixture'] };
      },
      async probeConnector() { throw Error('must not reach connector'); },
    },
  });
  await expect(control.prepareChatGptWebSession({ onProfile() {} })).rejects.toBe(failure);
  expect(webPreparationFailureDetail(failure)).toEqual({ stage: 'model-discovery', reasonClass: 'unknown' });
  expect(host.activeSurfaceCount).toBe(0);
  expect(closed).toBe(1);
});


test('signed-out preparation reports authentication before probing composer or models and releases its page',async()=>{
  let closed=0;
  const host=new ControlledBrowserHost(async()=>({async navigate(){},async reveal(){},async hide(){},async close(){closed++;}}));
  const control=createChatGptProfileControl({browserHost:host,
    async accountIdentityObserver(){throw new ChatGptWebLoginRequiredError();},
    async modelFamilyDiscovery(){throw Error('must not discover');},
    provider:{async observeCapabilities(){throw Error('must not probe composer');},async probeConnector(){throw Error('must not probe connector');}}});
  let failure:unknown;try{await control.prepareChatGptWebSession({onProfile(){throw Error('must not bind');}});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(ChatGptWebLoginRequiredError);
  expect(webPreparationFailureDetail(failure)).toEqual({stage:'account',reasonClass:'login_required'});
  expect(closed).toBe(1);expect(host.activeSurfaceCount).toBe(0);await control.close();
});
