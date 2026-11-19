import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { cn, formatPrice, formatNumber } from '@/lib/utils';

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeMarker {
  time: number;
  side: 'buy' | 'sell';
}

interface TradingChartProps {
  candles: CandlePoint[];
  height?: number;
  avgEntry?: number | null;
  markers?: TradeMarker[];
  livePrice?: number | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/**
 * Resolve a Tailwind theme token (stored as an HSL triplet such as `0 0% 60%`) to a
 * canvas colour. Lightweight Charts' parser only understands the legacy comma form
 * and throws "Cannot parse color" on `hsl(0 0% 60%)`, so rebuild it with commas.
 */
function themeColor(token: string, alpha = 1): string {
  if (typeof window === 'undefined') return '#888';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (!raw) return '#888';
  const parts = raw.replace(/\s*\/\s*[\d.]+%?$/, '').split(/\s+/).filter(Boolean);
  if (parts.length < 3) return '#888';
  const [h, s, l] = parts;
  return alpha === 1 ? `hsl(${h}, ${s}, ${l})` : `hsla(${h}, ${s}, ${l}, ${alpha})`;
}

interface Legend {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  up: boolean;
}

/**
 * TradingView Lightweight Charts candle chart: canvas rendering, wheel zoom, drag
 * to pan, crosshair with an OHLCV readout, volume histogram, an average-entry price
 * line and buy/sell markers — the interaction model fomo gets from TradingView.
 */
export function TradingChart({
  candles,
  height = 460,
  avgEntry = null,
  markers = [],
  livePrice = null,
  loading = false,
  error = null,
  onRetry,
}: TradingChartProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const [legend, setLegend] = useState<Legend | null>(null);

  // ── Create the chart once ──────────────────────────────────────────────────
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    const up = themeColor('--up');
    const down = themeColor('--down');
    const border = themeColor('--border');

    const chart = createChart(holder, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: themeColor('--card') },
        textColor: themeColor('--muted-foreground'),
        fontSize: 10,
      },
      grid: {
        vertLines: { color: border, style: LineStyle.Dotted },
        horzLines: { color: border, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: themeColor('--muted-foreground'), width: 1, style: LineStyle.Dashed, labelBackgroundColor: themeColor('--card') },
        horzLine: { color: themeColor('--muted-foreground'), width: 1, style: LineStyle.Dashed, labelBackgroundColor: themeColor('--card') },
      },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.08, bottom: 0.28 } },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dotted,
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const toLegend = (d: CandlestickData, volume: number): Legend => ({
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume,
      up: d.close >= d.open,
    });

    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.point) {
        setLegend(null);
        return;
      }
      const bar = param.seriesData.get(candleSeries) as CandlestickData | undefined;
      const vol = param.seriesData.get(volumeSeries) as { value?: number } | undefined;
      if (!bar) {
        setLegend(null);
        return;
      }
      setLegend(toLegend(bar, vol?.value ?? 0));
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      priceLineRef.current = null;
    };
  }, []);

  // ── Data ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    const volumeSeries = volumeRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    if (candles.length === 0) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
      return;
    }

    candleSeries.setData(
      candles.map(c => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const up = themeColor('--up', 0.45);
    const down = themeColor('--down', 0.45);
    volumeSeries.setData(
      candles.map(c => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? up : down,
      })),
    );

    chart.timeScale().fitContent();
    setLegend(null);
  }, [candles]);

  // ── Live tick: extend the final candle ────────────────────────────────────
  useEffect(() => {
    const candleSeries = candleRef.current;
    if (!candleSeries || livePrice == null || candles.length === 0) return;
    const last = candles[candles.length - 1];
    candleSeries.update({
      time: last.time as UTCTimestamp,
      open: last.open,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      close: livePrice,
    } as CandlestickData);
  }, [livePrice, candles]);

  // ── Average entry line ────────────────────────────────────────────────────
  useEffect(() => {
    const candleSeries = candleRef.current;
    if (!candleSeries) return;
    if (priceLineRef.current) {
      candleSeries.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
    }
    if (avgEntry == null || !isFinite(avgEntry) || avgEntry <= 0) return;
    priceLineRef.current = candleSeries.createPriceLine({
      price: avgEntry,
      color: themeColor('--primary'),
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'AVG ENTRY',
    });
  }, [avgEntry]);

  // ── Buy / sell markers ────────────────────────────────────────────────────
  useEffect(() => {
    const candleSeries = candleRef.current;
    if (!candleSeries) return;
    const list: SeriesMarker<Time>[] = markers
      .slice()
      .sort((a, b) => a.time - b.time)
      .map(m => ({
        time: m.time as UTCTimestamp,
        position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: m.side === 'buy' ? themeColor('--up') : themeColor('--down'),
        shape: 'circle',
        text: m.side === 'buy' ? 'B' : 'S',
      }));
    candleSeries.setMarkers(list);
  }, [markers, candles]);

  const showPlaceholder = loading || error || candles.length === 0;

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={holderRef} className="absolute inset-0" />

      {/* OHLCV readout */}
      {!showPlaceholder && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap items-center gap-3 text-[10px] font-mono bg-card/80 px-2 py-1 border border-border/60">
          {legend ? (
            <>
              <span className="text-muted-foreground">O <span className={legend.up ? 'text-up' : 'text-down'}>{formatPrice(legend.open, 6)}</span></span>
              <span className="text-muted-foreground">H <span className={legend.up ? 'text-up' : 'text-down'}>{formatPrice(legend.high, 6)}</span></span>
              <span className="text-muted-foreground">L <span className={legend.up ? 'text-up' : 'text-down'}>{formatPrice(legend.low, 6)}</span></span>
              <span className="text-muted-foreground">C <span className={legend.up ? 'text-up' : 'text-down'}>{formatPrice(legend.close, 6)}</span></span>
              <span className="text-muted-foreground">V <span className="text-foreground">{formatNumber(legend.volume)}</span></span>
            </>
          ) : (
            <span className="text-muted-foreground">DRAG TO PAN · SCROLL TO ZOOM</span>
          )}
        </div>
      )}

      {showPlaceholder && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs">
          {loading ? (
            <span className="text-muted-foreground">LOADING CHART DATA…</span>
          ) : error ? (
            <>
              <span className="text-down">CHART DATA UNAVAILABLE</span>
              <span className="text-[10px] text-muted-foreground max-w-md text-center">{error}</span>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="px-3 py-1 text-[10px] font-bold border border-border text-foreground hover:bg-muted"
                >
                  RETRY
                </button>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">NO CANDLES FOR THIS RANGE</span>
          )}
        </div>
      )}

      <a
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noreferrer"
        className={cn(
          'absolute bottom-1 right-2 z-10 text-[9px] tracking-wider text-muted-foreground/60 hover:text-muted-foreground',
        )}
      >
        CHARTS BY TRADINGVIEW
      </a>
    </div>
  );
}
