/** Shorten a long brand name so it fits inside a diagram box. */
export function clip(text: string, max = 16): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface FlowNode {
  title: string;
  sub?: string;
  accent?: boolean;
}

function Box({
  x,
  y,
  w,
  h,
  accent = false,
  rx = 8,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  accent?: boolean;
  rx?: number;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={rx}
      className={accent ? "fill-accent-soft stroke-accent-text" : "fill-card stroke-ink-faint"}
      strokeWidth={accent ? 2 : 1.5}
    />
  );
}

/** A rounded box with a bold title and an optional smaller line under it. */
export function Node({ x, y, w, h, title, sub, accent }: FlowNode & { x: number; y: number; w: number; h: number }) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return (
    <g>
      <Box x={x} y={y} w={w} h={h} accent={accent} />
      <text x={cx} y={sub ? cy - 4 : cy + 5} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-ink">
        {title}
      </text>
      {sub ? (
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize={12} className="fill-ink-dim">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

export function Plain({
  x,
  y,
  w,
  h,
  accent,
  rx,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  accent?: boolean;
  rx?: number;
}) {
  return <Box x={x} y={y} w={w} h={h} accent={accent} rx={rx} />;
}

/** Arrow with a filled head. dir "right" runs left to right, "down" runs top to bottom. */
export function Arrow({ x, y, len, dir, dashed = false }: { x: number; y: number; len: number; dir: "right" | "down"; dashed?: boolean }) {
  const line = dir === "right" ? `M${x} ${y}h${len - 6}` : `M${x} ${y}v${len - 6}`;
  const head =
    dir === "right"
      ? `${x + len},${y} ${x + len - 8},${y - 5} ${x + len - 8},${y + 5}`
      : `${x},${y + len} ${x - 5},${y + len - 8} ${x + 5},${y + len - 8}`;
  return (
    <g>
      <path d={line} className="stroke-ink-faint" fill="none" strokeWidth={1.5} strokeDasharray={dashed ? "4 4" : undefined} />
      <polygon points={head} className="fill-ink-faint" />
    </g>
  );
}

const H_GAP = 50;
const V_NODE_H = 64;
const V_GAP = 30;

/** Left-to-right chain of boxes for a 560 wide drawing. Pair with `hFlowHeight`. */
export function HFlow({ nodes }: { nodes: FlowNode[] }) {
  const n = nodes.length;
  const w = (560 - H_GAP * (n - 1)) / n;
  return (
    <>
      {nodes.map((node, i) => (
        <Node key={node.title} x={i * (w + H_GAP)} y={15} w={w} h={80} {...node} />
      ))}
      {nodes.slice(1).map((node, i) => (
        <Arrow key={node.title} x={i * (w + H_GAP) + w} y={55} len={H_GAP} dir="right" />
      ))}
    </>
  );
}
export const H_FLOW_HEIGHT = 110;

/** Top-to-bottom chain for a 300 wide drawing (phones). */
export function VFlow({ nodes }: { nodes: FlowNode[] }) {
  return (
    <>
      {nodes.map((node, i) => (
        <Node key={node.title} x={20} y={i * (V_NODE_H + V_GAP)} w={260} h={V_NODE_H} {...node} />
      ))}
      {nodes.slice(1).map((node, i) => (
        <Arrow key={node.title} x={150} y={i * (V_NODE_H + V_GAP) + V_NODE_H} len={V_GAP} dir="down" />
      ))}
    </>
  );
}
export const vFlowHeight = (n: number) => n * V_NODE_H + (n - 1) * V_GAP;

/** A QR placeholder: three finder squares and a few dots. Not a real code. */
export function QrMark({ x, y, size }: { x: number; y: number; size: number }) {
  const f = size * 0.3;
  const inner = f * 0.4;
  const finder = (fx: number, fy: number) => (
    <g key={`${fx}-${fy}`}>
      <rect x={fx} y={fy} width={f} height={f} className="fill-none stroke-ink" strokeWidth={2} />
      <rect x={fx + (f - inner) / 2} y={fy + (f - inner) / 2} width={inner} height={inner} className="fill-ink" />
    </g>
  );
  const d = size * 0.1;
  return (
    <g aria-hidden="true">
      <rect x={x} y={y} width={size} height={size} rx={4} className="fill-white stroke-ink-faint" strokeWidth={1.5} />
      {finder(x + 10, y + 10)}
      {finder(x + size - f - 10, y + 10)}
      {finder(x + 10, y + size - f - 10)}
      <rect x={x + size * 0.55} y={y + size * 0.58} width={d} height={d} className="fill-ink" />
      <rect x={x + size * 0.72} y={y + size * 0.55} width={d} height={d} className="fill-ink" />
      <rect x={x + size * 0.62} y={y + size * 0.74} width={d} height={d} className="fill-ink" />
      <rect x={x + size * 0.8} y={y + size * 0.78} width={d} height={d} className="fill-ink" />
    </g>
  );
}

/** Wrapper classes shared by both orientations of every diagram. */
export const WIDE = "mx-auto overflow-visible hidden h-auto w-full max-w-[600px] sm:block";
export const NARROW = "mx-auto overflow-visible block h-auto w-full max-w-[320px] sm:hidden";
