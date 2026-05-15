export function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const mag = Math.sqrt(s) || 1;
  return v.map((x) => x / mag);
}
