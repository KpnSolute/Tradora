import React, { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useUpdateTradingMode, getGetMeQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon, ShieldAlert, BookOpen, AlertTriangle, ArrowRight, Zap } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { Link } from 'wouter';

interface ExecutionStatus {
  mode: string;
  liveEnabled: boolean;
  liveSource: string;
  killSwitchEngaged: boolean;
  maxNotionalUsd: number;
  dailyNotionalUsd: number;
  dailyNotionalUsedUsd: number;
}

export default function Settings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const updateMode = useUpdateTradingMode();

  const [execution, setExecution] = useState<ExecutionStatus | null>(null);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/execution/status', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(setExecution)
      .catch(() => setExecution(null));
  }, []);

  const setLiveExecution = async (enabled: boolean) => {
    if (enabled && !confirm('Turn on LIVE execution? Orders and automations will be sent to your connected broker with real funds. The kill switch and notional caps still apply.')) {
      return;
    }
    setExecutionBusy(true);
    setExecutionError(null);
    try {
      const res = await fetch('/api/execution/live-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setExecutionError(body?.error ?? 'Could not change live execution');
        return;
      }
      setExecution(body);
    } catch (err) {
      setExecutionError((err as Error).message);
    } finally {
      setExecutionBusy(false);
    }
  };

  const handleToggleMode = (mode: 'paper' | 'real') => {
    if (mode === user?.tradingMode) return;

    if (mode === 'real') {
      if (!confirm("WARNING: Switching to REAL mode will use connected exchange accounts and real funds. Are you sure?")) {
        return;
      }
    }

    updateMode.mutate({ data: { mode } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      }
    });
  };

  return (
    <div className="flex flex-col gap-8 font-mono max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-lg font-bold tracking-widest flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-primary" />
          SYSTEM SETTINGS
        </h1>
      </div>

      {/* Trading Mode Toggle */}
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-bold tracking-widest text-muted-foreground">TRADING ENVIRONMENT</h2>
        
        <div className="p-6 border border-border bg-card flex flex-col gap-6">
          
          <div className="flex bg-input border border-border p-1 relative">
            <button
              onClick={() => handleToggleMode('paper')}
              disabled={updateMode.isPending}
              className={cn(
                "flex-1 py-4 text-center font-bold tracking-widest transition-all z-10 flex flex-col items-center gap-2",
                user?.tradingMode === 'paper' ? "text-up" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <BookOpen className="w-6 h-6" />
              PAPER TRADING
            </button>
            <button
              onClick={() => handleToggleMode('real')}
              disabled={updateMode.isPending}
              className={cn(
                "flex-1 py-4 text-center font-bold tracking-widest transition-all z-10 flex flex-col items-center gap-2",
                user?.tradingMode === 'real' ? "text-down" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <ShieldAlert className="w-6 h-6" />
              REAL FUNDS
            </button>

            {/* Active background slider */}
            <div className={cn(
              "absolute top-1 bottom-1 w-[calc(50%-4px)] transition-all duration-300 pointer-events-none",
              user?.tradingMode === 'paper' ? "left-1 bg-up/10 border border-up/30" : "left-[calc(50%+2px)] bg-down/10 border border-down/30"
            )} />
          </div>

          {user?.tradingMode === 'real' ? (
            <div className="p-4 border border-down/50 bg-down/10 text-down text-sm flex gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <div>
                <div className="font-bold mb-1">REAL TRADING ACTIVE</div>
                <div className="text-down/80 text-xs leading-relaxed">
                  Orders placed will be routed to your connected exchange accounts and executed with real funds. 
                  Double check order quantities and prices. Market orders may experience slippage.
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4 border border-up/50 bg-up/10 text-up text-sm flex gap-3">
              <BookOpen className="w-5 h-5 shrink-0" />
              <div>
                <div className="font-bold mb-1">PAPER TRADING ACTIVE</div>
                <div className="text-up/80 text-xs leading-relaxed">
                  Orders are simulated using real-time market data but no real funds are at risk.
                  Use this environment to test strategies and build familiarity with the terminal.
                </div>
              </div>
            </div>
          )}

          {/* Note about Alpaca mode */}
          <div className="text-[10px] text-muted-foreground border-t border-border pt-4 leading-relaxed">
            <AlertTriangle className="w-3 h-3 inline mr-1 mb-0.5" />
            This toggle controls the default paper/real environment for <strong>internal trades</strong>.
            If you have connected an Alpaca account, orders on the market page are routed through Alpaca's own paper or live mode,
            regardless of this setting.{' '}
            <Link href="/accounts" className="text-primary hover:underline inline-flex items-center gap-0.5">
              Manage Alpaca <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>

      {/* Execution gateway */}
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-bold tracking-widest text-muted-foreground">EXECUTION GATEWAY</h2>
        <div className="p-6 border border-border bg-card flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs text-muted-foreground mb-1">ORDER ROUTING</div>
              <div className={cn('text-lg font-bold tracking-tight', execution?.liveEnabled ? 'text-down' : 'text-up')}>
                {execution
                  ? execution.liveEnabled
                    ? 'LIVE — ORDERS REACH THE BROKER'
                    : 'DRY RUN — NOTHING IS SENT'
                  : '---'}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {execution?.liveSource === 'env' ? 'ENABLED BY THE SERVER ENVIRONMENT' : 'CONTROLLED PER ACCOUNT'}
              </div>
            </div>
            <button
              onClick={() => setLiveExecution(!execution?.liveEnabled)}
              disabled={executionBusy || !execution || execution?.killSwitchEngaged}
              className={cn(
                'px-4 py-2 text-[11px] font-bold tracking-widest border transition-colors disabled:opacity-50 flex items-center gap-2',
                execution?.liveEnabled
                  ? 'bg-up/10 text-up border-up/50 hover:bg-up/20'
                  : 'bg-down/10 text-down border-down/50 hover:bg-down/20',
              )}
            >
              <Zap className="w-3.5 h-3.5" />
              {executionBusy ? 'WORKING...' : execution?.liveEnabled ? 'TURN LIVE OFF' : 'TURN LIVE ON'}
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-t border-border pt-4">
            {[
              { label: 'KILL SWITCH', value: execution?.killSwitchEngaged ? 'ENGAGED' : 'RELEASED' },
              { label: 'MAX / ORDER', value: execution ? formatPrice(execution.maxNotionalUsd, 0) : '---' },
              { label: 'DAILY CAP', value: execution ? formatPrice(execution.dailyNotionalUsd, 0) : '---' },
              { label: 'USED TODAY', value: execution ? formatPrice(execution.dailyNotionalUsedUsd, 2) : '---' },
            ].map(item => (
              <div key={item.label}>
                <div className="text-[10px] text-muted-foreground mb-1">{item.label}</div>
                <div className="text-sm font-bold">{item.value}</div>
              </div>
            ))}
          </div>

          {executionError && (
            <div className="text-down text-[10px] p-2 bg-down/10 border border-down/30">{executionError}</div>
          )}

          <p className="text-[10px] text-muted-foreground border-t border-border pt-3 leading-relaxed">
            Live orders need a live-connected broker account and this switch. The kill switch blocks every intent, paper included;
            per-order and daily notional caps apply to every broker-bound order and automation.
          </p>
        </div>
      </div>

      {/* Account Info */}
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-bold tracking-widest text-muted-foreground">OPERATOR INFO</h2>
        <div className="p-4 border border-border bg-card">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-muted-foreground mb-1">USERNAME</div>
              <div className="font-bold text-lg">{user?.username}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">SYSTEM ID</div>
              <div className="font-mono text-muted-foreground">OP-{user?.id.toString().padStart(4, '0')}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">JOINED</div>
              <div className="font-mono text-muted-foreground">
                {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '---'}
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
