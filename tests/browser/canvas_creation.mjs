/** Create a node through the same tool and type picker used on the canvas. */
export async function addCanvasNode(page, label) {
  const toolbar = page.getByRole("toolbar", { name: /^(Canvas creation tools|画布创作工具)$/ });
  await toolbar.getByRole("button", { name: /^(Add node|添加节点)$/ }).click();
  const menu = page.getByRole("menu", { name: /^(New node|新建节点)$/ });
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
}
