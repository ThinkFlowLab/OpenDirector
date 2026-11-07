/** Apply the layer studio and wait until the editor has consumed its receipt.
 *
 * The apply button renames itself to "Processing…" while the save is in
 * flight, and `waitFor({ state: "hidden" })` treats a missing element as
 * hidden: that wait returns immediately, so a following reload can restore the
 * pending delivery from sessionStorage, and the next apply then resolves the
 * previous edit instead of the new draft. The studio dialog detaches only
 * after the acknowledgement has been applied, so wait for that instead.
 */
export async function applyLayers(page) {
  await page
    .getByRole("button", { name: "Apply to canvas", exact: true })
    .click();
  await page.locator(".lb-dialog").waitFor({ state: "detached" });
}
