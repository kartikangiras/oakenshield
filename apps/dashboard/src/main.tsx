import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ToastProvider } from './components/ui.tsx';
import { LiveProvider } from './lib/live.tsx';
import { startExperiments } from './lib/experiments.ts';
import './styles/global.css';

// Start loading Flagsmith early so the Playground's A/B test is ready when a visitor gets there.
void startExperiments();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <LiveProvider>
        <App />
      </LiveProvider>
    </ToastProvider>
  </StrictMode>,
);
