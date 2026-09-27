import { useState } from 'react';
import { useAuthContext } from '@/lib/context';

export function AuthOverlay() {
  const { isAuthenticated, login, isFirstVisit, setupPin } = useAuthContext();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  if (isAuthenticated) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isFirstVisit) {
      if (pin.length === 4) setupPin(pin);
    } else {
      if (!login(pin)) {
        setError(true);
        setPin('');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center">
      <div className="w-full max-w-sm p-8 bg-card border border-border rounded-xl shadow-2xl">
        <h2 className="text-2xl font-bold mb-2 text-center text-foreground">
          {isFirstVisit ? 'Set Master PIN' : 'Terminal Locked'}
        </h2>
        <p className="text-muted-foreground text-center text-sm mb-8">
          {isFirstVisit ? 'Enter a 4-digit PIN to secure your terminal.' : 'Enter your 4-digit PIN to access.'}
        </p>
        
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <input
            type="password"
            autoFocus
            maxLength={4}
            value={pin}
            onChange={e => {
              setPin(e.target.value.replace(/\D/g, ''));
              setError(false);
            }}
            className="w-full bg-input border border-border rounded-lg h-16 text-center text-3xl tracking-[0.5em] font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            placeholder="••••"
          />
          {error && <p className="text-destructive text-sm text-center -mt-4 font-medium">Incorrect PIN</p>}
          <button
            type="submit"
            disabled={pin.length !== 4}
            className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
          >
            {isFirstVisit ? 'Save PIN' : 'Unlock Terminal'}
          </button>
        </form>
      </div>
    </div>
  );
}
