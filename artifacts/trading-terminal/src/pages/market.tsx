import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'wouter';
import { 
  useGetMarketTicker, 
  useGetMarketCandles, 
  useGetMarketSignals,
  useCreateTrade,
  usePlaceAlpacaOrder,
  usePlaceBrokerOrder,
  useListAccounts,
  getGetMarketTickerQueryKey,
  getGetMarketCandlesQueryKey,
  getGetMarketSignalsQueryKey,
  getListTradesQueryKey,
  getGetPortfolioSummaryQueryKey,
  getListPositionsQueryKey,
  getListAlpacaOrdersQueryKey,
  getListAlpacaPositionsQueryKey,
  getGetAlpacaAccountQueryKey,
  getGetBrokerAccountQueryKey,
  getGetBrokerOrdersQueryKey,
  getGetBrokerPositionsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Activity, TrendingUp, TrendingDown, Minus, BarChart2, Zap, X, ChevronDown } from 'lucide-react';
import { cn, formatPrice, formatNumber } from '@/lib/utils';
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

const tradeSchema = z.object({
  quantity: z.coerce.number().positive('Quantity must be positive'),
  price: z.coerce.number().positive().optional(),
  notes: z.string().optional(),
});
type TradeForm = z.infer<typeof tradeSchema>;

// ─── Stable order-book sizes (memoized per price, no flicker) ───────────────
function useOrderBookSizes(seed: number) {
  return useMemo(() => {
    const rng = (n: number) => {
      let x = Math.sin(seed + n) * 10000;
      return (x - Math.floor(x)) * 9.9 + 0.1;
    };
    return Array.from({ length: 10 }, (_, i) => rng(i));
  }, [seed]);
}

// ─── Proper candlestick shape with wicks ────────────────────────────────────
const CandlestickShape = (props: any) => {
  const { x, y, width, height, payload } = props;
  const { open, high, low, close, isUp } = payload;
  const color  = isUp ? 'hsl(var(--up))' : 'hsl(var(--down))';
  const range  = high - low;
  if (range === 0 || height === 0) return null;

  // y = top pixel (high), y+height = bottom pixel (low)
  const bodyTop    = y + ((high - Math.max(open, close)) / range) * height;
  const bodyBottom = y + ((high - Math.min(open, close)) / range) * height;
  const bodyH      = Math.max(bodyBottom - bodyTop, 1);
  const cx         = x + width / 2;
  const bodyW      = Math.max(width - 2, 2);

  return (
    <g>
      {/* Wick */}
      <line x1={cx} y1={y} x2={cx} y2={y + height} stroke={color} strokeWidth={1} />
      {/* Body */}
      <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={color} />
    </g>
  );
};

