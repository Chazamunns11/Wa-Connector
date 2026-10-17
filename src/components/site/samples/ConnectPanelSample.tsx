import { buttonClasses } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { brandConfig } from "@/lib/brand-config";
import { QR_WARNING } from "@/lib/site/setup-steps";

/**
 * The connect panel as the app draws it (WhatsappConnectionPanel): a built
 * mock, not a screenshot, so the strings stay crisp and follow the app. Nothing
 * inside is interactive. `connectedStrip` adds the state after the scan.
 */
/**
 * A dense, deterministic stand-in for a QR code: 29 modules with the three
 * finder squares, timing lines and an alignment square, the rest filled from a
 * fixed seed. Static SVG; it is not a valid code and cannot be scanned.
 */
function qrModules(): string {
  const N = 29;
  const grid: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N).fill(false));
  const reserved: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N).fill(false));
  const set = (x: number, y: number, on: boolean) => {
    grid[y][x] = on;
    reserved[y][x] = true;
  };
  const finder = (ox: number, oy: number) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const px = ox + x;
        const py = oy + y;
        if (px < 0 || py < 0 || px >= N || py >= N) continue;
        const ring = x >= 0 && x <= 6 && y >= 0 && y <= 6 && (x === 0 || x === 6 || y === 0 || y === 6);
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        set(px, py, ring || core);
      }
    }
  };
  finder(0, 0);
  finder(N - 7, 0);
  finder(0, N - 7);
  for (let i = 8; i < N - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      set(22 + x, 22 + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
    }
  }
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let d = "";
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const on = reserved[y][x] ? grid[y][x] : rand() < 0.5;
      if (on) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    }
  }
  return d;
}

const QR_PATH = qrModules();

function FakeQr() {
  return (
    <svg viewBox="0 0 33 33" width="168" height="168" shapeRendering="crispEdges" aria-hidden="true" className="mx-auto block rounded-[4px] border border-border bg-white">
      <path d={QR_PATH} fill="#1B1F2A" />
    </svg>
  );
}

const INSTRUCTION = "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.";

export function ConnectPanelSample({ connectedStrip = false }: { connectedStrip?: boolean }) {
  const { name } = brandConfig();
  const label = connectedStrip
    ? `The ${name} connect page in two states: Waiting for QR scan with a QR code, and Connected as +44 7700 900101.`
    : `The ${name} connect page: a WhatsApp panel with the status Waiting for QR scan, a QR code, the instruction to open WhatsApp, Settings, Linked devices, Link a device and scan it, a warning that whoever scans can send as your business, and a button to get a new QR code.`;

  return (
    <div role="img" aria-label={label} className="w-full max-w-md">
      <div aria-hidden="true" className="sample-chrome">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <p className="font-display text-xl font-medium">WhatsApp</p>
          <Chip tone="warn">Waiting for QR scan</Chip>
        </div>
        <div className="px-5 py-5">
          <FakeQr />
          <p className="mt-5 text-[15px] leading-snug text-ink">{INSTRUCTION}</p>
          <p className="mt-3 text-[15px] leading-snug text-loss">{QR_WARNING}</p>
          <span className={`${buttonClasses("secondary")} mt-5`}>Get a new QR code</span>
        </div>
        {connectedStrip ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-raised px-5 py-3 text-[15px]">
            <Chip tone="win">Connected</Chip>
            <span>
              as <span className="font-mono-nums">+44 7700 900101</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
