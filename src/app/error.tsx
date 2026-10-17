"use client";

import Link from "next/link";

// Error boundary for every route segment (the third approved Client
// Component, Phase 6P; admin-security.test.ts pins this). It shows a fixed,
// generic message: the error's message, digest and stack are never rendered
// or logged here (the server logs the original error). retry() re-fetches
// and re-renders the segment (stable since Next.js 16.3).
export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-10">
      <section role="alert" className="flex flex-col gap-3 rounded-2xl bg-white px-4 py-6 text-center shadow-sm">
        <h1 className="text-xl font-bold">エラーが発生しました</h1>
        <p className="text-sm text-foreground/70">ページを正常に表示できませんでした。</p>
      </section>
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white"
      >
        もう一度試す
      </button>
      <Link
        href="/"
        className="rounded-xl border border-blue-500 bg-white px-4 py-2.5 text-center text-[15px] font-semibold text-blue-500"
      >
        ホームへ戻る
      </Link>
    </main>
  );
}
