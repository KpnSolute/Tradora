import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useLogout, useListAccounts, getGetMeQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, LineChart, History, PieChart, Wallet, Settings, LogOut, Activity, Zap, Bot, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const { data: accounts } = useListAccounts();

  const [clock, setClock] = useState(() =>
    new Date().toISOString().replace('T', ' ').substring(0, 19)
  );

  useEffect(() => {
    const id = setInterval(() => {
      setClock(new Date().toISOString().replace('T', ' ').substring(0, 19));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const alpacaAccount = accounts?.find(a => a.exchange === 'alpaca' && a.status === 'active');
  const alpacaMode    = alpacaAccount ? (alpacaAccount as any).mode as string : null;

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setLocation('/login');
      }
    });
  };

  const navItems = [
    { href: '/agent-feed',      label: 'Agent Feed',         icon: Sparkles },
    { href: '/automations',     label: 'Automations',        icon: Bot },
    { href: '/dashboard',      label: 'Terminal',           icon: LayoutDashboard },
    { href: '/market/BTC-USDT',label: 'Markets',            icon: LineChart },
    { href: '/portfolio',      label: 'Portfolio',          icon: PieChart },
    { href: '/trades',         label: 'Trade History',      icon: History },
    { href: '/accounts',       label: 'Connected Accounts', icon: Wallet },
    { href: '/settings',       label: 'Settings',           icon: Settings },
  ];

  return (
    <div className="min-h-screen w-full flex bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <div className="w-16 md:w-64 border-r border-border flex flex-col justify-between shrink-0 bg-card z-10">
        <div className="flex flex-col">
          <div className="h-14 border-b border-border flex items-center justify-center md:justify-start px-4">
            <Activity className="w-6 h-6 text-primary" />
            <span className="ml-3 font-bold tracking-widest text-lg hidden md:block">TRADORA</span>
          </div>
          <nav className="flex flex-col gap-1 p-2">
            {navItems.map((item) => {
              const isMarkets = item.href.startsWith('/market/');
              const isActive = location === item.href ||
                (isMarkets && location.startsWith('/market/')) ||
                (!isMarkets && item.href !== '/dashboard' && location.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 transition-colors group",
                    isActive
                      ? "bg-primary/10 text-primary border-l-2 border-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground border-l-2 border-transparent"
                  )}
                  title={item.label}
                >
                  <item.icon className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-medium hidden md:block">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="p-2 border-t border-border">
          <div className="px-3 py-2 text-xs font-mono text-muted-foreground hidden md:flex flex-col gap-1 mb-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-up animate-pulse" />
              STATUS: ONLINE
            </div>
            <div className="truncate">USER: {user?.username.toUpperCase()}</div>
            {alpacaMode ? (
              <div className={cn('font-bold flex items-center gap-1', alpacaMode === 'live' ? 'text-down' : 'text-primary')}>
                <Zap className="w-3 h-3" />
                ALPACA {alpacaMode.toUpperCase()}
              </div>
            ) : (
              <div className={cn('font-bold', user?.tradingMode === 'real' ? 'text-down' : 'text-up')}>
                MODE: {user?.tradingMode.toUpperCase()}
              </div>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center md:justify-start gap-3 px-3 py-2.5 text-muted-foreground hover:text-destructive transition-colors group"
            title="Log Out"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            <span className="text-sm font-medium hidden md:block">Log Out</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-14 border-b border-border flex items-center px-6 justify-between bg-background shrink-0">
          <div className="flex items-center gap-4">
            <div className="text-xs font-mono text-muted-foreground tabular-nums">
              {clock} UTC
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Alpaca mode badge takes priority over settings mode */}
            {alpacaMode === 'live' && (
              <div className="px-2 py-0.5 border border-down/50 bg-down/10 text-down text-xs font-mono font-bold animate-pulse flex items-center gap-1">
                <Zap className="w-3 h-3" /> ALPACA LIVE
              </div>
            )}
            {alpacaMode === 'paper' && (
              <div className="px-2 py-0.5 border border-primary/50 bg-primary/10 text-primary text-xs font-mono font-bold flex items-center gap-1">
                <Zap className="w-3 h-3" /> ALPACA PAPER
              </div>
            )}
            {!alpacaMode && user?.tradingMode === 'real' && (
              <div className="px-2 py-0.5 border border-down/50 bg-down/10 text-down text-xs font-mono font-bold animate-pulse">
                REAL FUNDS ACTIVE
              </div>
            )}
            {!alpacaMode && user?.tradingMode === 'paper' && (
              <div className="px-2 py-0.5 border border-up/50 bg-up/10 text-up text-xs font-mono font-bold">
                PAPER TRADING
              </div>
            )}
          </div>
        </header>

        {/* Content Scroll Area */}
        <main className="flex-1 overflow-auto bg-background p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
