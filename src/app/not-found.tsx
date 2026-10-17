import Link from "next/link";
import { SiteFooter } from "@/components/SiteFooter";

// Shown for unknown URLs and for notFound() (e.g. a sale that is not
// published). Fixed text only. Next.js adds <meta name="robots"
// content="noindex"> to 404 responses itself, so no metadata is set here.
export default function NotFound() {
  return (
    <>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-10">
        <section className="flex flex-col gap-3 rounded-2xl bg-white px-4 py-6 text-center shadow-sm">
          <p className="text-sm font-semibold text-foreground/60">404</p>
          <h1 className="text-xl font-bold">ページが見つかりません</h1>
          <p className="text-sm text-foreground/70">
            お探しのページは削除されたか、URLが変更された可能性があります。
          </p>
        </section>
        <nav aria-label="移動先" className="flex flex-col gap-2">
          <Link href="/" className="rounded-xl bg-blue-500 px-4 py-2.5 text-center text-[15px] font-semibold text-white">
            ホームへ戻る
          </Link>
          <Link
            href="/calendar"
            className="rounded-xl border border-blue-500 bg-white px-4 py-2.5 text-center text-[15px] font-semibold text-blue-500"
          >
            カレンダーを見る
          </Link>
        </nav>
      </main>
      <SiteFooter />
    </>
  );
}
