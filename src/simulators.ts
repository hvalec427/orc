import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Runs `xcrun simctl …` and returns its stdout. Injectable so tests can drive the allocator without
 * a real simulator toolchain (and so the whole module is a no-op on hosts that lack it). The default
 * shells out to the real `xcrun`.
 */
export type SimctlRunner = (args: string[]) => Promise<string>;

const defaultRunner: SimctlRunner = async (args) => {
  const { stdout } = await exec('xcrun', ['simctl', ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

/** One device type as reported by `simctl list devicetypes --json`. */
interface DeviceType {
  name: string;
  identifier: string;
  productFamily?: string;
}

/** One runtime as reported by `simctl list runtimes --json`. */
interface Runtime {
  identifier: string;
  name: string;
  version: string;
  isAvailable?: boolean;
  platform?: string;
}

/**
 * Compare two dotted version strings ("17.4" vs "17.4.1") numerically so the NEWEST runtime sorts
 * last. Missing components count as 0, so "17" < "17.1".
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pick the iPhone device type to create. Prefer the highest-numbered plain "iPhone N" (e.g. iPhone 15
 * over iPhone 14), falling back to any iPhone device type, so agents get a current, non-exotic phone.
 */
function pickDeviceType(deviceTypes: DeviceType[]): DeviceType | undefined {
  const iphones = deviceTypes.filter(
    (d) => d.productFamily === 'iPhone' || /iPhone/i.test(d.name),
  );
  if (iphones.length === 0) return undefined;
  // "iPhone 15" / "iPhone 15 Pro" — rank by the leading model number, preferring plain models.
  const scored = iphones.map((d) => {
    const m = d.name.match(/iPhone\s+(\d+)/i);
    const num = m ? Number(m[1]) : 0;
    const plain = /^iPhone\s+\d+$/i.test(d.name) ? 1 : 0; // prefer "iPhone 15" over "iPhone 15 Pro Max"
    return { d, num, plain };
  });
  scored.sort((x, y) => y.num - x.num || y.plain - x.plain || x.d.name.localeCompare(y.d.name));
  return scored[0].d;
}

/** Pick the newest installed, available iOS runtime. */
function pickRuntime(runtimes: Runtime[]): Runtime | undefined {
  const ios = runtimes.filter(
    (r) =>
      r.isAvailable !== false &&
      (r.platform === 'iOS' || /iOS/i.test(r.name) || r.identifier.includes('iOS')),
  );
  if (ios.length === 0) return undefined;
  ios.sort((a, b) => compareVersions(a.version, b.version));
  return ios[ios.length - 1];
}

/**
 * Creates and tears down a dedicated iOS Simulator per agent, so agents never share or reuse an
 * existing simulator. This is the simulator analogue of {@link PortAllocator}: {@link allocate} makes
 * a uniquely-named device and returns its UDID, {@link release} shuts it down and deletes it, and
 * {@link reserve} re-adopts a persisted UDID after an orc restart so cleanup still owns it.
 *
 * Everything is best-effort and guarded: if the host has no `xcrun`/`simctl`, or no iPhone device
 * type / iOS runtime is installed, or any command fails, allocate() resolves to `undefined` (logging
 * via the optional `onLog`) rather than throwing — so non-macOS hosts, CI, and non-RN projects are
 * unaffected and agent creation never blocks on the simulator toolchain.
 */
export class SimulatorAllocator {
  /** UDIDs this allocator created (or re-adopted via reserve), so release() only deletes its own. */
  private readonly owned = new Set<string>();

  constructor(
    private readonly runner: SimctlRunner = defaultRunner,
    private readonly onLog?: (message: string) => void,
  ) {}

  private log(message: string): void {
    this.onLog?.(message);
  }

  /**
   * Create a dedicated simulator named `name` and return its UDID, or `undefined` if the host can't
   * provision one (no toolchain / no device type / no runtime / any failure). The caller should treat
   * `undefined` as "no orc-provisioned simulator" and fall back gracefully.
   */
  async allocate(name: string): Promise<string | undefined> {
    let deviceTypes: DeviceType[];
    let runtimes: Runtime[];
    try {
      [deviceTypes, runtimes] = await Promise.all([this.listDeviceTypes(), this.listRuntimes()]);
    } catch (err) {
      this.log(`simulator: cannot list device types/runtimes (${(err as Error).message}); skipping`);
      return undefined;
    }

    const device = pickDeviceType(deviceTypes);
    const runtime = pickRuntime(runtimes);
    if (!device || !runtime) {
      this.log(
        `simulator: no ${!device ? 'iPhone device type' : 'installed iOS runtime'} available; skipping`,
      );
      return undefined;
    }

    try {
      const out = await this.runner(['create', name, device.identifier, runtime.identifier]);
      const udid = out.trim().split('\n').pop()?.trim();
      if (!udid) {
        this.log('simulator: simctl create returned no UDID; skipping');
        return undefined;
      }
      this.owned.add(udid);
      this.log(`simulator: created "${name}" (${device.name}, ${runtime.name}) → ${udid}`);
      return udid;
    } catch (err) {
      this.log(`simulator: create failed for "${name}" (${(err as Error).message}); skipping`);
      return undefined;
    }
  }

  /** Boot the simulator and wait until it is ready. Best-effort: logs and continues on failure. */
  async boot(udid: string): Promise<void> {
    try {
      await this.runner(['bootstatus', udid, '-b']);
    } catch (err) {
      this.log(`simulator: boot failed for ${udid} (${(err as Error).message})`);
    }
  }

  /**
   * Shut down and delete a simulator this allocator owns. No-op for a UDID it did not create (so it
   * never deletes a human's or another agent's device). Best-effort: a failure is logged, not thrown.
   */
  async release(udid: string): Promise<void> {
    if (!this.owned.has(udid)) return;
    this.owned.delete(udid);
    try {
      // Shutdown first so delete doesn't race a booted device; ignore "already shut down".
      await this.runner(['shutdown', udid]).catch(() => undefined);
      await this.runner(['delete', udid]);
      this.log(`simulator: deleted ${udid}`);
    } catch (err) {
      this.log(`simulator: delete failed for ${udid} (${(err as Error).message})`);
    }
  }

  /**
   * Re-adopt a UDID persisted from a previous orc run so {@link release} will later tear it down.
   * Called from restore() for each agent that had an orc-provisioned simulator, mirroring
   * {@link PortAllocator.reserve}.
   */
  reserve(udid: string): void {
    this.owned.add(udid);
  }

  private async listDeviceTypes(): Promise<DeviceType[]> {
    const out = await this.runner(['list', 'devicetypes', '--json']);
    const parsed = JSON.parse(out) as { devicetypes?: DeviceType[] };
    return parsed.devicetypes ?? [];
  }

  private async listRuntimes(): Promise<Runtime[]> {
    const out = await this.runner(['list', 'runtimes', '--json']);
    const parsed = JSON.parse(out) as { runtimes?: Runtime[] };
    return parsed.runtimes ?? [];
  }
}
