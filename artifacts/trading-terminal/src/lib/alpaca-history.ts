import { useQuery } from '@tanstack/react-query';

export type HistoryRange = '1D' | '1W' | '1M' | '3M' | '1Y';

export const HISTORY_RANGES: HistoryRange[] = ['1D', '1W', '1M', '3M', '1Y'];

const TIMEFRAME: Record<HistoryRange, string> = {
  '1D': '5Min',
  '1W': '15Min',
  '1M': '1D',
  '3M': '1D',
  '1Y': '1D',
};

export interface AlpacaHistoryPoint {
  t: string;
  equity: number;
}

export interface AlpacaHistory {
  period: string;
  timeframe: string;
  baseValue: number;
  change: number;
  changePct: number;
  points: AlpacaHistoryPoint[];
}

/**
 * Real equity curve from the connected Alpaca account
 * (`/v2/account/portfolio/history` on Alpaca, proxied by our API).
 */
export function useAlpacaHistory(range: HistoryRange) {
  return useQuery({
    queryKey: ['alpaca', 'portfolio-history', range],
    queryFn: async (): Promise<AlpacaHistory> => {
      const res = await fetch(
        `/api/alpaca/portfolio-history?period=${range}&timeframe=${TIMEFRAME[range]}`,
        { credentials: 'same-origin' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<AlpacaHistory>;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}
