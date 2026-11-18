import React, { useState } from 'react';
import { useListTrades, useGetTrade, getListTradesQueryKey, getGetTradeQueryKey } from '@workspace/api-client-react';
import { History, Search, X, ArrowUpRight, ArrowDownRight, Clock, Info, ExternalLink } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { Link } from 'wouter';
import * as Dialog from '@radix-ui/react-dialog';

function TradeDetailsDialog({ tradeId, open, onOpenChange }: { tradeId: number | null, open: boolean, onOpenChange: (open: boolean) => void }) {
  const { data: trade, isLoading } = useGetTrade(tradeId as number, {
    query: { queryKey: getGetTradeQueryKey(tradeId as number), enabled: !!tradeId }
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-card p-6 shadow-lg duration-200 font-mono">
          <div className="flex items-center justify-between border-b border-border pb-4">
            <Dialog.Title className="text-lg font-bold tracking-widest flex items-center gap-2">
              <Info className="w-5 h-5 text-primary" />
              TRADE RECEIPT #{tradeId}
            </Dialog.Title>
            <Dialog.Close className="text-muted-foreground hover:text-foreground">
              <X className="w-5 h-5" />
            </Dialog.Close>
          </div>

          <div className="flex flex-col gap-4 py-4 min-h-[200px]">
            {isLoading || !trade ? (
              <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm">
                LOADING RECEIPT DATA...
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between p-4 border border-border bg-muted/20">
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "w-12 h-12 flex items-center justify-center border text-lg font-bold shrink-0",
                      trade.side === 'buy' ? "bg-up/10 border-up/30 text-up" : "bg-down/10 border-down/30 text-down"
                    )}>
                      {trade.side === 'buy' ? <ArrowUpRight className="w-6 h-6" /> : <ArrowDownRight className="w-6 h-6" />}
                    </div>
                    <div>
                      <div className="font-bold text-xl">{trade.symbol}</div>
                      <div className={cn(
                        "text-xs font-bold uppercase",
                        trade.side === 'buy' ? "text-up" : "text-down"
                      )}>{trade.side} ORDER</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground mb-1">STATUS</div>
                    <div className={cn(
                      "px-2 py-0.5 text-xs font-bold uppercase border",
                      trade.status === 'filled' ? "border-primary/50 text-primary bg-primary/10" : 
                      trade.status === 'pending' ? "border-accent/50 text-accent bg-accent/10" :
                      "border-muted text-muted-foreground"
                    )}>{trade.status}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border border-border p-4 bg-card">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">EXECUTION PRICE</div>
                    <div className="font-bold">{formatPrice(trade.price, 6)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">QUANTITY</div>
                    <div className="font-bold">{trade.quantity}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">TOTAL VALUE</div>
                    <div className="font-bold">{trade.total ? formatPrice(trade.total) : '---'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">ENVIRONMENT</div>
                    <div className={cn(
                      "font-bold uppercase",
                      trade.mode === 'real' ? "text-down" : "text-muted-foreground"
                    )}>{trade.mode}</div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 text-xs text-muted-foreground mt-2 border-t border-border pt-4">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 shrink-0" />
                    <span>CREATED: {new Date(trade.createdAt).toLocaleString()}</span>
                  </div>
                  {trade.filledAt && (
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 shrink-0" />
                      <span>FILLED: {new Date(trade.filledAt).toLocaleString()}</span>
                    </div>
                  )}
                  {trade.notes && (
                    <div className="mt-2 p-3 border border-border/50 bg-muted/10 text-foreground">
                      <div className="text-[10px] text-muted-foreground mb-1">OPERATOR NOTES</div>
                      {trade.notes}
                    </div>
                  )}
                </div>

                {/* Go to Market button */}
                <Dialog.Close asChild>
                  <Link
                    href={`/market/${trade.symbol}`}
                    className="mt-2 flex items-center justify-center gap-2 py-2 border border-border bg-muted/30 hover:bg-primary/10 hover:text-primary hover:border-primary/50 transition-colors text-xs font-bold tracking-widest"
                  >
                    <ExternalLink className="w-3 h-3" />
                    OPEN {trade.symbol} CHART
                  </Link>
                </Dialog.Close>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function Trades() {
  const { data: trades } = useListTrades({ query: { queryKey: getListTradesQueryKey(), refetchInterval: 15000 } });
  const [filterSymbol, setFilterSymbol] = useState('');
  const [selectedTrade, setSelectedTrade] = useState<number | null>(null);

  const filteredTrades = trades?.filter(t => 
    !filterSymbol || t.symbol.toLowerCase().includes(filterSymbol.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6 font-mono h-full">
      <TradeDetailsDialog 
        tradeId={selectedTrade} 
        open={selectedTrade !== null} 
        onOpenChange={(open) => !open && setSelectedTrade(null)} 
      />
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-lg font-bold tracking-widest flex items-center gap-2">
          <History className="w-5 h-5 text-primary" />
          TRADE HISTORY
        </h1>
        
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
            <input 
              type="text" 
              value={filterSymbol}
              onChange={e => setFilterSymbol(e.target.value)}
              placeholder="FILTER SYMBOL"
              className="w-48 bg-input border border-border text-foreground px-8 py-1.5 text-xs focus:outline-none focus:border-primary uppercase"
            />
            {filterSymbol && (
              <button
                onClick={() => setFilterSymbol('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Trade count */}
      {filterSymbol && (
        <div className="text-xs text-muted-foreground -mt-4">
          {filteredTrades?.length ?? 0} result{filteredTrades?.length !== 1 ? 's' : ''} for "{filterSymbol}"
        </div>
      )}

      <div className="flex-1 overflow-auto border border-border bg-card">
        <table className="w-full text-sm text-left relative">
          <thead className="text-xs text-muted-foreground bg-muted/80 sticky top-0 z-10 border-b border-border">
            <tr>
              <th className="px-4 py-3 font-medium">TIME</th>
              <th className="px-4 py-3 font-medium">SYMBOL</th>
              <th className="px-4 py-3 font-medium">SIDE</th>
              <th className="px-4 py-3 font-medium text-right">PRICE</th>
              <th className="px-4 py-3 font-medium text-right">SIZE</th>
              <th className="px-4 py-3 font-medium text-right">TOTAL</th>
              <th className="px-4 py-3 font-medium text-center">STATUS</th>
              <th className="px-4 py-3 font-medium text-center">MODE</th>
            </tr>
          </thead>
          <tbody>
            {(!filteredTrades || filteredTrades.length === 0) && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  {filterSymbol ? `NO TRADES MATCHING "${filterSymbol}"` : 'NO TRADES YET'}
                </td>
              </tr>
            )}
            {filteredTrades?.map((trade) => {
              const isBuy = trade.side === 'buy';
              return (
                <tr 
                  key={trade.id} 
                  className="border-b border-border hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => setSelectedTrade(trade.id)}
                >
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap tabular-nums">
                    {new Date(trade.createdAt).toISOString().replace('T', ' ').substring(0, 19)}
                  </td>
                  <td className="px-4 py-3 font-bold">
                    <Link 
                      href={`/market/${trade.symbol}`} 
                      className="hover:text-primary hover:underline relative z-10"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {trade.symbol}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      "text-xs px-2 py-0.5 font-bold",
                      isBuy ? "bg-up/20 text-up" : "bg-down/20 text-down"
                    )}>
                      {trade.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatPrice(trade.price, 4)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {trade.quantity}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
                    {trade.total ? formatPrice(trade.total) : '---'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 uppercase border",
                      trade.status === 'filled'  ? "border-primary/50 text-primary bg-primary/10" : 
                      trade.status === 'pending' ? "border-accent/50 text-accent bg-accent/10" :
                      "border-muted text-muted-foreground"
                    )}>
                      {trade.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 uppercase",
                      trade.mode === 'real' ? "text-down font-bold" : "text-muted-foreground"
                    )}>
                      {trade.mode}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
