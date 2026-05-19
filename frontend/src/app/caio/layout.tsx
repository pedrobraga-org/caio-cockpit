// Server-component layout that opts the entire /caio route out of static
// prerender + ISR. The /caio page is a client component; setting
// `dynamic = "force-dynamic"` directly on it doesn't always disable the
// build-time prerender in Next.js App Router, but setting it on the route's
// layout reliably does. This stops both the Next.js server-side prerender
// cache and Cloudflare's edge cache from serving an HTML shell that points at
// stale JS chunks after a fresh frontend deploy.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default function CaioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
