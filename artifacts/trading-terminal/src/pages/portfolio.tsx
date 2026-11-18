import React, { useState } from 'react';
import { 
  useGetPortfolioSummary,
  useListPositions,
  useGetUnifiedPortfolio,
  getGetPortfolioSummaryQueryKey,
  getListPositionsQueryKey,
  getGetUnifiedPortfolioQueryKey,
} from '@workspace/api-client-react';
import { Activity, DollarSign, Percent, TrendingUp, TrendingDown, Target, Skull, Layers, ChevronDown, ChevronUp } from 'lucide-react';
import { cn, formatPrice, formatPct } from '@/lib/utils';
import { Link } from 'wouter';

const EXCHANGE_COLORS: Record<string, string> = {
  coinbase: 'text-blue-400 border-blue-400/40 bg-blue-400/10',
  binance:  'text-yellow-400 border-yellow-400/40 bg-yellow-400/10',
  kraken:   'text-purple-400 border-purple-400/40 bg-purple-400/10',
  bybit:    'text-orange-400 border-orange-400/40 bg-orange-400/10',
  alpaca:   'text-green-400 border-green-400/40 bg-green-400/10',
  paper:    'text-muted-foreground border-border bg-muted/30',
};

function ExchangeBadge({ exchange }: { exchange: string }) {
  const cls = EXCHANGE_COLORS[exchange.toLowerCase()] ?? 'text-foreground border-border bg-muted/20';
  return (
    <span className={cn('text-[10px] font-bold px-1.5 py-0.5 border tracking-wider uppercase', cls)}>
      {exchange}
    </span>
  );
}

