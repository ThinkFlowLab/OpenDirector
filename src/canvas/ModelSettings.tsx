import { useState } from "react";
import { errorMessage } from "../backend/api.ts";
import { MODEL_KINDS, type BackendModels } from "../backend/models.ts";
import type { ModelConfig } from "../backend/rules.ts";
import { ModelServiceForm, type SettingsModelKind } from "./ModelServiceForm";
import { CanvasIcon } from "./CanvasIcon";
import "./model-settings.css";

export function ModelSettings({ catalog }: { catalog: BackendModels }) {
  const [category, setCategory] = useState<SettingsModelKind>("agent");
  const [editing, setEditing] = useState<{
    kind: SettingsModelKind;
    model?: ModelConfig;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await catalog.removeService(id);
      setDeleting(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const models = catalog.models.filter(
    (model) =>
      model.kind === category ||
      ((category === "image" || category === "video") &&
        model.kind === "vision"),
  );
  const services = models.filter(
    (model, index) =>
      !model.providerId ||
      models.findIndex((item) => item.providerId === model.providerId) ===
        index,
  );
  return (
    <div className="cw-model-settings">
      {!catalog.connected && (
        <div className="cw-settings-notice" role="alert">
          <span>{catalog.error || "无法读取模型配置。"}</span>
          <button
            className="cw-settings-button"
            onClick={() => void catalog.refresh()}
          >
            重新读取
          </button>
        </div>
      )}
      {catalog.connected &&
        (editing ? (
          <ModelServiceForm
            key={editing.model?.id ?? editing.kind}
            kind={editing.kind}
            existing={editing.model}
            catalog={catalog}
            onClose={() => setEditing(null)}
          />
        ) : (
          <>
            <nav className="cw-model-categories" aria-label="模型用途">
              {MODEL_KINDS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={category === item.id}
                  onClick={() => {
                    setCategory(item.id);
                    setDeleting(null);
                    setError("");
                  }}
                >
                  {item.label.replace("生成", "").replace("对话 Agent", "对话")}
                </button>
              ))}
            </nav>
            <div className="cw-model-overview-heading">
              <div>
                <h3>
                  服务连接 <span>{services.length}</span>
                </h3>
                <p>管理服务地址、鉴权和已启用模型。</p>
              </div>
              {services.length > 0 && (
                <button
                  className="cw-settings-button cw-settings-button-primary"
                  onClick={() => setEditing({ kind: category })}
                >
                  <CanvasIcon name="plus" size={15} />
                  添加服务
                </button>
              )}
            </div>
            {error && (
              <p className="cw-model-feedback" role="alert">
                {error}
              </p>
            )}
            <div className="cw-model-service-list">
              {!services.length && (
                <div className="cw-model-empty-state">
                  <CanvasIcon name="connections" size={30} />
                  <strong>暂无服务配置</strong>
                  <p>支持服务商 API 和自部署的 vLLM / vLLM-Omni 服务。</p>
                  <button
                    className="cw-settings-button"
                    onClick={() => setEditing({ kind: category })}
                  >
                    添加服务
                  </button>
                </div>
              )}
              {services.map((model) => {
                const members = model.providerId
                  ? models.filter(
                      (item) => item.providerId === model.providerId,
                    )
                  : [model];
                return (
                  <article className="cw-model-service" key={model.id}>
                    <div className="cw-model-service-top">
                      <span className="cw-model-service-icon">
                        <CanvasIcon name="connections" size={20} />
                      </span>
                      <div className="cw-model-service-name">
                        <h4>{new URL(model.url).host}</h4>
                        <p title={model.url}>{model.url}</p>
                      </div>
                      <button
                        type="button"
                        className="cw-settings-button"
                        disabled={busy}
                        onClick={() => setEditing({ kind: category, model })}
                      >
                        管理
                      </button>
                    </div>
                    <div className="cw-model-service-models">
                      <span>{members.length} 个模型</span>
                      {members.slice(0, 3).map((item) => (
                        <span
                          className="cw-model-chip"
                          title={item.modelId}
                          key={item.id}
                        >
                          {item.modelId}
                        </span>
                      ))}
                      {members.length > 3 && <span>+{members.length - 3}</span>}
                    </div>
                    <div className="cw-model-service-bottom">
                      <span>
                        {model.protocol === "volcengine"
                          ? "火山引擎"
                          : model.protocol === "vllm_omni_segmentation"
                            ? "视觉分割"
                            : model.protocol === "vllm_omni"
                              ? "视频接口"
                              : "OpenAI 兼容"}{" "}
                        ·{" "}
                        {model.authMode === "none" ? "无需密钥" : "密钥已配置"}
                      </span>
                      <button
                        type="button"
                        className="cw-settings-button cw-settings-button-quiet"
                        disabled={busy}
                        onClick={() => setDeleting(model.id)}
                      >
                        移除服务
                      </button>
                    </div>
                    {deleting === model.id && (
                      <div className="cw-model-delete-confirm" role="alert">
                        <span>
                          移除此服务及 {members.length}{" "}
                          个模型配置？项目素材会保留。
                        </span>
                        <button
                          className="cw-settings-button cw-settings-button-quiet"
                          disabled={busy}
                          onClick={() => setDeleting(null)}
                        >
                          取消
                        </button>
                        <button
                          className="cw-settings-button"
                          disabled={busy}
                          onClick={() => void remove(model.id)}
                        >
                          {busy ? "移除中…" : "确认移除"}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        ))}
    </div>
  );
}
