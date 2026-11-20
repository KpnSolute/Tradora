import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Currency formatter. `fractionDigits` is the maximum number of decimals to show
 * (2 by default, more for sub-dollar coins), with at least two so a live quote
 * visibly ticks in cents. It used to interpret that argument as *significant*
 * digits, which rendered a $62,418.30 BTC quote as "$62,418" — frozen to the eye
 * even while the feed was updating every few seconds.
 */
export function formatPrice(price: number, fractionDigits = 2) {
  const max = Math.min(Math.max(Math.trunc(fractionDigits), 0), 8);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(max, 2),
    maximumFractionDigits: max,
  }).format(price);
}

export function formatPct(pct: number) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(pct / 100);
}

export function formatNumber(num: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(num);
}

/**
 * Compact price formatter — never overflows a tight box.
 * ≥1B  → $1.23B
 * ≥1M  → $1.23M
 * ≥1K  → $108.4K
 * ≥1   → $4.52
 * <1   → $0.1823  (4 sig figs)
 */
export function formatCompactPrice(price: number): string {
  const abs = Math.abs(price);
  const sign = price < 0 ? '-' : '';

  if (abs >= 1_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  }
  if (abs >= 1) {
    return `${sign}${new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(abs)}`;
  }
  // Sub-dollar coins: 4 significant digits
  return `${sign}${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 4,
  }).format(abs)}`;
}
