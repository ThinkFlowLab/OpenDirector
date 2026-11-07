/** Shared model picker driver for node composers. */
export async function chooseGenerationModel(page, choice) {
  const label = await page.locator("html").getAttribute("lang") === "en-US" ? "Generation model" : "生成模型";
  await page.getByRole("combobox", { name: label, exact: true }).click();
  const list = page.getByRole("listbox", { name: label, exact: true });
  if (typeof choice === "string")
    await list.locator(`[data-option-id="${choice}"]`).click();
  else await list.getByRole("option", { name: choice.label, exact: true }).click();
}
