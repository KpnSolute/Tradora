import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  useListAccounts,
  useConnectAccount,
  useDisconnectAccount,
  useGetAlpacaAccount,
  useListAlpacaPositions,
  useListAlpacaOrders,
  useCancelAlpacaOrder,
  useGetBrokerAccount,
  useGetBrokerPositions,
  useGetBrokerOrders,
  getListAccountsQueryKey,
  getGetAlpacaAccountQueryKey,
  getListAlpacaPositionsQueryKey,
  getListAlpacaOrdersQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Wallet, Plus, Unplug, CheckCircle, AlertTriangle,
  TrendingUp, TrendingDown, BarChart2, Clock, X,
  ShieldCheck, FlaskConical, ChevronDown, ChevronUp,
} from 'lucide-react';
import { cn, formatPrice, formatCompactPrice } from '@/lib/utils';

// ─── Exchange metadata ────────────────────────────────────────────────────────

const EXCHANGES = [
  { id: 'alpaca',   label: 'Alpaca',            abbr: 'AL', color: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10', keyLabel: 'API Key ID',   secretLabel: 'Secret Key',    secretPlaceholder: '••••••••••••••••••••', keyPlaceholder: 'PKXXXXXXXXXXXXXXXXXX', docsUrl: 'https://app.alpaca.markets/paper/dashboard/overview', info: ['Crypto + US Stocks & ETFs', 'Paper trading with $100K virtual funds', 'Free tier available'] },
  { id: 'coinbase', label: 'Coinbase',           abbr: 'CB', color: 'text-blue-400 border-blue-400/30 bg-blue-400/10',      keyLabel: 'CDP Key Name', secretLabel: 'EC Private Key (PEM)', secretPlaceholder: '-----BEGIN EC PRIVATE KEY-----', keyPlaceholder: 'organizations/xxx/apiKeys/yyy', docsUrl: 'https://www.coinbase.com/cloud/cloud-documentation/advanced-trade-api', info: ['Advanced Trade API (CDP keys)', 'BTC, ETH, and 400+ crypto pairs', 'Requires CDP API key with EC private key'] },
  { id: 'binance',  label: 'Binance',            abbr: 'BN', color: 'text-yellow-300 border-yellow-300/30 bg-yellow-300/10', keyLabel: 'API Key',      secretLabel: 'Secret Key',    secretPlaceholder: '••••••••••••••••••••', keyPlaceholder: 'Binance API Key', docsUrl: 'https://www.binance.com/en/my/settings/api-management', info: ['Spot trading, 350+ pairs', 'HMAC-SHA256 signing', 'Restrict to "Spot & Margin" only'] },
  { id: 'kraken',   label: 'Kraken',             abbr: 'KR', color: 'text-purple-400 border-purple-400/30 bg-purple-400/10', keyLabel: 'API Key',      secretLabel: 'Private Key (base64)', secretPlaceholder: '••••••••••••••••••••', keyPlaceholder: 'Kraken API Key', docsUrl: 'https://www.kraken.com/u/security/api', info: ['Spot & margin trading', 'HMAC-SHA512 nonce-based auth', 'Restrict to "Create & modify orders" only'] },
  { id: 'bybit',    label: 'Bybit',              abbr: 'BY', color: 'text-orange-400 border-orange-400/30 bg-orange-400/10', keyLabel: 'API Key',      secretLabel: 'API Secret',    secretPlaceholder: '••••••••••••••••••••', keyPlaceholder: 'Bybit API Key', docsUrl: 'https://www.bybit.com/app/user/api-management', info: ['Spot & USDT Perpetual', 'V5 API, HMAC-SHA256', 'Restrict to "Read + Trade" only'] },
] as const;

type ExchangeId = typeof EXCHANGES[number]['id'];

const connectSchema = z.object({
  exchange: z.enum(['alpaca', 'coinbase', 'binance', 'kraken', 'bybit']),
  label:     z.string().min(1, 'Label is required'),
  apiKey:    z.string().min(3, 'API Key is required'),
  apiSecret: z.string().min(3, 'API Secret is required'),
  mode:      z.enum(['paper', 'live']),
});
type ConnectForm = z.infer<typeof connectSchema>;

// ─── Alpaca-specific panel ────────────────────────────────────────────────────

function AlpacaPanel() {
  const { data: alpacaAccount, isLoading: acctLoading, error: acctError } = useGetAlpacaAccount();
  const { data: positions } = useListAlpacaPositions();
  const { data: orders }    = useListAlpacaOrders();
  const cancelOrder = useCancelAlpacaOrder();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');

  if (acctLoading) {
    return <div className="p-6 border border-border bg-card text-center text-muted-foreground text-xs">CONNECTING TO ALPACA...</div>;
  }
  if (acctError || !alpacaAccount) return null;

  const equityChange = alpacaAccount.portfolioValue - alpacaAccount.cash;
  const isLive = alpacaAccount.mode === 'live';

  return (
    <div className="flex flex-col gap-4 mt-2">
      <div className="p-4 border border-yellow-400/30 bg-yellow-400/5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-up animate-pulse" />
            <span className="text-xs font-bold tracking-widest text-yellow-400">
              ALPACA {isLive ? 'LIVE' : 'PAPER'} ACCOUNT
            </span>
          </div>
          <span className={cn('text-[10px] font-bold px-2 py-0.5 border', isLive ? 'bg-down/10 text-down border-down/30' : 'bg-up/10 text-up border-up/30')}>
            {isLive ? '⚡ LIVE TRADING' : '🧪 PAPER TRADING'}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div><div className="text-[10px] text-muted-foreground mb-1">PORTFOLIO VALUE</div><div className="font-bold text-lg truncate">{formatCompactPrice(alpacaAccount.portfolioValue)}</div></div>
          <div><div className="text-[10px] text-muted-foreground mb-1">EQUITY</div><div className="font-bold text-lg truncate">{formatCompactPrice(alpacaAccount.equity)}</div></div>
          <div><div className="text-[10px] text-muted-foreground mb-1">CASH</div><div className="font-bold text-lg truncate">{formatCompactPrice(alpacaAccount.cash)}</div></div>
          <div><div className="text-[10px] text-muted-foreground mb-1">BUYING POWER</div><div className="font-bold text-lg truncate">{formatCompactPrice(alpacaAccount.buyingPower)}</div></div>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex border-b border-border">
        {(['positions', 'orders'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={cn('px-4 py-2 text-xs font-bold tracking-widest transition-colors', tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground')}>
            {t.toUpperCase()} {t === 'positions' ? `(${positions?.length ?? 0})` : `(${orders?.length ?? 0})`}
          </button>
        ))}
      </div>

      {tab === 'positions' && (
        <div className="flex flex-col gap-2">
          {positions?.length === 0 && <div className="p-4 text-center text-muted-foreground text-xs border border-dashed border-border">NO OPEN POSITIONS</div>}
          {positions?.map(p => (
            <div key={p.symbol} className="p-3 border border-border bg-card grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <div><div className="text-[10px] text-muted-foreground mb-0.5">SYMBOL</div><div className="font-bold">{p.symbol}</div></div>
              <div><div className="text-[10px] text-muted-foreground mb-0.5">QTY</div><div className="font-bold">{p.qty.toFixed(4)}</div></div>
              <div><div className="text-[10px] text-muted-foreground mb-0.5">AVG COST</div><div className="font-bold">{formatPrice(p.avgEntryPrice)}</div></div>
              <div><div className="text-[10px] text-muted-foreground mb-0.5">CURRENT</div><div className="font-bold">{formatPrice(p.currentPrice)}</div></div>
              <div><div className="text-[10px] text-muted-foreground mb-0.5">P&L</div>
                <div className={cn('font-bold', p.unrealizedPl >= 0 ? 'text-up' : 'text-down')}>
                  {p.unrealizedPl >= 0 ? '+' : ''}{formatCompactPrice(p.unrealizedPl)} ({p.unrealizedPlPct.toFixed(2)}%)
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'orders' && (
        <div className="flex flex-col gap-2">
          {orders?.length === 0 && <div className="p-4 text-center text-muted-foreground text-xs border border-dashed border-border">NO RECENT ORDERS</div>}
          {orders?.map(o => (
            <div key={o.id} className="p-3 border border-border bg-card flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-4 flex-wrap">
                <span className={cn('font-bold', (o.side as string) === 'buy' ? 'text-up' : 'text-down')}>{(o.side as string).toUpperCase()}</span>
                <span className="font-bold">{o.symbol}</span>
                <span className="text-muted-foreground">{(typeof o.qty === 'number' ? o.qty : parseFloat(o.qty as string)).toFixed(4)}</span>
                <span className={cn('px-1.5 py-0.5 text-[9px] border', o.status === 'filled' ? 'bg-up/10 text-up border-up/30' : o.status === 'canceled' ? 'bg-muted text-muted-foreground border-border' : 'bg-yellow-400/10 text-yellow-400 border-yellow-400/30')}>{o.status.toUpperCase()}</span>
              </div>
              <div className="flex items-center gap-3">
                {(o.status === 'new' || o.status === 'partially_filled') && (
                  <button onClick={() => cancelOrder.mutate({ orderId: o.id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAlpacaOrdersQueryKey() }) })} className="px-2 py-1 border border-border hover:bg-down/20 hover:text-down text-[10px]">CANCEL</button>
                )}
                <span className="text-muted-foreground">{new Date(o.submittedAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Generic broker panel (Coinbase / Binance / Kraken / Bybit) ───────────────

function BrokerPanel({ exchange }: { exchange: string }) {
  const exchMeta = EXCHANGES.find(e => e.id === exchange);
  const { data: account, isLoading, error } = useGetBrokerAccount(exchange);
  const { data: positions } = useGetBrokerPositions(exchange);
  const { data: orders } = useGetBrokerOrders(exchange);
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');
  const [collapsed, setCollapsed] = useState(false);

  if (isLoading) return <div className="p-4 border border-border text-xs text-muted-foreground">LOADING {exchange.toUpperCase()}…</div>;
  if (error || !account) return null;

  return (
    <div className={cn('flex flex-col gap-3 border p-4', exchMeta?.color.replace('text-', 'border-') ?? 'border-border')}>
      {/* Header */}
      <button onClick={() => setCollapsed(c => !c)} className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-up animate-pulse" />
          <span className={cn('text-xs font-bold tracking-widest', exchMeta?.color.split(' ')[0] ?? 'text-primary')}>
            {exchange.toUpperCase()} {account.mode === 'live' ? 'LIVE' : 'PAPER'} ACCOUNT
          </span>
        </div>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div><div className="text-[10px] text-muted-foreground mb-1">PORTFOLIO VALUE</div><div className="font-bold text-lg">{formatCompactPrice(account.portfolioValue)}</div></div>
            <div><div className="text-[10px] text-muted-foreground mb-1">EQUITY</div><div className="font-bold text-lg">{formatCompactPrice(account.equity)}</div></div>
            <div><div className="text-[10px] text-muted-foreground mb-1">CASH</div><div className="font-bold text-lg">{formatCompactPrice(account.cash)}</div></div>
            <div><div className="text-[10px] text-muted-foreground mb-1">CURRENCY</div><div className="font-bold text-lg">{account.currency}</div></div>
          </div>

          <div className="flex border-b border-border mt-2">
            {(['positions', 'orders'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={cn('px-4 py-2 text-xs font-bold tracking-widest transition-colors', tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground')}>
                {t.toUpperCase()} {t === 'positions' ? `(${positions?.length ?? 0})` : `(${orders?.length ?? 0})`}
              </button>
            ))}
          </div>

          {tab === 'positions' && (
            <div className="flex flex-col gap-2">
              {positions?.length === 0 && <div className="p-3 text-center text-muted-foreground text-xs border border-dashed border-border">NO OPEN POSITIONS</div>}
              {positions?.map((p, i) => (
                <div key={i} className="p-3 border border-border bg-card grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                  <div><div className="text-[10px] text-muted-foreground mb-0.5">SYMBOL</div><div className="font-bold">{p.symbol}</div></div>
                  <div><div className="text-[10px] text-muted-foreground mb-0.5">QTY</div><div className="font-bold">{p.qty.toFixed(4)}</div></div>
                  <div><div className="text-[10px] text-muted-foreground mb-0.5">AVG COST</div><div className="font-bold">{formatPrice(p.avgEntryPrice)}</div></div>
                  <div><div className="text-[10px] text-muted-foreground mb-0.5">MKT VALUE</div><div className="font-bold">{formatCompactPrice(p.marketValue)}</div></div>
                  <div><div className="text-[10px] text-muted-foreground mb-0.5">P&L</div>
                    <div className={cn('font-bold', p.unrealizedPl >= 0 ? 'text-up' : 'text-down')}>
                      {p.unrealizedPl >= 0 ? '+' : ''}{formatCompactPrice(p.unrealizedPl)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'orders' && (
            <div className="flex flex-col gap-2">
              {orders?.length === 0 && <div className="p-3 text-center text-muted-foreground text-xs border border-dashed border-border">NO RECENT ORDERS</div>}
              {orders?.map((o, i) => (
                <div key={i} className="p-3 border border-border bg-card flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={cn('font-bold', o.side === 'buy' ? 'text-up' : 'text-down')}>{o.side.toUpperCase()}</span>
                    <span className="font-bold">{o.symbol}</span>
                    <span className="text-muted-foreground">{o.qty.toFixed(4)}</span>
                    <span className={cn('px-1.5 py-0.5 text-[9px] border', o.status === 'filled' ? 'bg-up/10 text-up border-up/30' : 'bg-muted text-muted-foreground border-border')}>{o.status.toUpperCase()}</span>
                  </div>
                  <span className="text-muted-foreground">{new Date(o.submittedAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Accounts() {
  const queryClient = useQueryClient();
  const { data: accounts } = useListAccounts();
  const connectAcc    = useConnectAccount();
  const disconnectAcc = useDisconnectAccount();

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<ConnectForm>({
    resolver: zodResolver(connectSchema),
    defaultValues: { exchange: 'alpaca', mode: 'paper' },
  });

  const selectedExchange = watch('exchange') as ExchangeId;
  const selectedMode     = watch('mode');
  const exchMeta = EXCHANGES.find(e => e.id === selectedExchange)!;

  const hasAlpaca = accounts?.some(a => a.exchange === 'alpaca' && a.status === 'active');
  const connectedNonAlpaca = accounts?.filter(a => a.exchange !== 'alpaca' && a.status === 'active') ?? [];

  const onSubmit = (data: ConnectForm) => {
    connectAcc.mutate(
      { data: { exchange: data.exchange, label: data.label.trim(), apiKey: data.apiKey.trim(), apiSecret: data.apiSecret.trim(), mode: data.mode } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAlpacaAccountQueryKey() });
          reset({ exchange: data.exchange, mode: 'paper' });
        },
      },
    );
  };

  const handleDisconnect = (id: number, exchange: string) => {
    if (!confirm(`Disconnect this ${exchange} account? Live positions will remain open.`)) return;
    disconnectAcc.mutate({ id }, {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() }); },
    });
  };

  const EXCHANGE_ABBR: Record<string, string> = { alpaca: 'AL', coinbase: 'CB', binance: 'BN', kraken: 'KR', bybit: 'BY' };

  return (
    <div className="flex flex-col gap-6 font-mono max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-lg font-bold tracking-widest flex items-center gap-2">
          <Wallet className="w-5 h-5 text-primary" />
          CONNECTED ACCOUNTS
        </h1>
        <div className="text-xs text-muted-foreground">
          {accounts?.filter(a => a.status === 'active').length ?? 0} CONNECTED
        </div>
      </div>

      {/* Live broker panels */}
      {hasAlpaca && <AlpacaPanel />}
      {connectedNonAlpaca.map(a => <BrokerPanel key={a.id} exchange={a.exchange} />)}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Account list */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <h2 className="text-sm font-bold tracking-widest text-muted-foreground">ACTIVE CONNECTIONS</h2>
          <div className="flex flex-col gap-3">
            {accounts?.length === 0 && (
              <div className="p-8 border border-dashed border-border text-center text-muted-foreground text-sm">
                NO ACCOUNTS CONNECTED. ADD YOUR BROKER API KEY TO ENABLE REAL TRADING.
              </div>
            )}
            {accounts?.map(acc => {
              const meta = EXCHANGES.find(e => e.id === acc.exchange);
              const abbr = EXCHANGE_ABBR[acc.exchange] ?? acc.exchange.slice(0, 2).toUpperCase();
              return (
                <div key={acc.id} className="p-4 border border-border bg-card flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className={cn('w-12 h-12 flex items-center justify-center shrink-0 border text-xs font-bold', acc.status === 'active' ? (meta?.color ?? 'text-up border-up/30 bg-up/10') : 'bg-muted text-muted-foreground border-border')}>
                      {abbr}
                    </div>
                    <div>
                      <div className="font-bold">{acc.label}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-1 flex-wrap">
                        <span className="uppercase">{acc.exchange}</span>
                        <span>·</span>
                        <span className={cn('px-1.5 py-0.5 border text-[9px] font-bold flex items-center gap-1', (acc as any).mode === 'live' ? 'bg-down/10 text-down border-down/30' : 'bg-primary/10 text-primary border-primary/30')}>
                          {(acc as any).mode === 'live' ? <><ShieldCheck className="w-2.5 h-2.5" /> LIVE</> : <><FlaskConical className="w-2.5 h-2.5" /> PAPER</>}
                        </span>
                        <span>·</span>
                        <span className={cn('flex items-center gap-1', acc.status === 'active' ? 'text-up' : acc.status === 'error' ? 'text-down' : '')}>
                          {acc.status === 'active' && <CheckCircle className="w-3 h-3" />}
                          {acc.status === 'error'  && <AlertTriangle className="w-3 h-3" />}
                          {acc.status.toUpperCase()}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between md:justify-end gap-6 border-t md:border-t-0 border-border pt-3 md:pt-0">
                    <div className="text-right">
                      <div className="text-[10px] text-muted-foreground mb-1">BALANCE</div>
                      <div className="font-bold">{acc.balance != null ? formatCompactPrice(acc.balance as unknown as number) : '---'}</div>
                    </div>
                    <button onClick={() => handleDisconnect(acc.id, acc.exchange)} className="flex items-center gap-1 px-3 py-1.5 border border-border hover:bg-destructive/20 hover:text-destructive hover:border-destructive/50 transition-colors text-xs">
                      <Unplug className="w-3 h-3" />
                      DISCONNECT
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Connect form */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold tracking-widest text-muted-foreground">CONNECT BROKER</h2>

          {/* Exchange selector */}
          <div className="grid grid-cols-5 border border-border">
            {EXCHANGES.map(e => (
              <label key={e.id} className={cn('flex flex-col items-center gap-1 py-2 cursor-pointer text-[9px] font-bold tracking-widest transition-colors', selectedExchange === e.id ? e.color : 'text-muted-foreground hover:bg-muted/50')}>
                <input type="radio" {...register('exchange')} value={e.id} className="sr-only" />
                <span className="text-sm">{e.abbr}</span>
                <span className="truncate w-full text-center px-0.5">{e.label.slice(0, 7)}</span>
              </label>
            ))}
          </div>

          {/* Mode selector (only Alpaca clearly distinguishes paper/live URL) */}
          <div className="grid grid-cols-2 gap-0 border border-border">
            {(['paper', 'live'] as const).map(m => (
              <label key={m} className={cn('flex flex-col items-center gap-1 p-3 cursor-pointer text-xs font-bold tracking-widest transition-colors', selectedMode === m ? m === 'live' ? 'bg-down/15 text-down' : 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/50')}>
                <input type="radio" {...register('mode')} value={m} className="sr-only" />
                {m === 'paper' ? <FlaskConical className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
                <span>{m === 'paper' ? 'PAPER TRADING' : 'LIVE TRADING'}</span>
              </label>
            ))}
          </div>

          <div className="p-5 border border-border bg-card">
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">ACCOUNT LABEL</label>
                <input {...register('label')} type="text" placeholder={`My ${exchMeta?.label ?? ''} Account`} className="w-full bg-input border border-border text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary" />
                {errors.label && <p className="text-down text-[10px] mt-1">{errors.label.message}</p>}
              </div>

              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">{exchMeta?.keyLabel ?? 'API KEY'}</label>
                <input {...register('apiKey')} type="text" placeholder={exchMeta?.keyPlaceholder} className="w-full bg-input border border-border text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary font-mono text-xs" autoComplete="off" />
                {errors.apiKey && <p className="text-down text-[10px] mt-1">{errors.apiKey.message}</p>}
              </div>

              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">{exchMeta?.secretLabel ?? 'SECRET KEY'}</label>
                <textarea {...register('apiSecret')} placeholder={exchMeta?.secretPlaceholder} rows={selectedExchange === 'coinbase' ? 5 : 1} className="w-full bg-input border border-border text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary font-mono text-xs resize-none" autoComplete="new-password" />
                {errors.apiSecret && <p className="text-down text-[10px] mt-1">{errors.apiSecret.message}</p>}
              </div>

              {connectAcc.error && (
                <div className="text-down text-[10px] p-2 bg-down/10 border border-down/30">
                  {(connectAcc.error as any)?.response?.data?.error ?? (connectAcc.error as any)?.message ?? 'Connection failed. Check your keys.'}
                </div>
              )}

              <div className="pt-2 text-[10px] text-muted-foreground leading-relaxed border-t border-border">
                <AlertTriangle className="w-3 h-3 inline mb-0.5 mr-1" />
                {selectedMode === 'live' ? 'LIVE mode uses real funds. Restrict keys to "Trading Only".' : 'PAPER mode simulates fills locally. Real keys still validated.'}
              </div>

              {exchMeta && (
                <div className="text-[10px] text-muted-foreground">
                  Keys at <a href={exchMeta.docsUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{new URL(exchMeta.docsUrl).hostname}</a>
                </div>
              )}

              <button type="submit" disabled={connectAcc.isPending} className={cn('w-full py-2.5 text-sm font-bold tracking-widest transition-colors disabled:opacity-50 mt-2 flex items-center justify-center gap-2 border', selectedMode === 'live' ? 'bg-down/20 text-down border-down/50 hover:bg-down/30' : 'bg-primary/20 text-primary border-primary/50 hover:bg-primary/30')}>
                <Plus className="w-4 h-4" />
                {connectAcc.isPending ? 'VALIDATING…' : `CONNECT ${exchMeta?.label.toUpperCase() ?? ''}`}
              </button>
            </form>
          </div>

          {/* Exchange info */}
          {exchMeta && (
            <div className="p-4 border border-border bg-card text-[10px] text-muted-foreground space-y-2">
              <div className="font-bold text-foreground text-xs mb-2">{exchMeta.label.toUpperCase()} SUPPORTS</div>
              {exchMeta.info.map((line, i) => (
                <div key={i} className="flex items-start gap-2"><BarChart2 className="w-3 h-3 mt-0.5 shrink-0 text-primary" />{line}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
