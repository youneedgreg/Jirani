export interface Stat {
  n: number;
  mean: number;
  median: number;
  /** Median absolute deviation, scaled to be comparable to a standard deviation. */
  robustSd: number;
  p10: number;
  p90: number;
  p95: number;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function stat(values: number[]): Stat {
  const s = [...values].sort((a, b) => a - b);
  const median = quantile(s, 0.5);
  const mad = quantile(
    s.map((v) => Math.abs(v - median)).sort((a, b) => a - b),
    0.5,
  );
  return {
    n: s.length,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN,
    median,
    robustSd: 1.4826 * mad,
    p10: quantile(s, 0.1),
    p90: quantile(s, 0.9),
    p95: quantile(s, 0.95),
  };
}

export function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}
