import React, { useState, useEffect, useRef } from 'react';
import {
  useListAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  useListAccounts,
  useListMarkets,
  getListAutomationsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Zap, Plus, Trash2, CheckCircle, XCircle, Activity, AlertTriangle, RotateCcw } from 'lucide-react';
import { cn, formatCompactPrice } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth';
import { RuleFields, BROKER_LABELS, type RuleValue } from '@/components/rule-fields';

const STATUS_CONFIG: Record<string, { label: string; color: string; Icon: React.ElementType }> = {
  active:    { label: 'WATCHING',   color: 'text-primary',         Icon: Activity },
  triggered: { label: 'TRIGGERED',  color: 'text-yellow-400',      Icon: Zap },
  completed: { label: 'COMPLETED',  color: 'text-up',              Icon: CheckCircle },
  failed:    { label: 'FAILED',     color: 'text-down',            Icon: XCircle },
  cancelled: { label: 'CANCELLED',  color: 'text-muted-foreground', Icon: XCircle },
};

const EMPTY_RULE: RuleValue = {
  symbol: '',
  condition: 'lte',
  triggerPrice: 0,
  side: 'buy',
  quantity: 0,
  orderType: 'market',
  limitPrice: null,
  broker: 'paper',
};

export default function Automations() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: automations, isLoading } = useListAutomations({ query: { queryKey: getListAutomationsQueryKey(), refetchInterval: 5000 } });
  const { data: accounts } = useListAccounts();
  const { data: markets } = useListMarkets();
  const createAuto = useCreateAutomation();
  const deleteAuto = useDeleteAutomation();

  const connectedBrokers = new Set<string>(['paper']);
  accounts?.filter(a => a.status === 'active').forEach(a => connectedBrokers.add(a.exchange));
  const brokerOptions = Array.from(connectedBrokers);

  const [rule, setRule] = useState<RuleValue>(EMPTY_RULE);
  const [formError, setFormError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  // ── WebSocket: listen for real-time automation events ──────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyedRef = useRef(false);
  const userIdRef = useRef<number | null>(null);
  userIdRef.current = user?.id ?? null;

  useEffect(() => {
    destroyedRef.current = false;

    function connect() {
      if (destroyedRef.current) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Subscribe to ticker symbols (empty) so server stores our userId
        ws.send(JSON.stringify({ type: 'subscribe', symbols: [], userId: userIdRef.current }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'automation_fired') {
            queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
            toast({
              title: '⚡ Automation Fired',
              description: `${data.side?.toUpperCase()} ${data.quantity} ${data.symbol} rule executed successfully via ${data.broker}.`,
            });
          }

          if (data.type === 'automation_failed') {
            queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
            toast({
              title: '✗ Automation Failed',
              description: `${data.side?.toUpperCase()} ${data.quantity} ${data.symbol} — ${data.failureReason ?? 'Unknown error'}`,
              variant: 'destructive',
            });
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (!destroyedRef.current) {
          reconnectTimer.current = setTimeout(connect, 4000);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      destroyedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [queryClient]);

  // Default to a broker the user has actually connected, so the rule is created
  // against a real account instead of silently falling back to local paper fills.
  const connectedBrokerKey = accounts?.filter(a => a.status === 'active').map(a => a.exchange).join(',');
  useEffect(() => {
    const first = accounts?.find(a => a.status === 'active');
    if (first) setRule(r => ({ ...r, broker: first.exchange }));
  }, [connectedBrokerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!rule.symbol) return setFormError('Pick a symbol.');
    if (!(rule.triggerPrice > 0)) return setFormError('Trigger price must be positive.');
    if (!(rule.quantity > 0)) return setFormError('Quantity must be positive.');
    if (rule.orderType === 'limit' && !((rule.limitPrice ?? 0) > 0)) {
      return setFormError('A limit order needs a positive limit price.');
    }

    createAuto.mutate(
      {
        data: {
          symbol: rule.symbol,
          condition: rule.condition,
          triggerPrice: Number(rule.triggerPrice),
          side: rule.side,
          quantity: Number(rule.quantity),
          orderType: rule.orderType,
          limitPrice: rule.orderType === 'limit' ? Number(rule.limitPrice) : undefined,
          broker: rule.broker,
        } as any,
      },
      {
        onSuccess: () => {
          setRule({ ...EMPTY_RULE, broker: rule.broker });
          queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
        },
      },
    );
  };

  // Re-arm a rule that failed so it watches its trigger again; it fires on the
  // next tick that still matches.
  const handleRetry = async (id: number) => {
    setRetryingId(id);
    try {
      const res = await fetch(`/api/automations/${id}/retry`, { method: 'POST', credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: 'Could not retry rule',
          description: body?.error ?? 'Unknown error',
          variant: 'destructive',
        });
        return;
      }
      queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
      toast({
        title: 'Rule re-armed',
        description: `Watching ${body.symbol} again — fires when price ${body.condition === 'gte' ? '≥' : '≤'} ${formatCompactPrice(body.triggerPrice)}.`,
      });
    } catch (err) {
      toast({ title: 'Could not retry rule', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setRetryingId(null);
    }
  };

  const handleDelete = (id: number) => {
    if (!confirm('Cancel this automation rule?')) return;
    deleteAuto.mutate({ id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() }),
    });
  };

  const activeCount  = automations?.filter(a => a.status === 'active').length ?? 0;
  const firedCount   = automations?.filter(a => a.status === 'completed').length ?? 0;
  const failedCount  = automations?.filter(a => a.status === 'failed').length ?? 0;

  return (
    <div className="flex flex-col gap-6 font-mono max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-lg font-bold tracking-widest flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          AUTOMATIONS
        </h1>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="text-primary font-bold">{activeCount} WATCHING</span>
          <span className="text-up">{firedCount} COMPLETED</span>
          {failedCount > 0 && <span className="text-down">{failedCount} FAILED</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Rule list */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <h2 className="text-xs font-bold tracking-widest text-muted-foreground">ACTIVE RULES</h2>

          {isLoading && (
            <div className="p-6 text-center text-muted-foreground text-xs border border-dashed border-border">
              LOADING…
            </div>
          )}

          {!isLoading && automations?.length === 0 && (
            <div className="p-8 border border-dashed border-border text-center text-muted-foreground text-xs">
              NO AUTOMATION RULES. CREATE ONE TO GET STARTED.
            </div>
          )}

          {automations?.map(rule => {
            const cfg = STATUS_CONFIG[rule.status] ?? STATUS_CONFIG.active;
            const condLabel = rule.condition === 'gte' ? '≥' : '≤';
            return (
              <div key={rule.id} className={cn(
                "p-4 border bg-card flex flex-col md:flex-row md:items-center justify-between gap-3",
                rule.status === 'active' ? 'border-primary/30' : 'border-border',
              )}>
                <div className="flex items-start gap-4">
                  {/* Status icon */}
                  <div className={cn('w-8 h-8 flex items-center justify-center shrink-0 border', rule.status === 'active' ? 'border-primary/30 bg-primary/10' : 'border-border bg-muted')}>
                    <cfg.Icon className={cn('w-4 h-4', cfg.color)} />
                  </div>

                  <div className="flex flex-col gap-1 min-w-0">
                    {/* Rule description */}
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-bold">
                      <span className={cn(rule.side === 'buy' ? 'text-up' : 'text-down')}>
                        {rule.side.toUpperCase()}
                      </span>
                      <span>{rule.quantity}</span>
                      <span className="text-muted-foreground">{rule.symbol}</span>
                      <span className="text-muted-foreground text-xs">when price</span>
                      <span className="text-yellow-400">{condLabel} {formatCompactPrice(rule.triggerPrice)}</span>
                    </div>

                    {/* Meta row */}
                    <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                      <span className="uppercase font-bold text-primary/80">{BROKER_LABELS[rule.broker] ?? rule.broker}</span>
                      <span>·</span>
                      <span>{rule.orderType.toUpperCase()}</span>
                      {rule.limitPrice && <><span>·</span><span>LIMIT @ {formatCompactPrice(rule.limitPrice)}</span></>}
                      <span>·</span>
                      <span className={cfg.color + ' font-bold'}>{cfg.label}</span>
                      {rule.firedAt && (
                        <><span>·</span><span>FIRED {new Date(rule.firedAt).toLocaleString()}</span></>
                      )}
                    </div>

                    {/* Failure reason */}
                    {rule.status === 'failed' && rule.failureReason && (
                      <div className="flex items-center gap-1.5 text-[10px] text-down mt-0.5">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        <span className="truncate max-w-xs">{rule.failureReason}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {(rule.status === 'failed' || rule.status === 'triggered') && (
                    <button
                      onClick={() => handleRetry(rule.id)}
                      disabled={retryingId === rule.id}
                      className="flex items-center gap-1 px-3 py-1.5 border border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10 transition-colors text-xs disabled:opacity-50"
                      title="Re-arm this rule and try again"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {retryingId === rule.id ? 'RETRYING…' : 'RETRY'}
                    </button>
                  )}
                  {(rule.status === 'active') && (
                    <button
                      onClick={() => handleDelete(rule.id)}
                      disabled={deleteAuto.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 border border-border hover:bg-down/20 hover:text-down hover:border-down/40 transition-colors text-xs"
                      title="Cancel rule"
                    >
                      <Trash2 className="w-3 h-3" />
                      CANCEL
                    </button>
                  )}
                  {(rule.status !== 'active') && (
                    <button
                      onClick={() => handleDelete(rule.id)}
                      disabled={deleteAuto.isPending}
                      className="flex items-center gap-1 px-2 py-1.5 border border-border hover:bg-muted transition-colors text-xs text-muted-foreground"
                      title="Remove"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Create rule form */}
        <div className="flex flex-col gap-4">
          <h2 className="text-xs font-bold tracking-widest text-muted-foreground">NEW RULE</h2>

          <div className="p-5 border border-border bg-card">
            <form onSubmit={onSubmit} className="space-y-4">
              <RuleFields
                value={rule}
                onChange={patch => setRule(r => ({ ...r, ...patch }))}
                symbols={markets ?? []}
                brokers={brokerOptions}
              />

              <p className="text-[10px] text-muted-foreground">
                Triggers evaluate on the live crypto ticks this server streams; stock symbols need a price feed that isn't wired up yet.
              </p>

              {/* Preview */}
              <div className="p-3 bg-muted/30 border border-border text-[10px] text-muted-foreground leading-relaxed">
                <AlertTriangle className="w-3 h-3 inline mb-0.5 mr-1" />
                When price <strong className="text-foreground">{rule.condition === 'gte' ? '≥' : '≤'}</strong> trigger,
                place a <strong className="text-foreground">{rule.side} {rule.orderType}</strong> order
                via <strong className="text-foreground">{BROKER_LABELS[rule.broker] ?? rule.broker}</strong>.
                Rule fires <strong className="text-foreground">once</strong> and auto-completes.
              </div>

              {(formError || createAuto.error) && (
                <div className="text-down text-[10px] p-2 bg-down/10 border border-down/30">
                  {formError
                    ?? (createAuto.error as any)?.data?.error
                    ?? (createAuto.error as any)?.message
                    ?? 'Failed to create rule'}
                </div>
              )}

              <button
                type="submit"
                disabled={createAuto.isPending}
                className="w-full py-2.5 text-sm font-bold tracking-widest bg-primary/20 text-primary border border-primary/50 hover:bg-primary/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                {createAuto.isPending ? 'CREATING…' : 'CREATE RULE'}
              </button>
            </form>
          </div>

          {/* Info */}
          <div className="p-4 border border-border bg-card text-[10px] text-muted-foreground space-y-2">
            <div className="font-bold text-foreground text-xs mb-2">HOW IT WORKS</div>
            <div className="flex items-start gap-2"><Zap className="w-3 h-3 mt-0.5 shrink-0 text-primary" /> Rules fire the instant a live price tick crosses your trigger</div>
            <div className="flex items-start gap-2"><CheckCircle className="w-3 h-3 mt-0.5 shrink-0 text-up" /> Each rule fires once, then marks itself completed</div>
            <div className="flex items-start gap-2"><Activity className="w-3 h-3 mt-0.5 shrink-0 text-primary" /> Paper rules fill locally in the trade log, no broker contacted</div>
            <div className="flex items-start gap-2"><RotateCcw className="w-3 h-3 mt-0.5 shrink-0 text-yellow-400" /> A failed rule stays put until you retry it — RETRY re-arms it against the same trigger</div>
            <div className="flex items-start gap-2"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-yellow-400" /> Broker rules go through the execution gateway: dry-run unless live mode is on, capped at $1,000 per order</div>
          </div>
        </div>
      </div>
    </div>
  );
}
