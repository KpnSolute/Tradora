import React, { useEffect } from 'react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider, useAuth } from '@/lib/auth';
import { Layout } from '@/components/layout';

import Login from '@/pages/login';
import Register from '@/pages/register';
import Landing from '@/pages/landing';
import Dashboard from '@/pages/dashboard';
import Market from '@/pages/market';
import Trades from '@/pages/trades';
import Portfolio from '@/pages/portfolio';
import Accounts from '@/pages/accounts';
import Automations from '@/pages/automations';
import RuleBuilder from '@/pages/rule-builder';
import AgentFeed from '@/pages/agent-feed';
import Settings from '@/pages/settings';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

/**
 * Auth-guarded layout shell. Wraps all protected pages.
 * Rendered as a catch-all Route with no path so Wouter does NOT
 * strip any path prefix — child routes still see the full pathname.
 */
function ProtectedArea() {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation('/login');
    }
  }, [isLoading, isAuthenticated, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground font-mono">
        INITIALIZING TERMINAL...
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <Layout>
      <Switch>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/market/:symbol" component={Market} />
        <Route path="/trades" component={Trades} />
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/accounts" component={Accounts} />
        <Route path="/automations" component={Automations} />
        <Route path="/rule-builder" component={RuleBuilder} />
        <Route path="/agent-feed" component={AgentFeed} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      {/*
        No path → catch-all that does NOT change the routing context.
        ProtectedArea's inner Switch sees the full pathname unchanged.
      */}
      <Route component={ProtectedArea} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
