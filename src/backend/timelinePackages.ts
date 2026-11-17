import type {
  TimelinePackageImportRequestInput,
  TimelinePackageImportReceipt,
} from "../contracts/generated.ts";
import {
  ApiError,
  headers,
  json,
  responseError,
  storageRequest,
} from "./api.ts";
import {
  CreationClient,
  CreationCommandError,
  creationPath,
} from "./creationClient.ts";
import { tNow } from "../i18n/messages.ts";

export async function exportTimelinePackage(
  client: CreationClient,
  editorId: string,
  revision: number,
): Promise<Blob> {
  const response = await fetch(
    `/api${creationPath(client.id)}/timelines/${encodeURIComponent(editorId)}/package?revision=${revision}`,
    { headers },
  );
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

/** Keep this operation while retrying: neither target version nor upload identity changes. */
export class TimelinePackageImport {
  readonly operationId = crypto.randomUUID();
  readonly uploadHandle = crypto.randomUUID();
  private readonly client: CreationClient;
  private readonly file: File;
  private readonly target: { editorId: string; revision: number } | undefined;
  private request?: TimelinePackageImportRequestInput;
  private pending?: Promise<TimelinePackageImportReceipt>;
  constructor(
    client: CreationClient,
    file: File,
    target?: { editorId: string; revision: number },
  ) {
    this.client = client;
    this.file = file;
    this.target = target && { ...target };
  }
  run(): Promise<TimelinePackageImportReceipt> {
    if (this.pending) return this.pending;
    const pending = this.perform();
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => {});
    return pending;
  }
  private async query() {
    try {
      return await storageRequest<TimelinePackageImportReceipt>(
        `${creationPath(this.client.id)}/timeline-package-imports/${this.operationId}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  private async finish(receipt: TimelinePackageImportReceipt) {
    if (receipt.status === "rejected" && receipt.receipt)
      throw new CreationCommandError(receipt.receipt);
    if (receipt.status !== "applied")
      throw new Error(tNow("api.requestFailed", { status: 409 }));
    await this.client.refresh();
    return receipt;
  }
  private async perform(): Promise<TimelinePackageImportReceipt> {
    if (this.request) {
      const recovered = await this.query();
      if (recovered && recovered.status !== "registered")
        return this.finish(recovered);
    }
    if (!this.request) {
      const response = await fetch(
        `/api${creationPath(this.client.id)}/uploads/${this.uploadHandle}`,
        {
          method: "PUT",
          headers: {
            ...headers,
            "X-Asset-Name": encodeURIComponent(this.file.name),
            "X-Asset-Kind": "file",
          },
          body: this.file,
        },
      );
      if (!response.ok) throw await responseError(response);
      const uploaded = (await response.json()) as { fingerprint: string };
      this.request = {
        operationId: this.operationId,
        uploadHandle: this.uploadHandle,
        archiveFingerprint: uploaded.fingerprint,
        replaceEditorId: this.target?.editorId ?? null,
        expectedRevision: this.target?.revision ?? null,
      };
    }
    let receipt: TimelinePackageImportReceipt;
    try {
      receipt = await storageRequest<TimelinePackageImportReceipt>(
        `${creationPath(this.client.id)}/timeline-package-imports`,
        json("POST", this.request),
      );
    } catch (error) {
      const recovered = await this.query().catch(() => undefined);
      if (!recovered || recovered.status === "registered") throw error;
      receipt = recovered;
    }
    return this.finish(receipt);
  }
}
