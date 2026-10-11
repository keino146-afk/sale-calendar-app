import { logoutAction } from "../actions";

export function AdminHeader() {
  return (
    <header className="flex items-center justify-between">
      <h1 className="text-2xl font-bold">管理画面</h1>
      <form action={logoutAction}>
        <button
          type="submit"
          className="rounded-full border border-black/10 bg-white px-4 py-1.5 text-sm font-medium"
        >
          ログアウト
        </button>
      </form>
    </header>
  );
}
