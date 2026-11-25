/** A stable reference to a saved asset in a node's media fields.
 *
 * Object URLs depend on what this page has loaded, so they cannot describe
 * project content. This value stays the same before and after the bytes arrive
 * and is resolved only where media is displayed or read. */
const PREFIX = "opendirector-asset://";

export const assetSource = (projectId: string, assetId: string) =>
  `${PREFIX}${projectId}/${assetId}`;

export function parseAssetSource(src: string | null | undefined) {
  if (!src?.startsWith(PREFIX)) return undefined;
  const [projectId, assetId, extra] = src.slice(PREFIX.length).split("/");
  return projectId && assetId && extra === undefined
    ? { projectId, assetId }
    : undefined;
}