export default function Portfolio() {
  const { data: summary } = useGetPortfolioSummary({ query: { queryKey: getGetPortfolioSummaryQueryKey(), refetchInterval: 10000 } });
  const { data: positions } = useListPositions({ query: { queryKey: getListPositionsQueryKey(), refetchInterval: 5000 } });
  const { data: unified, isLoading: unifiedLoading } = useGetUnifiedPortfolio({ query: { queryKey: getGetUnifiedPortfolioQueryKey(), refetchInterval: 15000 } });

  const [showUnified, setShowUnified] = useState(true);

  const hasBrokers = (unified?.brokers?.length ?? 0) > 0;
  const totalEquity = unified?.totalEquity ?? 0;

  return (
    <div className="flex flex-col gap-6 font-mono">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-lg font-bold tracking-widest flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          PORTFOLIO OVERVIEW
        </h1>
        <div className="text-xs text-muted-foreground border border-border px-3 py-1 bg-card">
          MODE: {summary?.mode.toUpperCase() || '---'}
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 border border-border bg-card">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2"><DollarSign className="w-3 h-3"/> NET LIQUIDITY</div>
          <div className="text-2xl font-bold">{summary ? formatPrice(summary.totalValue) : '---'}</div>
        </div>
        <div className="p-4 border border-border bg-card">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2"><Activity className="w-3 h-3"/> TOTAL PNL</div>
          <div className={cn(
            "text-2xl font-bold",
            summary?.totalPnl && summary.totalPnl >= 0 ? "text-up" : summary?.totalPnl && summary.totalPnl < 0 ? "text-down" : "text-foreground"
          )}>
            {summary ? (summary.totalPnl >= 0 ? '+' : '') + formatPrice(summary.totalPnl) : '---'}
          </div>
        </div>
        <div className="p-4 border border-border bg-card">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2"><Percent className="w-3 h-3"/> RETURN</div>
          <div className={cn(
            "text-2xl font-bold",
            summary?.totalPnlPct && summary.totalPnlPct >= 0 ? "text-up" : summary?.totalPnlPct && summary.totalPnlPct < 0 ? "text-down" : "text-foreground"
          )}>
            {summary ? (summary.totalPnlPct >= 0 ? '+' : '') + formatPct(summary.totalPnlPct) : '---'}
          </div>
        </div>
        <div className="p-4 border border-border bg-card">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2"><Target className="w-3 h-3"/> WIN RATE</div>
          <div className="text-2xl font-bold text-primary">{summary ? formatPct(summary.winRate) : '---'}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 border border-border bg-card flex items-center gap-4">
          <div className="w-12 h-12 bg-up/10 flex items-center justify-center text-up shrink-0">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">BEST TRADE</div>
            <div className="font-bold tracking-widest">{summary?.bestTrade || '---'}</div>
          </div>
        </div>
        <div className="p-4 border border-border bg-card flex items-center gap-4">
          <div className="w-12 h-12 bg-down/10 flex items-center justify-center text-down shrink-0">
            <Skull className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">WORST TRADE</div>
            <div className="font-bold tracking-widest">{summary?.worstTrade || '---'}</div>
          </div>
        </div>
      </div>

      {/* ── Unified Broker View ────────────────────────────────────────────── */}
      <div className="border border-border bg-card">
        <button
          onClick={() => setShowUnified(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors"
        >
          <span className="text-sm font-bold tracking-widest flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            MULTI-BROKER DASHBOARD
            {hasBrokers && (
              <span className="text-xs text-muted-foreground font-normal">
                ({unified!.brokers.length} broker{unified!.brokers.length !== 1 ? 's' : ''})
              </span>
            )}
          </span>
          {showUnified ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>

        {showUnified && (
          <div className="border-t border-border">
            {unifiedLoading && !unified ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground tracking-widest">LOADING BROKER DATA…</div>
            ) : !hasBrokers ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground tracking-widest">
                NO CONNECTED BROKERS — ADD ONE IN SETTINGS
              </div>
            ) : (
              <>
                {/* Combined equity + P&L header */}
                <div className="grid grid-cols-2 border-b border-border">
                  <div className="px-4 py-3 border-r border-border">
                    <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1.5"><DollarSign className="w-3 h-3"/>COMBINED EQUITY</div>
                    <div className="text-xl font-bold">{formatPrice(totalEquity)}</div>
                  </div>
                  <div className="px-4 py-3">
                    <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1.5"><Activity className="w-3 h-3"/>UNREALIZED P&L</div>
                    <div className={cn(
                      "text-xl font-bold",
                      (unified?.totalUnrealizedPl ?? 0) >= 0 ? "text-up" : "text-down"
                    )}>
                      {(unified?.totalUnrealizedPl ?? 0) >= 0 ? '+' : ''}{formatPrice(unified?.totalUnrealizedPl ?? 0)}
                    </div>
                  </div>
                </div>

                {/* Allocation by broker */}
                <div className="px-4 py-3 border-b border-border">
                  <div className="text-xs text-muted-foreground mb-3 tracking-widest">ALLOCATION BY BROKER</div>
                  <div className="flex flex-col gap-2">
                    {unified!.brokers.map(broker => {
                      const alloc = totalEquity > 0 ? (broker.equity / totalEquity) * 100 : 0;
                      const isUp = broker.unrealizedPl >= 0;
                      return (
                        <div key={`${broker.exchange}-${broker.label}`} className="flex items-center gap-3">
                          <ExchangeBadge exchange={broker.exchange} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="text-muted-foreground truncate">{broker.label}</span>
                              <span className="font-medium shrink-0 ml-2">{formatPrice(broker.equity)}</span>
                            </div>
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary/70 rounded-full transition-all"
                                style={{ width: `${Math.min(100, alloc)}%` }}
                              />
                            </div>
                          </div>
                          <div className={cn(
                            "text-xs font-medium shrink-0 w-20 text-right",
                            isUp ? "text-up" : "text-down"
                          )}>
                            {isUp ? '+' : ''}{formatPrice(broker.unrealizedPl)}
                          </div>
                          <div className="text-xs text-muted-foreground shrink-0 w-10 text-right">
                            {alloc.toFixed(1)}%
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* All positions across brokers */}
                <div>
                  <div className="px-4 py-2 text-xs text-muted-foreground tracking-widest border-b border-border">
                    ALL POSITIONS ({unified!.positions.length})
                  </div>
                  {unified!.positions.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-muted-foreground">NO OPEN POSITIONS ACROSS BROKERS</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="text-xs text-muted-foreground bg-muted/50 border-b border-border">
                          <tr>
                            <th className="px-4 py-2 font-medium">BROKER</th>
                            <th className="px-4 py-2 font-medium">SYMBOL</th>
                            <th className="px-4 py-2 font-medium text-right">SIZE</th>
                            <th className="px-4 py-2 font-medium text-right">ENTRY</th>
                            <th className="px-4 py-2 font-medium text-right">MARKET</th>
                            <th className="px-4 py-2 font-medium text-right">UNREALIZED PNL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unified!.positions.map((pos, i) => {
                            const isUp = pos.unrealizedPl >= 0;
                            return (
                              <tr key={`${pos.exchange}-${pos.symbol}-${i}`} className="border-b border-border hover:bg-card/50 transition-colors">
                                <td className="px-4 py-3">
                                  <ExchangeBadge exchange={pos.exchange} />
                                </td>
                                <td className="px-4 py-3 font-bold text-foreground">
                                  <Link href={`/market/${pos.symbol}`} className="hover:text-primary transition-colors">
                                    {pos.symbol}
                                  </Link>
                                </td>
                                <td className="px-4 py-3 text-right">{pos.qty}</td>
                                <td className="px-4 py-3 text-right text-muted-foreground">{formatPrice(pos.avgEntryPrice, 4)}</td>
                                <td className="px-4 py-3 text-right font-medium">{formatPrice(pos.currentPrice, 4)}</td>
                                <td className="px-4 py-3 text-right">
                                  <div className={cn("font-bold", isUp ? "text-up" : "text-down")}>
                                    {isUp ? '+' : ''}{formatPrice(pos.unrealizedPl)}
                                  </div>
                                  <div className={cn("text-xs", isUp ? "text-up/70" : "text-down/70")}>
                                    {isUp ? '+' : ''}{formatPct(pos.unrealizedPlPct)}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Open Positions Table (paper/local) */}
      <div className="flex flex-col mt-4">
        <h2 className="text-sm font-bold tracking-widest text-foreground mb-4">OPEN POSITIONS — PAPER ({positions?.length || 0})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground bg-muted/50 border-y border-border">
              <tr>
                <th className="px-4 py-3 font-medium">SYMBOL</th>
                <th className="px-4 py-3 font-medium text-right">SIZE</th>
                <th className="px-4 py-3 font-medium text-right">ENTRY</th>
                <th className="px-4 py-3 font-medium text-right">MARKET</th>
                <th className="px-4 py-3 font-medium text-right">UNREALIZED PNL</th>
                <th className="px-4 py-3 font-medium text-right">ACTION</th>
              </tr>
            </thead>
            <tbody>
              {positions?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground border-b border-border">
                    NO OPEN POSITIONS
                  </td>
                </tr>
              )}
              {positions?.map((pos) => {
                const isUp = pos.pnl >= 0;
                return (
                  <tr key={pos.symbol} className="border-b border-border hover:bg-card/50 transition-colors">
                    <td className="px-4 py-3 font-bold text-foreground">{pos.symbol}</td>
                    <td className="px-4 py-3 text-right">{pos.quantity}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{formatPrice(pos.avgEntryPrice, 4)}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatPrice(pos.currentPrice, 4)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className={cn("font-bold", isUp ? "text-up" : "text-down")}>
                        {isUp ? '+' : ''}{formatPrice(pos.pnl)}
                      </div>
                      <div className={cn("text-xs", isUp ? "text-up/70" : "text-down/70")}>
                        {isUp ? '+' : ''}{formatPct(pos.pnlPct)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link 
                        href={`/market/${pos.symbol}`}
                        className="text-xs px-3 py-1 border border-border bg-card hover:bg-primary/20 hover:text-primary hover:border-primary/50 transition-colors inline-block"
                      >
                        TRADE
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
