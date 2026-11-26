'use client';
import flagsmith from '@flagsmith/flagsmith';
import { FlagsmithProvider } from '@flagsmith/flagsmith/react';
import { getVisitorId, isReturningVisitor } from '../lib/visitor';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <FlagsmithProvider
      flagsmith={flagsmith}
      options={{
        environmentID: process.env.NEXT_PUBLIC_FLAGSMITH_ENV_KEY!,
        identity: getVisitorId(),
        traits: { visitor_type: isReturningVisitor() ? 'returning' : 'new', locale: navigator.language },
        enableEvents: true,
      }}
    >
      {children}
    </FlagsmithProvider>
  );
}
