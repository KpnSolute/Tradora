import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRegister, getGetMeQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { Activity } from 'lucide-react';

const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type RegisterForm = z.infer<typeof registerSchema>;

export default function Register() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const registerMutation = useRegister();

  const { register, handleSubmit, formState: { errors } } = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = (data: RegisterForm) => {
    registerMutation.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        setLocation('/dashboard');
      }
    });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center font-mono">
      <div className="w-full max-w-md p-8 border border-border bg-card">
        <div className="flex flex-col items-center mb-8">
          <Activity className="w-12 h-12 text-primary mb-4" />
          <h1 className="text-2xl font-bold tracking-widest text-foreground">TRADORA</h1>
          <div className="text-xs text-muted-foreground mt-2">NEW OPERATOR REGISTRATION</div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">USERNAME</label>
            <input
              {...register('username')}
              type="text"
              className="w-full bg-input border border-border text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              placeholder="new_operator"
              autoComplete="username"
            />
            {errors.username && <p className="text-down text-xs mt-1">{errors.username.message}</p>}
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">PASSWORD</label>
            <input
              {...register('password')}
              type="password"
              className="w-full bg-input border border-border text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all"
              placeholder="••••••••"
              autoComplete="new-password"
            />
            <p className="text-[10px] text-muted-foreground mt-1">Minimum 6 characters</p>
            {errors.password && <p className="text-down text-xs mt-1">{errors.password.message}</p>}
          </div>

          {registerMutation.error && (
            <div className="p-3 border border-down/50 bg-down/10 text-down text-sm">
              {registerMutation.error.data?.error || 'Registration failed'}
            </div>
          )}

          <button
            type="submit"
            disabled={registerMutation.isPending}
            className="w-full bg-primary text-primary-foreground py-2 text-sm font-bold tracking-widest hover:bg-primary/90 transition-colors disabled:opacity-50 mt-4"
          >
            {registerMutation.isPending ? 'CREATING CREDENTIALS...' : 'REGISTER'}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-muted-foreground">
          EXISTING OPERATOR? <Link href="/login" className="text-primary hover:underline">RETURN TO LOGIN</Link>
        </div>
      </div>
    </div>
  );
}
