// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { handleCloseRequest } from "./closeToTray.js";

describe("handleCloseRequest", () => {
  it("prevents the close and hides when minimize-to-tray is on", () => {
    const preventDefault = vi.fn();
    const hide = vi.fn();
    handleCloseRequest(true, { preventDefault, hide });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("lets the window close (no prevent/hide) when the setting is off", () => {
    const preventDefault = vi.fn();
    const hide = vi.fn();
    handleCloseRequest(false, { preventDefault, hide });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });
});