export default function Market() {
  const { symbol } = useParams();
  const safeSymbol = symbol ? decodeURIComponent(symbol).toUpperCase() : 'BTC-USDT';
  
  const queryClient = useQueryClient();
  const [interval, setIntervalState] = useState<Interval>('1h');
  
  const { data: ticker } = useGetMarketTicker(safeSymbol, { query: { queryKey: getGetMarketTickerQueryKey(safeSymbol), refetchInterval: 5000 } });
  const { data: candles, isError: candlesError, refetch: refetchCandles } = useGetMarketCandles(safeSymbol, interval, { query: { queryKey: getGetMarketCandlesQueryKey(safeSymbol, interval), refetchInterval: 30000, retry: 1 } });
  const { data: signals } = useGetMarketSignals(safeSymbol, { query: { queryKey: getGetMarketSignalsQueryKey(safeSymbol), refetchInterval: 60000 } });
  
  const createTrade = useCreateTrade();
  const placeAlpaca = usePlaceAlpacaOrder();
  const placeBroker = usePlaceBrokerOrder();
  const { data: accounts } = useListAccounts();

  // All active broker accounts (for selector)
  const activeAccounts = accounts?.filter(a => a.status === 'active') ?? [];
  const [selectedBroker, setSelectedBroker] = useState<string>('paper');
  // Auto-select first connected broker if any
  useEffect(() => {
    if (activeAccounts.length > 0 && selectedBroker === 'paper') {
      setSelectedBroker(activeAccounts[0].exchange);
    }
  }, [activeAccounts.length]);

  const alpacaAccount = accounts?.find(a => a.exchange === 'alpaca' && a.status === 'active');
  const alpacaMode    = alpacaAccount ? (alpacaAccount as any).mode as string : null;
  const usingAlpaca   = selectedBroker === 'alpaca' && !!alpacaAccount;
  const usingBroker   = selectedBroker !== 'paper' && selectedBroker !== 'alpaca' && activeAccounts.some(a => a.exchange === selectedBroker);

  const BROKER_LABELS: Record<string, string> = { paper: 'Paper', alpaca: 'Alpaca', coinbase: 'Coinbase', binance: 'Binance', kraken: 'Kraken', bybit: 'Bybit' };

  const [tradeSide, setTradeSide] = useState<'buy' | 'sell'>('buy');
  const [orderSuccess, setOrderSuccess] = useState<string | null>(null);

  // Price flash animation
  const prevPrice = useRef<number | null>(null);
  const [priceFlash, setPriceFlash] = useState<'up' | 'down' | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  useEffect(() => {
    if (ticker?.price == null) return;
    if (prevPrice.current !== null && prevPrice.current !== ticker.price) {
      setPriceFlash(ticker.price > prevPrice.current ? 'up' : 'down');
      setTimeout(() => setPriceFlash(null), 600);
    }
    prevPrice.current = ticker.price;
    setLastUpdated(new Date().toISOString().replace('T', ' ').substring(11, 19));
  }, [ticker?.price]);

  const { register, handleSubmit, reset, setValue, watch } = useForm<TradeForm>({
    resolver: zodResolver(tradeSchema),
  });

  useEffect(() => {
    if (ticker?.price) setValue('price', ticker.price);
  }, [ticker?.price, setValue]);

  const qty   = watch('quantity') || 0;
  const price = watch('price') || ticker?.price || 0;
  const estimatedTotal = qty * price;

  const onSubmit = (data: TradeForm) => {
    if (usingAlpaca) {
      placeAlpaca.mutate({
        data: {
          symbol: safeSymbol,
          side:          tradeSide,
          qty:           data.quantity,
          type:          data.price ? 'limit' : 'market',
          time_in_force: 'gtc',
          limit_price:   data.price,
        }
      }, {
        onSuccess: (order) => {
          setOrderSuccess(`${tradeSide.toUpperCase()} submitted via Alpaca · ID ${(order as any).id?.slice(0, 8)}…`);
          setTimeout(() => setOrderSuccess(null), 4000);
          reset({ quantity: 0, price: ticker?.price, notes: '' });
          queryClient.invalidateQueries({ queryKey: getListAlpacaOrdersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListAlpacaPositionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAlpacaAccountQueryKey() });
        }
      });
    } else if (usingBroker) {
      placeBroker.mutate({
        exchange: selectedBroker,
        data: {
          symbol: safeSymbol,
          side: tradeSide,
          qty: data.quantity,
          type: data.price ? 'limit' : 'market',
          limitPrice: data.price,
        }
      }, {
        onSuccess: (order) => {
          setOrderSuccess(`${tradeSide.toUpperCase()} submitted via ${BROKER_LABELS[selectedBroker]} · ID ${(order as any).id?.slice(0, 8) ?? '…'}`);
          setTimeout(() => setOrderSuccess(null), 4000);
          reset({ quantity: 0, price: ticker?.price, notes: '' });
          queryClient.invalidateQueries({ queryKey: getGetBrokerAccountQueryKey(selectedBroker) });
          queryClient.invalidateQueries({ queryKey: getGetBrokerOrdersQueryKey(selectedBroker) });
          queryClient.invalidateQueries({ queryKey: getGetBrokerPositionsQueryKey(selectedBroker) });
        }
      });
    } else {
      createTrade.mutate({
        data: {
          symbol:   safeSymbol,
          side:     tradeSide,
          quantity: data.quantity,
          price:    data.price,
          notes:    data.notes,
        }
      }, {
        onSuccess: (trade) => {
          setOrderSuccess(`Paper ${tradeSide.toUpperCase()} filled · ${data.quantity} ${safeSymbol.split('-')[0]} @ ${formatPrice(data.price ?? ticker?.price ?? 0)}`);
          setTimeout(() => setOrderSuccess(null), 4000);
          reset({ quantity: 0, price: ticker?.price, notes: '' });
          queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey() });
        }
      });
    }
  };

  const isSubmitting = createTrade.isPending || placeAlpaca.isPending || placeBroker.isPending;
  const submitError  = (createTrade.error || placeAlpaca.error || placeBroker.error) as any;
  const isUp         = ticker && ticker.changePct24h >= 0;

  // Stable order book seed (changes only when ticker price changes by >1%)
  const obSeed = useMemo(() => Math.floor((ticker?.price || 1000) / 10), [ticker?.price]);
  const obSizes = useOrderBookSizes(obSeed);

  // Chart data with wickRange for proper candlesticks
  const chartData = useMemo(() => {
    if (!candles?.length) return [];
    // A window longer than a day needs the date on the axis, otherwise
    // every tick on a multi-day chart reads as the same clock time.
    const spansMultipleDays =
      candles[candles.length - 1].time - candles[0].time > 24 * 60 * 60;
    return candles.map(c => {
      const at = new Date(c.time * 1000);
      const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return {
        ...c,
        dateStr:   spansMultipleDays ? `${at.getMonth() + 1}/${at.getDate()} ${clock}` : clock,
        isUp:      c.close >= c.open,
        wickRange: [c.low, c.high] as [number, number],
      };
    });
  }, [candles]);

  // Quantity quick-fill from buying power
  const buyingPower = usingAlpaca ? null : null; // Alpaca buying power not wired here yet
  const setQtyPct = (pct: number) => {
    if (!ticker?.price || ticker.price === 0) return;
    // For paper: use $10,000 virtual budget; for Alpaca: use price×pct of a reasonable amount
    const budget = 10000;
    setValue('quantity', parseFloat(((budget * pct) / ticker.price).toFixed(6)));
  };

  return (
    <div className="flex flex-col xl:flex-row gap-6 font-mono h-full">
      
      {/* Main Chart Area */}
      <div className="flex-1 flex flex-col gap-4">
        
        {/* Header Strip */}
        <div className="flex flex-col md:flex-row md:items-center justify-between p-4 border border-border bg-card gap-4">
          <div className="flex items-center gap-6">
            <h1 className="text-3xl font-bold tracking-tight">{safeSymbol}</h1>
            
            <div className="flex flex-col">
              <div className={cn(
                "text-2xl font-bold transition-colors duration-300",
                priceFlash === 'up'   ? "text-up scale-105"   :
                priceFlash === 'down' ? "text-down scale-95"  :
                isUp                  ? "text-up"             : "text-down"
              )}>
                {ticker ? formatPrice(ticker.price, 6) : '---'}
              </div>
              <div className="flex items-center gap-2 text-xs font-bold">
                <span className={cn(isUp ? "text-up" : "text-down")}>
                  {isUp ? '+' : ''}{ticker ? formatPrice(ticker.change24h, 4) : '0.00'}
                </span>
                <span className={cn(
                  "px-1.5 py-0.5",
                  isUp ? "bg-up/20 text-up" : "bg-down/20 text-down"
                )}>
                  {isUp ? '+' : ''}{ticker?.changePct24h.toFixed(2)}%
                </span>
                {lastUpdated && (
                  <span className="flex items-center gap-1 text-muted-foreground font-normal">
                    <span className="w-1.5 h-1.5 rounded-full bg-up animate-pulse inline-block" />
                    {lastUpdated}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-right">
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">24H HIGH</div>
              <div className="text-sm font-bold">{ticker ? formatPrice(ticker.high24h, 4) : '---'}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">24H LOW</div>
              <div className="text-sm font-bold">{ticker ? formatPrice(ticker.low24h, 4) : '---'}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">24H VOL</div>
              <div className="text-sm font-bold">{ticker ? formatNumber(ticker.volume24h) : '---'}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">VOL (QUOTE)</div>
              <div className="text-sm font-bold">
                {ticker ? formatPrice(ticker.volume24h * ticker.price, 0) : '---'}
              </div>
            </div>
          </div>
        </div>

        {/* Chart View */}
        <div className="flex-1 min-h-[400px] border border-border bg-card flex flex-col">
          <div className="flex items-center gap-1 p-2 border-b border-border bg-muted/20">
            {(['1m', '5m', '15m', '1h', '4h', '1d'] as Interval[]).map(inv => (
              <button
                key={inv}
                onClick={() => setIntervalState(inv)}
                className={cn(
                  "px-3 py-1 text-xs font-bold transition-colors",
                  interval === inv ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {inv.toUpperCase()}
              </button>
            ))}
          </div>
          
          <div className="flex-1 p-4">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                  <XAxis 
                    dataKey="dateStr" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={10} 
                    tickLine={false}
                    axisLine={false}
                    minTickGap={40}
                  />
                  <YAxis 
                    domain={['auto', 'auto']} 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={10}
                    tickFormatter={(val) => {
                      if (val >= 1000) return val.toFixed(0);
                      if (val >= 1)    return val.toFixed(2);
                      return val.toFixed(4);
                    }}
                    tickLine={false}
                    axisLine={false}
                    orientation="right"
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: 0, fontSize: 11 }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                    labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
                    formatter={(value: any, name: string) => {
                      if (name === 'wickRange') return null;
                      return [value, name];
                    }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0]?.payload;
                      if (!d) return null;
                      return (
                        <div className="border border-border bg-card p-3 text-[10px] font-mono">
                          <div className="text-muted-foreground mb-2">{d.dateStr}</div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            <span className="text-muted-foreground">OPEN</span>  <span className={d.isUp ? 'text-up' : 'text-down'}>{formatPrice(d.open, 4)}</span>
                            <span className="text-muted-foreground">HIGH</span>  <span className="text-up">{formatPrice(d.high, 4)}</span>
                            <span className="text-muted-foreground">LOW</span>   <span className="text-down">{formatPrice(d.low, 4)}</span>
                            <span className="text-muted-foreground">CLOSE</span> <span className={d.isUp ? 'text-up' : 'text-down'}>{formatPrice(d.close, 4)}</span>
                            <span className="text-muted-foreground">VOL</span>   <span>{formatNumber(d.volume)}</span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="wickRange" shape={<CandlestickShape />} isAnimationActive={false}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.isUp ? 'hsl(var(--up))' : 'hsl(var(--down))'} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            ) : candlesError ? (
              <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-down text-sm">
                <span>CHART DATA UNAVAILABLE</span>
                <button
                  onClick={() => refetchCandles()}
                  className="px-3 py-1 text-xs font-bold border border-border text-foreground hover:bg-muted"
                >
                  RETRY
                </button>
              </div>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
                LOADING CHART DATA...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Side Panel (Signals & Trade) */}
      <div className="w-full xl:w-80 flex flex-col gap-4 shrink-0">
        
        {/* Order Book */}
        <div className="border border-border bg-card p-4 flex flex-col gap-2 relative overflow-hidden h-52">
          <h2 className="text-xs font-bold tracking-widest text-muted-foreground flex items-center gap-2 mb-2 z-10">
            <BarChart2 className="w-4 h-4" />
            ORDER BOOK <span className="text-[9px] opacity-50">(INDICATIVE)</span>
          </h2>
          <div className="flex-1 flex flex-col text-[10px] font-mono z-10">
            <div className="flex justify-between text-muted-foreground mb-1">
              <span>PRICE</span>
              <span>SIZE</span>
            </div>
            {/* Asks */}
            <div className="flex flex-col gap-0.5 justify-end flex-1">
              {[0.005, 0.004, 0.003, 0.002, 0.001].map((spread, i) => {
                const p = (ticker?.price || 0) * (1 + spread);
                const s = obSizes[i];
                return (
                  <div key={i} className="flex justify-between text-down relative">
                    <div className="absolute right-0 top-0 bottom-0 bg-down/10" style={{ width: `${s * 5}%` }} />
                    <span className="z-10">{formatPrice(p, 6)}</span>
                    <span className="z-10">{s.toFixed(4)}</span>
                  </div>
                );
              })}
            </div>
            {/* Spread */}
            <div className="py-1 my-1 text-center font-bold border-y border-border text-xs">
              {ticker ? formatPrice(ticker.price, 6) : '---'}
            </div>
            {/* Bids */}
            <div className="flex flex-col gap-0.5 justify-start flex-1">
              {[0.001, 0.002, 0.003, 0.004, 0.005].map((spread, i) => {
                const p = (ticker?.price || 0) * (1 - spread);
                const s = obSizes[i + 5];
                return (
                  <div key={i} className="flex justify-between text-up relative">
                    <div className="absolute right-0 top-0 bottom-0 bg-up/10" style={{ width: `${s * 5}%` }} />
                    <span className="z-10">{formatPrice(p, 6)}</span>
                    <span className="z-10">{s.toFixed(4)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Signals Panel */}
        <div className="border border-border bg-card p-4 flex flex-col gap-4">
          <h2 className="text-xs font-bold tracking-widest text-muted-foreground flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4" />
            MARKET SIGNALS
          </h2>

          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">COMPOSITE</div>
            <div className={cn(
              "px-3 py-1 font-bold text-xs uppercase border",
              signals?.signal === 'strong_buy'  ? "bg-up/20 text-up border-up/50" :
              signals?.signal === 'buy'          ? "bg-up/10 text-up border-up/30" :
              signals?.signal === 'strong_sell'  ? "bg-down/20 text-down border-down/50" :
              signals?.signal === 'sell'         ? "bg-down/10 text-down border-down/30" :
              "bg-muted text-muted-foreground border-border"
            )}>
              {signals?.signal?.replace('_', ' ') || 'ANALYZING...'}
            </div>
          </div>

          <div className="space-y-3 pt-3 border-t border-border mt-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">TREND</span>
              <span className="flex items-center gap-1 font-bold uppercase">
                {signals?.trend === 'bullish'  && <TrendingUp className="w-4 h-4 text-up" />}
                {signals?.trend === 'bearish'  && <TrendingDown className="w-4 h-4 text-down" />}
                {signals?.trend === 'sideways' && <Minus className="w-4 h-4 text-muted-foreground" />}
                <span className={cn(
                  signals?.trend === 'bullish' ? "text-up" :
                  signals?.trend === 'bearish' ? "text-down" : "text-muted-foreground"
                )}>{signals?.trend || '---'}</span>
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">RSI (14)</span>
              <span className={cn(
                "font-bold",
                signals?.rsi && signals.rsi > 70 ? "text-down" : 
                signals?.rsi && signals.rsi < 30 ? "text-up" : "text-foreground"
              )}>
                {signals?.rsi != null ? signals.rsi.toFixed(2) : '---'}
                {signals?.rsi && signals.rsi > 70 && <span className="text-[9px] ml-1 opacity-70">OVERBOUGHT</span>}
                {signals?.rsi && signals.rsi < 30 && <span className="text-[9px] ml-1 opacity-70">OVERSOLD</span>}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">MACD</span>
              <span className={cn(
                "font-bold",
                signals?.macd && signals.macd > 0 ? "text-up" :
                signals?.macd && signals.macd < 0 ? "text-down" : "text-foreground"
              )}>{signals?.macd != null ? signals.macd.toFixed(4) : '---'}</span>
            </div>
            
            {(signals?.supportLevel || signals?.resistanceLevel) && (
              <div className="pt-3 border-t border-border mt-3 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">RESISTANCE</span>
                  <span className="font-bold text-down">{signals?.resistanceLevel ? formatPrice(signals.resistanceLevel, 4) : '---'}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">SUPPORT</span>
                  <span className="font-bold text-up">{signals?.supportLevel ? formatPrice(signals.supportLevel, 4) : '---'}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Trade Panel */}
        <div className="border border-border bg-card flex flex-col flex-1">
          {/* Broker selector */}
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground tracking-widest shrink-0">EXECUTE VIA</span>
              <select
                value={selectedBroker}
                onChange={e => setSelectedBroker(e.target.value)}
                className="flex-1 bg-input border border-border text-foreground px-2 py-1 text-xs focus:outline-none focus:border-primary appearance-none"
              >
                <option value="paper">Paper (Local)</option>
                {activeAccounts.map(a => (
                  <option key={a.id} value={a.exchange}>
                    {BROKER_LABELS[a.exchange] ?? a.exchange} — {(a as any).mode === 'live' ? 'LIVE' : 'PAPER'}
                  </option>
                ))}
              </select>
            </div>
            {(usingAlpaca || usingBroker) && (
              <div className={cn('mt-1.5 flex items-center gap-1 text-[9px] font-bold tracking-widest', selectedBroker === 'alpaca' && alpacaMode === 'live' ? 'text-down' : 'text-primary')}>
                <Zap className="w-2.5 h-2.5" />
                {usingAlpaca
                  ? `ROUTED TO ALPACA ${alpacaMode === 'live' ? 'LIVE' : 'PAPER'}`
                  : `ROUTED TO ${(BROKER_LABELS[selectedBroker] ?? selectedBroker).toUpperCase()}`}
              </div>
            )}
          </div>

          <div className="flex">
            <button
              onClick={() => setTradeSide('buy')}
              className={cn(
                "flex-1 py-3 text-sm font-bold tracking-widest transition-colors border-b-2",
                tradeSide === 'buy' ? "border-up text-up bg-up/5" : "border-transparent text-muted-foreground hover:bg-muted/50"
              )}
            >
              BUY
            </button>
            <button
              onClick={() => setTradeSide('sell')}
              className={cn(
                "flex-1 py-3 text-sm font-bold tracking-widest transition-colors border-b-2",
                tradeSide === 'sell' ? "border-down text-down bg-down/5" : "border-transparent text-muted-foreground hover:bg-muted/50"
              )}
            >
              SELL
            </button>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="p-4 flex flex-col gap-3 flex-1">
            {/* Quantity */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">QUANTITY</label>
              <div className="relative">
                <input
                  {...register('quantity')}
                  type="number"
                  step="any"
                  className="w-full bg-input border border-border text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary pr-16"
                  placeholder="0.00"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-bold">
                  {safeSymbol.split('-')[0]}
                </span>
              </div>
              {/* Quick-fill presets */}
              <div className="flex gap-1 mt-1">
                {[25, 50, 75, 100].map(pct => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setQtyPct(pct / 100)}
                    className="flex-1 text-[9px] py-0.5 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors border border-border"
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            {/* Limit Price */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {usingAlpaca ? 'LIMIT PRICE (BLANK = MARKET)' : 'LIMIT PRICE (OPTIONAL)'}
              </label>
              <div className="relative">
                <input
                  {...register('price')}
                  type="number"
                  step="any"
                  className="w-full bg-input border border-border text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary pr-16"
                  placeholder={ticker?.price?.toString()}
                />
                <div className="absolute right-0 top-0 bottom-0 flex items-center gap-1 pr-2">
                  <button
                    type="button"
                    onClick={() => setValue('price', undefined as any)}
                    className="text-muted-foreground hover:text-foreground p-0.5"
                    title="Clear price (market order)"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  <span className="text-xs text-muted-foreground font-bold">USD</span>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-border flex justify-between items-center">
              <span className="text-xs text-muted-foreground">ESTIMATED TOTAL</span>
              <span className="text-lg font-bold">{formatPrice(estimatedTotal)}</span>
            </div>

            {/* Success */}
            {orderSuccess && (
              <div className="text-up text-[10px] p-2 bg-up/10 border border-up/30 font-bold">
                ✓ {orderSuccess}
              </div>
            )}

            {/* Error */}
            {submitError && (
              <div className="text-down text-[10px] p-2 bg-down/10 border border-down/30">
                {submitError?.response?.data?.error ?? submitError?.message ?? 'Order failed'}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting || qty <= 0}
              className={cn(
                "w-full py-3 text-sm font-bold tracking-widest transition-colors disabled:opacity-50",
                tradeSide === 'buy' ? "bg-up text-up-foreground hover:bg-up/90" : "bg-down text-down-foreground hover:bg-down/90"
              )}
            >
              {isSubmitting
                ? 'EXECUTING...'
                : (usingAlpaca || usingBroker)
                  ? `${tradeSide.toUpperCase()} VIA ${(BROKER_LABELS[selectedBroker] ?? selectedBroker).toUpperCase()}`
                  : `PLACE ${tradeSide.toUpperCase()} (PAPER)`}
            </button>

            {selectedBroker === 'paper' && activeAccounts.length === 0 && (
              <p className="text-[10px] text-muted-foreground text-center">
                Connect a broker in Accounts to trade live
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
