import { useEffect, useRef, useState } from 'react';

export interface StreamedTicker {
  symbol: string;
  price: number;
  change24h: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  updatedAt?: string;
}

/**
 * Live ticker for one symbol from the server's WebSocket feed.
 *
 * The REST poll is a 5s snapshot; these frames are pushed on every Kraken tick,
 * so the price moves the moment the exchange trades. Frames for other symbols
 * are ignored and the socket reconnects (and resubscribes) on its own, which
 * also keeps updates flowing while the tab is in the background — polling
 * timers are throttled there, WebSocket messages are not.
 */
export function useLiveTicker(symbol: string | null): StreamedTicker | null {
  const [ticker, setTicker] = useState<StreamedTicker | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyedRef = useRef(false);

  useEffect(() => {
    if (!symbol) return;

    destroyedRef.current = false;
    setTicker(null);

    const connect = () => {
      if (destroyedRef.current) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = ws;

      ws.onopen = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'subscribe', symbols: [symbol] }));
        }
      };

      ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type !== 'ticker' || msg.symbol !== symbol) return;
          if (typeof msg.price !== 'number') return;
          setTicker({
            symbol: msg.symbol,
            price: msg.price,
            change24h: Number(msg.change24h) || 0,
            changePct24h: Number(msg.changePct24h) || 0,
            high24h: Number(msg.high24h) || msg.price,
            low24h: Number(msg.low24h) || msg.price,
            volume24h: Number(msg.volume24h) || 0,
            updatedAt: msg.updatedAt,
          });
        } catch {
          // Malformed frame: ignore rather than tear down a working feed.
        }
      };

      ws.onclose = () => {
        if (!destroyedRef.current) reconnectRef.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      destroyedRef.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      socketRef.current?.close();
    };
  }, [symbol]);

  return ticker;
}
