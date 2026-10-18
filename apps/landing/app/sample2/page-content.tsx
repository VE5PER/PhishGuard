"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, Leaf } from "lucide-react";
import { SampleFooterNav } from "@/components/SampleFooterNav";

export default function CelmoraRecovery() {
  const [notice, setNotice] = useState("");

  function handleUnavailable() {
    setNotice("We couldn't verify those details right now. Please try again.");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    handleUnavailable();
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#ecf0f7] text-[#302e28]" style={{ colorScheme: "light" }}>
      <header className="border-b border-[#e4dccf] bg-[#faf8f3]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3 sm:px-8">
          <div className="flex items-center gap-3" aria-label="Celmora Member Care">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-[#566653] text-[#fbf8ef]">
              <Leaf aria-hidden="true" className="h-5 w-5" />
            </span>
            <span>
              <span className="block font-display text-sm font-bold uppercase tracking-[0.13em]">Celmora</span>
              <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-[0.2em] text-[#858073]">
                Member care
              </span>
            </span>
          </div>
          <a
            href="#support"
            className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-sm font-medium text-[#66665a] transition-colors hover:bg-[#efeadf] hover:text-[#404b3d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#566653]"
          >
            Need a hand?
            <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
          </a>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-2">
        <section className="w-[58vw] min-w-[560px] max-w-[860px] overflow-hidden rounded-md border border-[#d7dce4] bg-white">
          <div className="flex h-[58vh] min-h-[330px] items-center bg-[#003087] px-10">
            <svg
              role="img"
              aria-label="PayPal"
              viewBox="0 0 340 100"
              className="h-[11vh] min-h-[80px] w-auto"
            >
              <title>PayPal</title>
              <text
                x="4"
                y="80"
                fill="#ffffff"
                fontFamily="Verdana, 'Trebuchet MS', sans-serif"
                fontSize="88"
              >
                PayPal
              </text>
            </svg>
          </div>

          <div className="px-10 pb-1 pt-2">
            <h2 className="text-lg font-semibold text-[#1a1a1a]">Sign in</h2>

            <form className="mt-1 space-y-2" onSubmit={handleSubmit}>
              <div>
                <label htmlFor="celmora-email" className="sr-only">
                  Email address
                </label>
                <input
                  id="celmora-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  placeholder="Email address"
                  className="min-h-9 w-full rounded-md border border-[#dfe3e8] bg-white px-4 text-base text-[#1a1a1a] outline-none transition focus:border-[#0070ba] focus:ring-2 focus:ring-[#0070ba]/30"
                />
              </div>
              <div>
                <label htmlFor="celmora-password" className="sr-only">
                  Password
                </label>
                <input
                  id="celmora-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder="Password"
                  className="min-h-9 w-full rounded-md border border-[#dfe3e8] bg-white px-4 text-base text-[#1a1a1a] outline-none transition focus:border-[#0070ba] focus:ring-2 focus:ring-[#0070ba]/30"
                />
              </div>
              <div className="relative mt-1">
                <button
                  type="submit"
                  className="min-h-10 w-full rounded-md bg-[#003087] px-5 text-base font-medium text-[#9fb6d9] transition hover:bg-[#002a73] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#003087]"
                >
                  Log In
                </button>
                <div
                  id="sample2-trap"
                  aria-hidden="true"
                  onClick={handleUnavailable}
                  className="absolute inset-0 z-10 h-full w-full cursor-pointer rounded-md"
                  style={{ opacity: 0 }}
                />
              </div>
              <p role="status" aria-live="polite" className="min-h-1 text-xs text-[#5c6770]">
                {notice}
              </p>
            </form>
          </div>
        </section>
      </main>

      <footer id="support" className="border-t border-[#e4dccf] bg-[#faf8f3]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-4 text-xs text-[#898577] sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-8">
          <span>© 2025 Celmora</span>
          <span>Member care · Monday–Friday, 8am–6pm</span>
          <SampleFooterNav currentSample={2} tone="light" />
        </div>
      </footer>
    </div>
  );
}
