'use client';
import { useEffect } from 'react';
import flagsmith from '@flagsmith/flagsmith';

/** Sends github_connected once per visitor, after the GitHub sign-in round trip. */
export function GitHubReturn({ signedIn }: { signedIn: boolean }) {
  useEffect(() => {
    if (!signedIn || localStorage.getItem('fp_gc_sent')) return;
    flagsmith.trackEvent('github_connected');
    localStorage.setItem('fp_gc_sent', '1');
  }, [signedIn]);
  return null;
}
