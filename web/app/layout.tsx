import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '../src/styles.css';

/** A gauge in the accent colour, inline so the browser never asks the server for /favicon.ico. */
const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23161a21'/%3E%3Cpath d='M7 21a9 9 0 0 1 18 0' fill='none' stroke='%239aa8ff' stroke-width='3' stroke-linecap='round'/%3E%3Cpath d='M16 21l5-6' stroke='%23e4e7ec' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: 'PSI - API',
  description: 'Measure a public page with PageSpeed Insights and read the results.',
  icons: { icon: ICON },
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
