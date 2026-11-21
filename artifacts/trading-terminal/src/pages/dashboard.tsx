import React, { useEffect, useState, useRef, useMemo } from 'react';
import {
  useGetPortfolioSummary,
  useGetWatchlist,
  useGetTrendingMarkets,
  useAddToWatchlist,
  useRemoveFromWatchlist,
  useListAccounts,
  useGetAlpacaAccount,
  useListAlpacaPositions,
  getGetWatchlistQueryKey,
  getGetPortfolioSummaryQueryKey,
  getGetTrendingMarketsQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, ReferenceDot,
} from 'recharts';
import {
  TrendingUp, Activity, Plus, X, Search, DollarSign, Percent,
  Wallet, Zap, ArrowUpRight, ArrowDownRight, Layers,
} from 'lucide-react';
import { cn, formatPrice, formatPct, formatCompactPrice } from '@/lib/utils';
import { useAlpacaHistory, HISTORY_RANGES, type HistoryRange } from '@/lib/alpaca-history';

// ─── Real broker account view ─────────────────────────────────────────────────

function AlpacaAccountSection() {
  const [range, setRange] = useState<HistoryRange>('1D');
  const { data: account, error: accountError } = useGetAlpacaAccount();
  const { data: positions } = useListAlpacaPositions();
  const { data: history, error: historyError } = useAlpacaHistory(range);

  if (accountError || !account) {
    return (
      <div className="p-4 border border-down/40 bg-down/5 text-down text-xs">
        ALPACA ACCOUNT CONNECTED BUT UNREADABLE — RECONNECT IT IN CONNECTED ACCOUNTS.
        <Link href="/accounts" className="ml-2 underline">MANAGE</Link>
      </div>
    );
  }

  const isLive = account.mode === 'live';
  const points = history?.points ?? [];
  const change = history?.change ?? 0;
  const changePct = history?.changePct ?? 0;
  const isUp = change >= 0;
  // Chart colours come from the terminal theme so the curve matches the rest of the UI.
  const lineColor = isUp ? 'hsl(var(--up))' : 'hsl(var(--down))';
  const openPositions = positions ?? [];
  const positionValue = openPositions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
  const top = [...openPositions].sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0)).slice(0, 6);

  const fmtTick = (iso: string) => {
    const d = new Date(iso);
    return range === '1D'
      ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Equity curve */}
      <div className="lg:col-span-2 border border-border bg-card p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[10px] tracking-widest text-muted-foreground">
              <Wallet className="w-3 h-3" />
              {isLive ? 'ALPACA LIVE' : 'ALPACA PAPER'} · PORTFOLIO VALUE
            </div>
            <div className="flex items-baseline gap-3 mt-1 flex-wrap">
              <span className="text-3xl font-bold tracking-tight">{formatPrice(account.equity)}</span>
              <span className={cn('text-sm font-bold flex items-center gap-1', isUp ? 'text-up' : 'text-down')}>
                {isUp ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                {isUp ? '+' : ''}{formatPrice(change)} ({isUp ? '+' : ''}{changePct.toFixed(2)}%)
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">
              PAST {range} · FROM {formatPrice(history?.baseValue ?? account.equity)}
            </div>
          </div>
          <div className="flex border border-border shrink-0">
            {HISTORY_RANGES.map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  'px-2 py-1 text-[10px] font-bold tracking-widest transition-colors',
                  range === r ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="h-52 w-full">
          {historyError ? (
            <div className="h-full flex items-center justify-center text-xs text-down border border-dashed border-down/30">
              EQUITY CURVE UNAVAILABLE: {(historyError as Error).message}
            </div>
          ) : points.length < 2 ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-xs text-muted-foreground border border-dashed border-border px-4 text-center">
              <span>{history ? 'ALPACA RETURNED NO EQUITY POINTS FOR THIS RANGE' : 'LOADING EQUITY CURVE…'}</span>
              {history && range !== '1D' && (
                <button
                  onClick={() => setRange('1D')}
                  className="px-3 py-1 text-[10px] font-bold tracking-widest border border-border hover:bg-muted"
                >
                  TRY 1D
                </button>
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={fmtTick}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={{ stroke: 'hsl(var(--border))' }}
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => formatCompactPrice(v)}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 0, fontSize: 11 }}
                  labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                  labelFormatter={(label) => new Date(label as string).toLocaleString()}
                  formatter={(value: any) => [formatPrice(Number(value)), 'EQUITY']}
                />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke={lineColor}
                  strokeWidth={1.5}
                  fill="url(#equityFill)"
                  isAnimationActive={false}
                />
                {/* fomo-style "now" marker: dashed line plus the live endpoint dot */}
                <ReferenceLine
                  x={points[points.length - 1].t}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="3 3"
                  strokeOpacity={0.5}
                />
                <ReferenceDot
                  x={points[points.length - 1].t}
                  y={points[points.length - 1].equity}
                  r={3}
                  fill={lineColor}
                  stroke="none"
                  isFront
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Balances */}
      <div className="border border-border bg-card flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[10px] font-bold tracking-widest text-muted-foreground">BALANCES</span>
          <Link href="/accounts" className="text-[10px] text-primary hover:underline">MANAGE</Link>
        </div>
        <div className="grid grid-cols-2 divide-x divide-border">
          <div className="p-4">
            <div className="text-[10px] text-muted-foreground mb-1">CASH</div>
            <div className="text-lg font-bold truncate">{formatPrice(account.cash)}</div>
          </div>
          <div className="p-4">
            <div className="text-[10px] text-muted-foreground mb-1">BUYING POWER</div>
            <div className="text-lg font-bold truncate">{formatPrice(account.buyingPower)}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-border border-t border-border">
          <div className="p-4">
            <div className="text-[10px] text-muted-foreground mb-1">POSITIONS</div>
            <div className="text-lg font-bold">
              {openPositions.length}
              <span className="text-[10px] text-muted-foreground ml-2">{formatCompactPrice(positionValue)}</span>
            </div>
          </div>
          <div className="p-4">
            <div className="text-[10px] text-muted-foreground mb-1">STATUS</div>
            <div className={cn('text-sm font-bold uppercase flex items-center gap-1', account.status === 'ACTIVE' ? 'text-up' : 'text-yellow-400')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', account.status === 'ACTIVE' ? 'bg-up' : 'bg-yellow-400')} />
              {account.status}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">{account.currency}</div>
          </div>
        </div>
        <div className="p-4 border-t border-border mt-auto flex flex-col gap-2">
          <Link
            href="/automations"
            className="w-full py-2 text-[11px] font-bold tracking-widest bg-primary/20 text-primary border border-primary/50 hover:bg-primary/30 transition-colors flex items-center justify-center gap-2"
          >
            <Zap className="w-3.5 h-3.5" />
            CREATE AUTOMATION
          </Link>
          <div className="text-[10px] text-muted-foreground text-center">
            {isLive ? 'LIVE KEY — TRADING STAYS DISABLED UNTIL THE SAFETY GATEWAY SHIPS' : 'PAPER KEY — NO REAL FUNDS AT RISK'}
          </div>
        </div>
      </div>

      {/* Positions */}
      <div className="lg:col-span-3 border border-border bg-card">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[10px] font-bold tracking-widest text-muted-foreground flex items-center gap-2">
            <Layers className="w-3 h-3" /> TOP POSITIONS
          </span>
          <Link href="/portfolio" className="text-[10px] text-primary hover:underline">VIEW ALL</Link>
        </div>
        {top.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            NO OPEN POSITIONS ON THIS ACCOUNT YET
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-[10px] text-muted-foreground bg-muted/40 border-b border-border">
                <tr>
                  <th className="px-4 py-2 font-medium">SYMBOL</th>
                  <th className="px-4 py-2 font-medium text-right">QTY</th>
                  <th className="px-4 py-2 font-medium text-right">ENTRY</th>
                  <th className="px-4 py-2 font-medium text-right">LAST</th>
                  <th className="px-4 py-2 font-medium text-right">VALUE</th>
                  <th className="px-4 py-2 font-medium text-right">UNREALIZED</th>
                </tr>
              </thead>
              <tbody>
                {top.map(p => {
                  const up = (p.unrealizedPl ?? 0) >= 0;
                  return (
                    <tr key={p.symbol} className="border-b border-border/60 last:border-0 hover:bg-muted/20">
                      <td className="px-4 py-2 font-bold">
                        <Link href={`/market/${p.symbol}`} className="hover:text-primary">{p.symbol}</Link>
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">{p.qty}</td>
                      <td className="px-4 py-2 text-right text-muted-foreground">{formatPrice(p.avgEntryPrice)}</td>
                      <td className="px-4 py-2 text-right">{formatPrice(p.currentPrice)}</td>
                      <td className="px-4 py-2 text-right">{formatPrice(p.marketValue)}</td>
                      <td className={cn('px-4 py-2 text-right font-bold', up ? 'text-up' : 'text-down')}>
                        {up ? '+' : ''}{formatPrice(p.unrealizedPl)}
                        <span className="text-[10px] font-normal opacity-70 ml-1">
                          ({up ? '+' : ''}{(p.unrealizedPlPct ?? 0).toFixed(2)}%)
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Paper/local summary (no broker connected) ────────────────────────────────

function PaperSummaryTiles() {
  const { data: summary } = useGetPortfolioSummary({
    query: { queryKey: getGetPortfolioSummaryQueryKey(), refetchInterval: 5000 },
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="p-4 border border-border bg-card flex flex-col gap-2 relative overflow-hidden group">
        <div className="text-xs text-muted-foreground">TOTAL VALUE</div>
        <div className="text-2xl font-bold tracking-tight truncate">
          {summary ? formatCompactPrice(summary.totalValue) : '---'}
        </div>
        <DollarSign className="absolute -bottom-4 -right-4 w-24 h-24 text-muted/10 group-hover:text-primary/10 transition-colors" />
      </div>
      <div className="p-4 border border-border bg-card flex flex-col gap-2 relative overflow-hidden group">
        <div className="text-xs text-muted-foreground">TOTAL PNL</div>
        <div className={cn(
          'text-2xl font-bold tracking-tight',
          summary?.totalPnl && summary.totalPnl >= 0 ? 'text-up' : summary?.totalPnl && summary.totalPnl < 0 ? 'text-down' : 'text-foreground',
        )}>
          {summary ? (summary.totalPnl >= 0 ? '+' : '') + formatCompactPrice(Math.abs(summary.totalPnl)) : '---'}
        </div>
        <Activity className="absolute -bottom-4 -right-4 w-24 h-24 text-muted/10 group-hover:text-primary/10 transition-colors" />
      </div>
      <div className="p-4 border border-border bg-card flex flex-col gap-2 relative overflow-hidden group">
        <div className="text-xs text-muted-foreground">PNL %</div>
        <div className={cn(
          'text-2xl font-bold tracking-tight',
          summary?.totalPnlPct && summary.totalPnlPct >= 0 ? 'text-up' : summary?.totalPnlPct && summary.totalPnlPct < 0 ? 'text-down' : 'text-foreground',
        )}>
          {summary ? (summary.totalPnlPct >= 0 ? '+' : '') + formatPct(summary.totalPnlPct) : '---'}
        </div>
        <Percent className="absolute -bottom-4 -right-4 w-24 h-24 text-muted/10 group-hover:text-primary/10 transition-colors" />
      </div>
      <div className="p-4 border border-border bg-card flex flex-col gap-2 relative overflow-hidden group">
        <div className="text-xs text-muted-foreground">OPEN POSITIONS</div>
        <div className="text-2xl font-bold tracking-tight text-primary">
          {summary ? summary.openPositions : '---'}
        </div>
        <TrendingUp className="absolute -bottom-4 -right-4 w-24 h-24 text-muted/10 group-hover:text-primary/10 transition-colors" />
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { data: accounts } = useListAccounts();
  const { data: watchlist } = useGetWatchlist();
  const { data: trending } = useGetTrendingMarkets({
    query: { queryKey: getGetTrendingMarketsQueryKey(), refetchInterval: 5000 },
  });
  const addWatchlist = useAddToWatchlist();
  const removeWatchlist = useRemoveFromWatchlist();

  // Token discovery: search Kraken's whole catalog, not just the default pairs.
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolResults, setSymbolResults] = useState<Array<{ symbol: string; name: string; price: number | null; changePct24h: number | null }>>([]);
  const [searchingSymbols, setSearchingSymbols] = useState(false);

  useEffect(() => {
    const query = symbolQuery.trim();
    if (!query) {
      setSymbolResults([]);
      return;
    }

    let cancelled = false;
    setSearchingSymbols(true);
    const timer = setTimeout(() => {
      fetch(`/api/markets/search?q=${encodeURIComponent(query)}&limit=8`, { credentials: 'same-origin' })
        .then(r => (r.ok ? r.json() : []))
        .then(rows => { if (!cancelled) setSymbolResults(rows); })
        .catch(() => { if (!cancelled) setSymbolResults([]); })
        .finally(() => { if (!cancelled) setSearchingSymbols(false); });
    }, 250);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [symbolQuery]);
  const [liveTickers, setLiveTickers] = useState<Record<string, any>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyed = useRef(false);

  const alpacaAccount = accounts?.find(a => a.exchange === 'alpaca' && a.status === 'active');

  // Determine symbols to subscribe to
  const watchlistSymbols = useMemo(() => {
    return watchlist?.map(w => w.symbol) || [];
  }, [watchlist]);

  // Always-current ref so onopen/reconnect always sees latest symbols
  const watchlistSymbolsRef = useRef<string[]>([]);
  watchlistSymbolsRef.current = watchlistSymbols;

  const sendSubscribe = (ws: WebSocket) => {
    const syms = watchlistSymbolsRef.current;
    if (syms.length > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', symbols: syms }));
    }
  };

  const connectWS = () => {
    if (destroyed.current) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => sendSubscribe(ws);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ticker') {
          setLiveTickers(prev => ({ ...prev, [data.symbol]: data }));
        }
      } catch (e) {
        console.error('WS parse error', e);
      }
    };

    ws.onclose = () => {
      if (!destroyed.current) {
        reconnectTimer.current = setTimeout(connectWS, 3000);
      }
    };

    ws.onerror = () => ws.close();
  };

  useEffect(() => {
    destroyed.current = false;
    connectWS();
    return () => {
      destroyed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (wsRef.current) sendSubscribe(wsRef.current);
  }, [watchlistSymbols]); // eslint-disable-line react-hooks/exhaustive-deps

  const addSymbol = (symbol: string) => {
    if (!symbol) return;
    addWatchlist.mutate({ data: { symbol } }, {
      onSuccess: () => {
        setSymbolQuery('');
        setSymbolResults([]);
        queryClient.invalidateQueries({ queryKey: getGetWatchlistQueryKey() });
      },
    });
  };

  const handleAddWatchlist = (e: React.FormEvent) => {
    e.preventDefault();
    addSymbol(symbolResults[0]?.symbol ?? symbolQuery.trim().toUpperCase());
  };

  const handleRemoveWatchlist = (symbol: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    removeWatchlist.mutate({ symbol }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWatchlistQueryKey() });
      },
    });
  };

  return (
    <div className="flex flex-col gap-6 font-mono">
      {/* Connected broker → real balances and equity curve. Otherwise paper summary. */}
      {alpacaAccount ? <AlpacaAccountSection /> : <PaperSummaryTiles />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Watchlist */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h2 className="text-sm font-bold tracking-widest text-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              WATCHLIST
            </h2>
            <form onSubmit={handleAddWatchlist} className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={symbolQuery}
                  onChange={e => setSymbolQuery(e.target.value)}
                  placeholder="SEARCH TOKENS..."
                  className="w-52 bg-input border border-border text-foreground pl-8 pr-2 py-1 text-xs focus:outline-none focus:border-primary uppercase"
                />
                {symbolQuery.trim() && (
                  <div className="absolute right-0 top-full mt-1 z-30 w-72 max-h-64 overflow-auto border border-border bg-card shadow-lg">
                    {searchingSymbols && (
                      <div className="px-3 py-2 text-[10px] text-muted-foreground">SEARCHING...</div>
                    )}
                    {!searchingSymbols && symbolResults.length === 0 && (
                      <div className="px-3 py-2 text-[10px] text-muted-foreground">
                        NO TOKENS MATCH "{symbolQuery.trim().toUpperCase()}"
                      </div>
                    )}
                    {symbolResults.map(result => (
                      <button
                        key={result.symbol}
                        type="button"
                        onClick={() => addSymbol(result.symbol)}
                        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted transition-colors"
                      >
                        <span className="font-bold">{result.symbol}</span>
                        <span className="text-muted-foreground">
                          {result.price != null ? formatCompactPrice(result.price) : '---'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="submit"
                disabled={addWatchlist.isPending || !symbolQuery.trim()}
                className="bg-primary/20 text-primary border border-primary/50 p-1 hover:bg-primary/30 transition-colors disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
              </button>
            </form>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {watchlist?.length === 0 && (
              <div className="col-span-full py-8 text-center border border-dashed border-border text-muted-foreground text-xs">
                NO SYMBOLS IN WATCHLIST
              </div>
            )}
            {watchlist?.map(item => {
              const liveData = liveTickers[item.symbol];
              const trendingFallback = trending?.find(t => t.symbol === item.symbol);
              const price     = liveData?.price     ?? trendingFallback?.price     ?? 0;
              const changePct = liveData?.changePct24h ?? trendingFallback?.changePct24h ?? 0;
              const isUp      = changePct >= 0;
              const isLive    = !!liveData;

              return (
                <Link key={item.id} href={`/market/${item.symbol}`}>
                  <div className="p-3 border border-border bg-card hover:border-primary/50 transition-colors cursor-pointer group relative">
                    <button
                      onClick={(e) => handleRemoveWatchlist(item.symbol, e)}
                      className="absolute top-2 right-2 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <div className="flex justify-between items-center mb-2">
                      <div className="font-bold text-lg">{item.symbol}</div>
                      <div className={cn(
                        'text-xs px-1.5 py-0.5 font-bold',
                        isUp ? 'bg-up/20 text-up' : 'bg-down/20 text-down',
                      )}>
                        {isUp ? '+' : ''}{changePct.toFixed(2)}%
                      </div>
                    </div>
                    <div className="flex justify-between items-end">
                      <div className={cn(
                        'text-xl tracking-tight transition-colors duration-300',
                        isUp ? 'text-up' : price ? 'text-down' : 'text-foreground',
                      )}>
                        {price ? formatCompactPrice(price) : '---'}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        {isLive && <span className="w-1.5 h-1.5 rounded-full bg-up animate-pulse inline-block" />}
                        {isLive ? 'LIVE' : '24H'}
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Trending Markets */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h2 className="text-sm font-bold tracking-widest text-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              TRENDING
            </h2>
          </div>

          <div className="flex flex-col gap-2">
            {trending?.map(ticker => {
              const isUp = ticker.changePct24h >= 0;
              return (
                <Link key={ticker.symbol} href={`/market/${ticker.symbol}`}>
                  <div className="flex items-center justify-between p-2 border border-transparent hover:border-border hover:bg-card transition-colors cursor-pointer group">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 flex items-center justify-center bg-muted text-xs font-bold group-hover:bg-primary/20 group-hover:text-primary transition-colors">
                        {ticker.symbol.substring(0, 2)}
                      </div>
                      <div className="font-bold">{ticker.symbol}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold">{formatCompactPrice(ticker.price)}</div>
                      <div className={cn('text-xs', isUp ? 'text-up' : 'text-down')}>
                        {isUp ? '+' : ''}{ticker.changePct24h.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
