import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import WebflowRuntime from '@/components/WebflowRuntime';

const TITLE = 'Avande – Webflow HTML Website Template';
const DESCRIPTION =
  'Avande is an AI automation agency Webflow HTML template with sleek, modern layouts, built-in CMS, and everything needed to launch an AI consulting site.';
const OG_IMAGE =
  'https://cdn.prod.website-files.com/6a901794a3ca5e0a74527dde/6ab3d20c80b4731f8cd81039_Thumbnail%20(1).jpg';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, images: [OG_IMAGE], type: 'website' },
  twitter: { title: TITLE, description: DESCRIPTION, card: 'summary_large_image' },
  icons: {
    icon: [
      { url: '/assets/6a9017ffbec05cea75b003a3_favicon.jpg', type: 'image/png', sizes: '32x32', media: '(prefers-color-scheme: light)' },
      { url: '/assets/6a9017ffbec05cea75b003a3_favicon.jpg', type: 'image/png', sizes: '32x32', media: '(prefers-color-scheme: dark)' },
      { url: '/assets/6a9017ffe18b75aa9bb0ae7f_favicon.jpg', type: 'image/png', sizes: '48x48' },
      { url: '/assets/6a9017ff536fd94c3e01ea9a_favicon.jpg', type: 'image/png', sizes: '192x192' },
      { url: '/assets/6a9017ff9e1be6ec772784d7_favicon.jpg', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/assets/6a9017ff8adac152a38892e5_favicon.jpg', sizes: '180x180' }],
  },
};

// Same two inline scripts Webflow puts in <head>: load the Google fonts, and flag
// <html> with w-mod-js so ix-initial-state.css can hide elements until IX3 boots.
const WEBFONT_LOAD =
  'WebFont.load({  google: {    families: ["Inter Tight:100,200,300,400,500,600,700,800,900","Stack Sans Notch:200,300,400,500,600,700"]  }});';
const W_MOD =
  '!function(o,c){var n=c.documentElement,t=" w-mod-";n.className+=t+"js",("ontouchstart"in o||o.DocumentTouch&&c instanceof DocumentTouch)&&(n.className+=t+"touch")}(window,document);';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The head scripts and the Webflow runtime add classes to <html> (w-mod-js, wf-active, lenis...).
    // Webflow's data-wf-domain="avande-template.webflow.io" is left out on purpose: off that
    // hostname it makes webflow.js append a "Made in Webflow" badge the original page doesn't show.
    <html
      data-wf-page="6a901794a3ca5e0a74527ddb"
      data-wf-site="6a901794a3ca5e0a74527dde"
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <link href="/css/avande.webflow.css" rel="stylesheet" type="text/css" />
        <link href="/css/ix-initial-state.css" rel="stylesheet" type="text/css" />
        <link href="https://fonts.googleapis.com" rel="preconnect" />
        <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
        <script src="/js/webfont.js" type="text/javascript" />
        <script type="text/javascript" dangerouslySetInnerHTML={{ __html: WEBFONT_LOAD }} />
        <script type="text/javascript" dangerouslySetInnerHTML={{ __html: W_MOD }} />
      </head>
      <body>
        {children}
        <WebflowRuntime />
      </body>
    </html>
  );
}
