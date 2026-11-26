import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '../src/styles.css';

export const metadata: Metadata = {
  title: 'PSI - API',
  description: 'Measure a public page with PageSpeed Insights and read the results.',
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#161a21',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
