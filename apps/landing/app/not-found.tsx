import Link from "next/link";
import { ShieldAlert, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-ink-950 text-white flex items-center justify-center p-6 text-center">
      <div className="max-w-md p-8 rounded-2xl border border-white/10 bg-ink-900">
        <div className="w-14 h-14 rounded-xl border border-quarantine/40 flex items-center justify-center text-quarantine mx-auto mb-6">
          <ShieldAlert className="w-7 h-7" />
        </div>
        <h1 className="text-3xl font-display font-bold text-white mb-2">404: Threat Target Missing</h1>
        <p className="text-base text-white/60 font-body mb-6 leading-relaxed">
          The requested resource was not located on this gateway endpoint.
        </p>
        <Button asChild variant="default" className="gap-2 rounded-full">
          <Link href="/">
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Defense Command</span>
          </Link>
        </Button>
      </div>
    </main>
  );
}
