import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { OpenHiggsfieldApp } from "@/openhiggsfield/openhiggsfield-app";

import "@/openhiggsfield/openhiggsfield.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-ohf-inter",
  display: "swap",
});

/* Title, description and the Open Graph block all come from the root, which
   already describes this surface. Only the canonical link is route-specific. */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/* Free models answer within the request that submits them; a short video can
   take a minute or more on a shared GPU. */
export const maxDuration = 300;

export default function OpenHiggsfieldPage() {
  return <OpenHiggsfieldApp fontClassName={inter.variable} />;
}
