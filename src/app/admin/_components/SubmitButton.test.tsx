import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useFormStatus } = vi.hoisted(() => ({ useFormStatus: vi.fn() }));
vi.mock("react-dom", async (importOriginal) => ({ ...(await importOriginal<object>()), useFormStatus }));

const { SubmitButton, SUBMIT_PENDING_LABEL } = await import("./SubmitButton");

const CLASS = "rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white";

function render() {
  return renderToStaticMarkup(<SubmitButton className={CLASS}>登録する</SubmitButton>);
}

afterEach(() => {
  useFormStatus.mockReset();
});

describe("SubmitButton", () => {
  it("is an enabled submit button with its own label while idle", () => {
    useFormStatus.mockReturnValue({ pending: false, data: null, method: null, action: null });

    expect(render()).toBe(`<button type="submit" aria-busy="false" class="${CLASS}">登録する</button>`);
  });

  it("is disabled and says 処理中… while its form is being submitted", () => {
    useFormStatus.mockReturnValue({ pending: true, data: new FormData(), method: "post", action: () => {} });

    expect(SUBMIT_PENDING_LABEL).toBe("処理中…");
    expect(render()).toBe(
      `<button type="submit" disabled="" aria-busy="true" class="${CLASS}">${SUBMIT_PENDING_LABEL}</button>`,
    );
  });

  it("keeps the caller's classes unchanged in both states", () => {
    for (const pending of [false, true]) {
      useFormStatus.mockReturnValue({ pending });
      expect(render()).toContain(`class="${CLASS}"`);
    }
  });
});
