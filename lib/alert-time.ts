/** Cached created_at → epoch ms (peer scans on the full-session tape parse the same timestamps millions of times). */
const cache = new WeakMap<object, number>();

export function alertMs(a: { created_at: string }): number {
  let v = cache.get(a);
  if (v === undefined) {
    v = Date.parse(a.created_at);
    cache.set(a, v);
  }
  return v;
}

type Nums = { askShare: number; premium: number; price: number };
const numCache = new WeakMap<object, Nums>();

/** Cached numeric fields for peer scans (UW sends strings). */
export function alertNums(
  a: { total_ask_side_prem: string | number; total_bid_side_prem: string | number; total_premium: string | number; price: string | number },
  askShareFn: (x: typeof a) => number,
  toNum: (v: string | number) => number,
): Nums {
  let v = numCache.get(a);
  if (!v) {
    v = { askShare: askShareFn(a), premium: toNum(a.total_premium), price: toNum(a.price) };
    numCache.set(a, v);
  }
  return v;
}
