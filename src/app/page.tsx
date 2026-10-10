import { connection } from "next/server";
import { listActiveRetailers, type RetailerDto } from "@/server/data/retailers";

// Connection check page: reads active retailers from Supabase on the server
// at request time. Only retailer names reach the browser.
export default async function Home() {
  // Must stay outside try/catch: it interrupts prerendering at build time
  // so Supabase is never read during `next build`.
  await connection();

  let retailers: RetailerDto[] | null;
  try {
    retailers = await listActiveRetailers();
  } catch (error) {
    // Log only the error class; messages may contain upstream details.
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[home] retailer load failed: ${errorName}`);
    retailers = null;
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold">セールカレンダー</h1>
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">接続確認</h2>
        {retailers === null ? (
          <p>ショップ情報を読み込めませんでした</p>
        ) : retailers.length === 0 ? (
          <p>現在利用可能なショップはありません</p>
        ) : (
          <>
            <p>利用可能なショップ</p>
            <ul className="list-disc pl-6">
              {retailers.map((retailer) => (
                <li key={retailer.slug}>{retailer.name}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
