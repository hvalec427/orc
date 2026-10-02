import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatorAllocator, type SimctlRunner } from '../src/simulators.js';

const DEVICE_TYPES = JSON.stringify({
  devicetypes: [
    { name: 'iPhone 14', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-14', productFamily: 'iPhone' },
    { name: 'iPhone 15 Pro Max', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro-Max', productFamily: 'iPhone' },
    { name: 'iPhone 15', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15', productFamily: 'iPhone' },
    { name: 'iPad Pro', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro', productFamily: 'iPad' },
  ],
});

const RUNTIMES = JSON.stringify({
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4', name: 'iOS 16.4', version: '16.4', isAvailable: true, platform: 'iOS' },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5', name: 'iOS 17.5', version: '17.5', isAvailable: true, platform: 'iOS' },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-10', name: 'watchOS 10', version: '10.0', isAvailable: true, platform: 'watchOS' },
  ],
});

/** A fake simctl runner that records calls and returns scripted stdout per subcommand. */
function fakeRunner(overrides: Partial<Record<string, string>> = {}): {
  runner: SimctlRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: SimctlRunner = async (args) => {
    calls.push(args);
    const sub = args[0];
    if (sub === 'list' && args[1] === 'devicetypes') return overrides.devicetypes ?? DEVICE_TYPES;
    if (sub === 'list' && args[1] === 'runtimes') return overrides.runtimes ?? RUNTIMES;
    if (sub === 'create') return overrides.create ?? 'UDID-NEW\n';
    return '';
  };
  return { runner, calls };
}

test('allocate() creates a device with the newest runtime + highest plain iPhone and returns its UDID', async () => {
  const { runner, calls } = fakeRunner();
  const alloc = new SimulatorAllocator(runner);

  const udid = await alloc.allocate('my-agent');
  assert.equal(udid, 'UDID-NEW');

  const create = calls.find((c) => c[0] === 'create');
  assert.ok(create, 'a create call was made');
  assert.equal(create![1], 'my-agent', 'device named after the agent');
  assert.equal(create![2], 'com.apple.CoreSimulator.SimDeviceType.iPhone-15', 'picks plain iPhone 15 over Pro Max/14');
  assert.equal(create![3], 'com.apple.CoreSimulator.SimRuntime.iOS-17-5', 'picks newest iOS runtime');
});

test('allocate() returns undefined (and does not create) when no iPhone device type exists', async () => {
  const { runner, calls } = fakeRunner({ devicetypes: JSON.stringify({ devicetypes: [{ name: 'iPad Pro', identifier: 'x', productFamily: 'iPad' }] }) });
  const alloc = new SimulatorAllocator(runner);

  assert.equal(await alloc.allocate('a'), undefined);
  assert.ok(!calls.some((c) => c[0] === 'create'), 'no device is created without a usable device type');
});

test('allocate() returns undefined when no iOS runtime is installed', async () => {
  const { runner } = fakeRunner({ runtimes: JSON.stringify({ runtimes: [] }) });
  const alloc = new SimulatorAllocator(runner);
  assert.equal(await alloc.allocate('a'), undefined);
});

test('allocate() soft-fails to undefined when the runner throws (no simctl on host)', async () => {
  const messages: string[] = [];
  const runner: SimctlRunner = async () => {
    throw new Error("unable to find utility 'simctl'");
  };
  const alloc = new SimulatorAllocator(runner, (m) => messages.push(m));

  assert.equal(await alloc.allocate('a'), undefined);
  assert.ok(messages.some((m) => /skipping/.test(m)), 'logs that it is skipping');
});

test('release() shuts down and deletes a simulator this allocator owns', async () => {
  const { runner, calls } = fakeRunner();
  const alloc = new SimulatorAllocator(runner);
  const udid = (await alloc.allocate('a'))!;

  await alloc.release(udid);
  assert.ok(calls.some((c) => c[0] === 'shutdown' && c[1] === udid), 'shuts down first');
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === udid), 'then deletes');
});

test('release() is a no-op for a UDID it does not own (never deletes a foreign device)', async () => {
  const { runner, calls } = fakeRunner();
  const alloc = new SimulatorAllocator(runner);

  await alloc.release('someone-elses-udid');
  assert.ok(!calls.some((c) => c[0] === 'delete'), 'does not delete a device it never created');
});

test('reserve() re-adopts a persisted UDID so a later release() tears it down', async () => {
  const { runner, calls } = fakeRunner();
  const alloc = new SimulatorAllocator(runner);

  alloc.reserve('restored-udid');
  await alloc.release('restored-udid');
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === 'restored-udid'), 'reserved device is deletable');
});

test('release() only deletes once (second release is a no-op)', async () => {
  const { runner, calls } = fakeRunner();
  const alloc = new SimulatorAllocator(runner);
  const udid = (await alloc.allocate('a'))!;

  await alloc.release(udid);
  await alloc.release(udid);
  const deletes = calls.filter((c) => c[0] === 'delete' && c[1] === udid);
  assert.equal(deletes.length, 1, 'the device is deleted exactly once');
});
