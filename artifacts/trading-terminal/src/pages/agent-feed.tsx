import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListTradeIntents,
  useGenerateTradeIntent,
  useApproveTradeIntent,
  useRejectTradeIntent,
  useListMarkets,
  getListTradeIntentsQueryKey,
  getListTradesQueryKey,
  getGetPortfolioSummaryQueryKey,
} from '@workspace/api-client-react';
import {
  Bot,
  Sparkles,
  CheckCircle,
  XCircle,
  Clock,
  ShieldAlert,
  Target,
  TrendingUp,
  TrendingDown,
  Loader2,
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn, formatCompactPrice } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';

const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const STATUS_STYLES: Record<string, { label: string; className: string; Icon: React.ElementType }> = {
  pending:  { label: 'AWAITING DECISION', className: 'text-yellow-400 border-yellow-400/40 bg-yellow-400/10', Icon: Clock },
  approved: { label: 'APPROVED · PAPER',  className: 'text-up border-up/40 bg-up/10',                Icon: CheckCircle },
  rejected: { label: 'REJECTED',          className: 'text-muted-foreground border-border bg-muted',  Icon: XCircle },
};

export default function AgentFeed() {
  const queryClient = useQueryClient();
  const { data: intents, isLoading } = useListTradeIntents({
    query: { queryKey: getListTradeIntentsQueryKey(), refetchInterval: 15000 },
  });
  const { data: markets } = useListMarkets();
  const generate = useGenerateTradeIntent();
  const approve = useApproveTradeIntent();
  const reject = useRejectTradeIntent();

  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [lastNote, setLastNote] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [rejectTarget, setRejectTarget] = useState<{ id: number; symbol: string; side: string } | null>(null);
  const [reason, setReason] = useState('');

  // Fall back to the first market so the picker is never blank.
  const symbol = selectedSymbol || markets?.[0]?.symbol || '';

  const refreshFeed = () => {
    queryClient.invalidateQueries({ queryKey: getListTradeIntentsQueryKey() });
  };

  const handleGenerate = () => {
    if (!symbol) return;
    generate.mutate(
      { data: { symbol, timeframe } },
      {
        onSuccess: (result) => {
          setLastNote(result.note);
          refreshFeed();
          toast({
            title: result.intent ? `Intent: ${result.intent.side.toUpperCase()} ${result.intent.symbol}` : 'Analyst stood aside',
            description: result.note,
          });
        },
        onError: (error: any) => {
          toast({
            title: 'Could not generate an intent',
            description: error?.message ?? 'Strategy engine unavailable',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleApprove = (id: number) => {
    approve.mutate(
      { id },
      {
        onSuccess: (intent) => {
          refreshFeed();
          queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
          toast({
            title: 'Paper fill simulated',
            description: `${intent.side.toUpperCase()} ${intent.quantity} ${intent.symbol}@~${formatCompactPrice(intent.referencePrice)}${intent.tradeId ? ` · trade #${intent.tradeId}` : ''}`,
          });
        },
        onError: (error: any) => {
          refreshFeed();
          toast({
            title: 'Approval failed',
            description: error?.message ?? 'Unknown error',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const openReject = (intent: { id: number; symbol: string; side: string }) => {
    setReason('');
    setRejectTarget(intent);
  };

  const closeReject = () => {
    setRejectTarget(null);
    setReason('');
  };

  const submitReject = () => {
    if (!rejectTarget) return;
    const note = reason.trim();
    reject.mutate(
      { id: rejectTarget.id, data: note ? { reason: note } : {} },
      {
        onSuccess: () => {
          closeReject();
          refreshFeed();
          toast({
            title: `Intent #${rejectTarget.id} rejected`,
            description: note
              ? 'No trade was simulated. Your reason is on record.'
              : 'No trade was simulated.',
          });
        },
        onError: (error: any) => {
          refreshFeed();
          toast({
            title: 'Rejection failed',
            description: error?.message ?? 'Unknown error',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const pending = intents?.filter(i => i.status === 'pending') ?? [];
  const decided = intents?.filter(i => i.status !== 'pending') ?? [];
  const approvedCount = intents?.filter(i => i.status === 'approved').length ?? 0;
  const rejectedCount = intents?.filter(i => i.status === 'rejected').length ?? 0;

  return (
    <div className="flex flex-col gap-6 font-mono max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-widest flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            AGENT FEED
          </h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Analysts propose. You decide. Approvals simulate a paper fill — nothing is sent to a live broker.
          </p>
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="text-yellow-400 font-bold">{pending.length} PENDING</span>
          <span className="text-up">{approvedCount} APPROVED</span>
          <span className="text-muted-foreground">{rejectedCount} REJECTED</span>
        </div>
      </div>

      {/* Generator */}
      <div className="p-4 border border-border bg-card flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex-1">
          <label className="block text-[10px] text-muted-foreground mb-1">SYMBOL</label>
          <select
            value={symbol}
            onChange={(e) => setSelectedSymbol(e.target.value)}
            className="w-full bg-input border border-border text-foreground px-3 py-2 text-xs focus:outline-none focus:border-primary appearance-none"
          >
            {markets?.map(m => (
              <option key={m.symbol} value={m.symbol}>{m.symbol}</option>
            ))}
          </select>
        </div>
        <div className="md:w-32">
          <label className="block text-[10px] text-muted-foreground mb-1">TIMEFRAME</label>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as Timeframe)}
            className="w-full bg-input border border-border text-foreground px-3 py-2 text-xs focus:outline-none focus:border-primary appearance-none"
          >
            {TIMEFRAMES.map(tf => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generate.isPending || !symbol}
          className="flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold tracking-widest bg-primary/20 text-primary border border-primary/50 hover:bg-primary/30 transition-colors disabled:opacity-50"
        >
          {generate.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {generate.isPending ? 'ANALYSING…' : 'GENERATE INTENT'}
        </button>
      </div>

      {lastNote && (
        <div className="px-4 py-3 border border-border bg-muted/30 text-[11px] text-muted-foreground leading-relaxed">
          <span className="text-foreground font-bold">LAST ANALYSIS: </span>
          {lastNote}
        </div>
      )}

      {/* Pending feed */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-widest text-muted-foreground">AWAITING YOUR DECISION</h2>

        {isLoading && (
          <div className="p-6 text-center text-muted-foreground text-xs border border-dashed border-border">
            LOADING…
          </div>
        )}

        {!isLoading && pending.length === 0 && (
          <div className="p-8 border border-dashed border-border text-center text-muted-foreground text-xs">
            NO PENDING INTENTS. PICK A SYMBOL AND GENERATE ONE.
          </div>
        )}

        {pending.map(intent => (
          <div key={intent.id} className="border border-yellow-400/30 bg-card flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex items-center gap-3">
                <span className={cn(
                  'flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold border',
                  intent.side === 'buy' ? 'text-up border-up/40 bg-up/10' : 'text-down border-down/40 bg-down/10',
                )}>
                  {intent.side === 'buy' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {intent.side.toUpperCase()}
                </span>
                <span className="text-sm font-bold tracking-wide">{intent.symbol}</span>
                <span className="text-[10px] text-muted-foreground">
                  {intent.strategyName} · {intent.timeframe} · #{intent.id}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">CONFIDENCE</span>
                <div className="w-24 h-1.5 bg-muted overflow-hidden">
                  <div
                    className={cn('h-full', intent.side === 'buy' ? 'bg-up' : 'bg-down')}
                    style={{ width: `${Math.round(intent.confidence * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] font-bold tabular-nums">{Math.round(intent.confidence * 100)}%</span>
              </div>
            </div>

            <div className="px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-3 border-b border-border text-[11px]">
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">REFERENCE</div>
                <div className="font-bold tabular-nums">{formatCompactPrice(intent.referencePrice)}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">QUANTITY</div>
                <div className="font-bold tabular-nums">{intent.quantity}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> STOP
                </div>
                <div className="font-bold tabular-nums text-down">{formatCompactPrice(intent.stopLoss)}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-1">
                  <Target className="w-3 h-3" /> TARGET
                </div>
                <div className="font-bold tabular-nums text-up">{formatCompactPrice(intent.takeProfit)}</div>
              </div>
            </div>

            <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
              {intent.thesis}
            </p>

            <div className="flex flex-col gap-2 border-t border-border px-4 py-3 md:flex-row md:items-center md:justify-between">
              <span className="text-[10px] text-muted-foreground">
                GENERATED {new Date(intent.createdAt).toLocaleString()}
                {intent.expiresAt && <> · EXPIRES {new Date(intent.expiresAt).toLocaleString()}</>}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => openReject(intent)}
                  disabled={reject.isPending || approve.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-border text-xs hover:bg-down/20 hover:text-down hover:border-down/40 transition-colors disabled:opacity-50"
                >
                  <XCircle className="w-3 h-3" />
                  REJECT
                </button>
                <button
                  onClick={() => handleApprove(intent.id)}
                  disabled={approve.isPending || reject.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/50 bg-primary/20 text-primary text-xs font-bold hover:bg-primary/30 transition-colors disabled:opacity-50"
                >
                  <CheckCircle className="w-3 h-3" />
                  APPROVE (PAPER)
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Decided history */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-widest text-muted-foreground">DECISIONS ON RECORD</h2>

        {decided.length === 0 && (
          <div className="p-6 border border-dashed border-border text-center text-muted-foreground text-xs">
            NOTHING DECIDED YET.
          </div>
        )}

        {decided.map(intent => {
          const styles = STATUS_STYLES[intent.status] ?? STATUS_STYLES.rejected;
          return (
            <div key={intent.id} className="border border-border bg-card p-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className={cn('flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold border', styles.className)}>
                    <styles.Icon className="w-3 h-3" />
                    {styles.label}
                  </span>
                  <span className={cn('font-bold', intent.side === 'buy' ? 'text-up' : 'text-down')}>
                    {intent.side.toUpperCase()}
                  </span>
                  <span className="font-bold">{intent.quantity} {intent.symbol}</span>
                  <span className="text-muted-foreground">@ {formatCompactPrice(intent.referencePrice)}</span>
                  <span className="text-[10px] text-muted-foreground">{intent.timeframe}</span>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {intent.decidedAt ? new Date(intent.decidedAt).toLocaleString() : new Date(intent.createdAt).toLocaleString()}
                  {intent.tradeId ? ` · TRADE #${intent.tradeId}` : ''}
                </span>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground line-clamp-2">{intent.thesis}</p>
              {intent.decisionNote && (
                <p className="text-[10px] text-muted-foreground">
                  <span className="text-foreground font-bold">NOTE: </span>
                  {intent.decisionNote}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <Dialog.Root
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open && !reject.isPending) closeReject();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-full max-w-lg translate-x-[-50%] translate-y-[-50%] border border-border bg-card p-6 shadow-lg font-mono">
            <Dialog.Title className="text-sm font-bold tracking-widest flex items-center gap-2 border-b border-border pb-3">
              <XCircle className="w-4 h-4 text-down" />
              REJECT INTENT
            </Dialog.Title>
            <Dialog.Description className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
              {rejectTarget
                ? `${rejectTarget.side.toUpperCase()} ${rejectTarget.symbol} · #${rejectTarget.id}. Nothing is simulated. Recording why keeps the decision auditable.`
                : ''}
            </Dialog.Description>

            <label htmlFor="reject-reason" className="block text-[10px] text-muted-foreground mt-4 mb-1">
              REASON (OPTIONAL)
            </label>
            <textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              autoFocus
              placeholder="e.g. Chasing a breakdown; waiting for a lower-high retest."
              className="w-full bg-input border border-border text-foreground px-3 py-2 text-xs focus:outline-none focus:border-primary resize-none"
            />
            <div className="text-[10px] text-muted-foreground text-right mt-1 tabular-nums">
              {reason.length}/500
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={closeReject}
                disabled={reject.isPending}
                className="px-3 py-1.5 border border-border text-xs hover:bg-muted transition-colors disabled:opacity-50"
              >
                CANCEL
              </button>
              <button
                onClick={submitReject}
                disabled={reject.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-down/50 bg-down/20 text-down text-xs font-bold hover:bg-down/30 transition-colors disabled:opacity-50"
              >
                {reject.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                {reject.isPending ? 'RECORDING…' : 'RECORD REJECTION'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
