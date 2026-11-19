import React from 'react';
import { cn } from '@/lib/utils';

export interface RuleValue {
  symbol: string;
  condition: 'gte' | 'lte';
  triggerPrice: number;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: 'market' | 'limit';
  limitPrice?: number | null;
  broker: string;
}

export const BROKER_LABELS: Record<string, string> = {
  paper: 'Paper (local fills)',
  alpaca: 'Alpaca',
  coinbase: 'Coinbase',
  binance: 'Binance',
  kraken: 'Kraken',
  bybit: 'Bybit',
};

interface RuleFieldsProps {
  value: RuleValue;
  onChange: (patch: Partial<RuleValue>) => void;
  symbols: Array<{ symbol: string }>;
  brokers: string[];
  disabled?: boolean;
}

const label = 'block text-[10px] text-muted-foreground mb-1';
const input = 'w-full bg-input border border-border text-foreground px-2 py-1.5 text-xs focus:outline-none focus:border-primary';

/**
 * The single rule form used by the Automations page and the AI Rule Builder.
 * Controlled: the parent owns the rule and receives patches.
 */
export function RuleFields({ value, onChange, symbols, brokers, disabled = false }: RuleFieldsProps) {
  const symbolKnown = symbols.some(s => s.symbol === value.symbol);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className={label}>SYMBOL</label>
        <select
          value={value.symbol}
          onChange={e => onChange({ symbol: e.target.value })}
          disabled={disabled}
          className={cn(input, 'appearance-none')}
        >
          {!symbolKnown && <option value={value.symbol}>{value.symbol || 'Select symbol…'}</option>}
          {symbols.map(s => (
            <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={label}>EXECUTE VIA</label>
        <select
          value={value.broker}
          onChange={e => onChange({ broker: e.target.value })}
          disabled={disabled}
          className={cn(input, 'appearance-none')}
        >
          {brokers.map(b => (
            <option key={b} value={b}>{BROKER_LABELS[b] ?? b}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={label}>WHEN PRICE</label>
        <select
          value={value.condition}
          onChange={e => onChange({ condition: e.target.value as RuleValue['condition'] })}
          disabled={disabled}
          className={cn(input, 'appearance-none')}
        >
          <option value="lte">≤ drops to</option>
          <option value="gte">≥ rises to</option>
        </select>
      </div>

      <div>
        <label className={label}>TRIGGER PRICE ($)</label>
        <input
          type="number"
          step="any"
          value={value.triggerPrice === 0 ? '' : value.triggerPrice}
          placeholder="0.00"
          onChange={e => onChange({ triggerPrice: Number(e.target.value) })}
          disabled={disabled}
          className={input}
        />
      </div>

      <div>
        <label className={label}>ACTION</label>
        <div className="grid grid-cols-2 gap-0 border border-border">
          {(['buy', 'sell'] as const).map(s => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ side: s })}
              className={cn(
                'py-2 text-xs font-bold tracking-widest transition-colors disabled:opacity-50',
                value.side === s
                  ? s === 'buy' ? 'bg-up/20 text-up' : 'bg-down/20 text-down'
                  : 'text-muted-foreground hover:bg-muted/50',
              )}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={label}>QUANTITY</label>
        <input
          type="number"
          step="any"
          value={value.quantity === 0 ? '' : value.quantity}
          placeholder="0.001"
          onChange={e => onChange({ quantity: Number(e.target.value) })}
          disabled={disabled}
          className={input}
        />
      </div>

      <div>
        <label className={label}>ORDER TYPE</label>
        <div className="grid grid-cols-2 gap-0 border border-border">
          {(['market', 'limit'] as const).map(t => (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ orderType: t })}
              className={cn(
                'py-2 text-xs font-bold tracking-widest transition-colors disabled:opacity-50',
                value.orderType === t ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/50',
              )}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {value.orderType === 'limit' && (
        <div>
          <label className={label}>LIMIT PRICE ($)</label>
          <input
            type="number"
            step="any"
            value={value.limitPrice ?? ''}
            onChange={e => onChange({ limitPrice: Number(e.target.value) })}
            disabled={disabled}
            className={input}
          />
        </div>
      )}
    </div>
  );
}
