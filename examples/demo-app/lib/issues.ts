import { useEffect, useState } from 'react';
import type { Issue } from './types';

export function useIssues() {
  const [language, setLanguage] = useState('TypeScript');
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    fetch(`/api/issues?lang=${encodeURIComponent(language)}`).then(r => r.json()).then(setIssues);
  }, [language]);
  return { issues, language, setLanguage };
}

export function useMatchedIssues(): Issue[] {
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    fetch('/api/issues?matched=1').then(r => r.json()).then(setIssues);
  }, []);
  return issues;
}
